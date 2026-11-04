import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { buildApp } from '../app.ts';
import { loadConfig, type Config } from '../config.ts';
import { openDb } from '../db.ts';
import { ensureAdmin, SESSION_COOKIE } from '../auth.ts';

export const ADMIN = { username: 'admin', password: 'test-password-123' };

/** Świeża aplikacja z bazą w pamięci i kontem administratora. */
export async function setup(overrides: Partial<Config> = {}) {
  const db = openDb(':memory:');
  const config: Config = { ...loadConfig({}), dbFile: ':memory:', panelDir: null, logLevel: 'silent', keyFile: null, requireMfa: false, ...overrides };
  await ensureAdmin(db, { ADMIN_USER: ADMIN.username, ADMIN_PASSWORD: ADMIN.password });
  const { app, ctx } = await buildApp(config, db);
  await app.ready();

  /** Loguje się i zwraca ciasteczka do kolejnych żądań. */
  const login = async (): Promise<Record<string, string>> => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: ADMIN });
    if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
    const sid = res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
    return { [SESSION_COOKIE]: sid };
  };

  /** Tworzy token i rejestruje agenta; zwraca jego dane uwierzytelniające. */
  const enroll = async (cookies: Record<string, string>, hostname = 'test-pc') => {
    const t = await app.inject({ method: 'POST', url: '/api/enroll-tokens', cookies, payload: { label: 'test', maxUses: 1 } });
    const { token } = t.json();
    const res = await app.inject({ method: 'POST', url: '/api/agent/enroll', payload: { token, hostname, os: 'linux', arch: 'amd64' } });
    if (res.statusCode !== 200) throw new Error(`enroll failed: ${res.body}`);
    return res.json() as { agentId: string; agentSecret: string };
  };

  /** Loguje dowolne konto (bez 2FA); zwraca ciasteczka i odpowiedź. */
  const loginAs = async (username: string, password: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
    const sid = res.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
    const cookies: Record<string, string> = sid ? { [SESSION_COOKIE]: sid } : {};
    return { res, cookies };
  };

  /**
   * Właściciel tworzy konto; nowy użytkownik loguje się hasłem tymczasowym i ustawia własne.
   * Zwraca gotowe do użycia ciasteczka nowego konta.
   */
  const createMember = async (
    ownerCookies: Record<string, string>,
    opts: { username: string; role: 'owner' | 'admin' | 'tech' | 'viewer'; allClients?: boolean; clientIds?: number[] },
  ) => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      cookies: ownerCookies,
      payload: { username: opts.username, role: opts.role, allClients: opts.allClients ?? true, clientIds: opts.clientIds ?? [] },
    });
    if (created.statusCode !== 200) throw new Error(`create user failed: ${created.body}`);
    const { temporaryPassword, user } = created.json();
    const { cookies } = await loginAs(opts.username, temporaryPassword);
    const password = `${opts.username}-new-password`;
    const ch = await app.inject({ method: 'POST', url: '/api/auth/password', cookies, payload: { currentPassword: temporaryPassword, newPassword: password } });
    if (ch.statusCode !== 200) throw new Error(`password change failed: ${ch.body}`);
    return { cookies, password, id: user.id as number };
  };

  /** Tworzy klienta (z opcjonalną lokalizacją); zwraca id. */
  const createClient = async (cookies: Record<string, string>, name: string, site?: string) => {
    const c = await app.inject({ method: 'POST', url: '/api/clients', cookies, payload: { name } });
    if (c.statusCode !== 200) throw new Error(`create client failed: ${c.body}`);
    const clientId = c.json().id as number;
    let siteId: number | null = null;
    if (site) siteId = (await app.inject({ method: 'POST', url: `/api/clients/${clientId}/sites`, cookies, payload: { name: site } })).json().id;
    return { clientId, siteId };
  };

  /** Uruchamia serwer na losowym porcie (potrzebne do testów WebSocket). */
  const listen = async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    return (app.server.address() as AddressInfo).port;
  };

  const close = async () => {
    await app.close();
    db.close();
  };

  return { app, ctx, db, login, loginAs, createMember, createClient, enroll, listen, close };
}

/** Prosty fałszywy agent mówiący protokołem OVERVNC. */
export class FakeAgent {
  ws: WebSocket;
  received: any[] = [];
  private waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  handlers: Record<string, (data: any) => any> = {};

  constructor(port: number, agentId: string, secret: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`, { headers: { Authorization: `Bearer ${agentId}.${secret}` } });
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      this.received.push(msg);
      const h = msg.id ? this.handlers[msg.type] : undefined;
      if (h) {
        try {
          this.send({ type: 'result', id: msg.id, data: h(msg.data) });
        } catch (e) {
          this.send({ type: 'error', id: msg.id, error: { code: 'failed', message: (e as Error).message } });
        }
      }
      this.waiters = this.waiters.filter((w) => (w.pred(msg) ? (w.resolve(msg), false) : true));
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      this.ws.once('error', reject);
    });
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  hello(capabilities: string[] = []): void {
    this.send({ type: 'hello', data: { version: 'test', protocol: 1, capabilities, inventory: { host: { hostname: 'fake', os: 'linux', platform: 'ubuntu', platformVersion: '24.04', arch: 'x86_64' } } } });
  }

  waitFor(pred: (m: any) => boolean, timeoutMs = 2000): Promise<any> {
    const found = this.received.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);
      this.waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
    });
  }

  closed(): Promise<{ code: number; reason: string }> {
    return new Promise((resolve) => this.ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  }

  close(): void {
    this.ws.close();
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Czeka, aż warunek będzie spełniony (np. serwer przetworzy wiadomość). */
export async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error('until: timeout');
    await sleep(10);
  }
}
