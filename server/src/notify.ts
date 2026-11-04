import type { Db } from './db.ts';
import { decryptSecret, encryptSecret } from './crypto.ts';
import { getSetting, setSetting } from './settings.ts';

/** Jedno powiadomienie push. priority: -1 ciche, 0 zwykłe, 1 wysokie (omija godziny ciszy). */
export interface PushMessage {
  title: string;
  message: string;
  priority?: -1 | 0 | 1;
  url?: string;
  urlTitle?: string;
}

export interface PushoverConfig {
  token: string;
  user: string;
}

/** Transport wysyłki — w testach podmieniany, żeby nie wysyłać prawdziwych powiadomień. */
export type PushTransport = (cfg: PushoverConfig, msg: PushMessage) => Promise<void>;

const PUSHOVER_URL = 'https://api.pushover.net/1/messages.json';
const KEY_PUSHOVER = 'notify.pushover';
const KEY_PANEL_URL = 'panel.url';
// powiadomienia z krótkiego okna łączymy w jedno (np. awaria łącza w biurze = wiele komputerów offline naraz)
const BATCH_WINDOW_MS = 4000;
const BATCH_MAX_LINES = 10;

export const pushoverTransport: PushTransport = async (cfg, msg) => {
  const body = new URLSearchParams({ token: cfg.token, user: cfg.user, title: msg.title.slice(0, 250), message: msg.message.slice(0, 1024) });
  if (msg.priority !== undefined) body.set('priority', String(msg.priority));
  if (msg.url) body.set('url', msg.url);
  if (msg.urlTitle) body.set('url_title', msg.urlTitle.slice(0, 100));
  const res = await fetch(PUSHOVER_URL, { method: 'POST', body, signal: AbortSignal.timeout(15_000) });
  const data = (await res.json().catch(() => ({}))) as { status?: number; errors?: string[] };
  if (!res.ok || data.status !== 1) {
    throw new Error(data.errors?.join('; ') || `Pushover odpowiedział kodem ${res.status}`);
  }
};

export class Notifier {
  private db: Db;
  private key: Buffer;
  private log: (msg: string) => void;
  private queue: PushMessage[] = [];
  private timer: NodeJS.Timeout | null = null;
  transport: PushTransport = pushoverTransport;

  constructor(db: Db, key: Buffer, log: (msg: string) => void = () => {}) {
    this.db = db;
    this.key = key;
    this.log = log;
  }

  /** Konfiguracja Pushover (odszyfrowana) albo null, gdy nie ustawiono. */
  pushover(): PushoverConfig | null {
    const raw = getSetting(this.db, KEY_PUSHOVER);
    if (!raw) return null;
    try {
      return JSON.parse(decryptSecret(this.key, raw)) as PushoverConfig;
    } catch {
      return null; // np. zmieniony plik klucza — trzeba wpisać dane ponownie
    }
  }

  setPushover(cfg: PushoverConfig | null): void {
    if (!cfg) this.db.prepare('DELETE FROM settings WHERE key = ?').run(KEY_PUSHOVER);
    else setSetting(this.db, KEY_PUSHOVER, encryptSecret(this.key, JSON.stringify(cfg)));
  }

  /** Adres panelu do linków w powiadomieniach (zapisywany z żądania administratora). */
  panelUrl(): string | null {
    return getSetting(this.db, KEY_PANEL_URL);
  }

  setPanelUrl(url: string): void {
    if (url !== this.panelUrl()) setSetting(this.db, KEY_PANEL_URL, url);
  }

  /** Link do komputera w panelu (albo undefined, gdy adres panelu nieznany). */
  machineUrl(agentId: string): string | undefined {
    const base = this.panelUrl();
    return base ? `${base}/#/m/${agentId}` : undefined;
  }

  /** Wysyłka natychmiastowa (np. test z panelu) — błąd Pushovera trafia do wywołującego. */
  async sendNow(msg: PushMessage): Promise<void> {
    const cfg = this.pushover();
    if (!cfg) throw new Error('Pushover nie jest skonfigurowany.');
    await this.transport(cfg, msg);
  }

  /** Kolejkuje powiadomienie; wiadomości z krótkiego okna są łączone w jedną. */
  enqueue(msg: PushMessage): void {
    if (!this.pushover()) return;
    this.queue.push(msg);
    this.timer ??= setTimeout(() => void this.flush(), BATCH_WINDOW_MS);
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const batch = this.queue.splice(0);
    const cfg = this.pushover();
    if (!cfg || batch.length === 0) return;
    let msg: PushMessage;
    if (batch.length === 1) msg = batch[0];
    else {
      const lines = batch.slice(0, BATCH_MAX_LINES).map((m) => `• ${m.title}`);
      if (batch.length > BATCH_MAX_LINES) lines.push(`…i ${batch.length - BATCH_MAX_LINES} więcej`);
      msg = {
        title: `OVERVNC: ${batch.length} powiadomień`,
        message: lines.join('\n'),
        priority: Math.max(...batch.map((m) => m.priority ?? 0)) as PushMessage['priority'],
        url: this.panelUrl() ? `${this.panelUrl()}/#/alerts` : undefined,
        urlTitle: 'Otwórz alerty',
      };
    }
    try {
      await this.transport(cfg, msg);
    } catch (err) {
      this.log(`powiadomienie Pushover nie wysłane: ${(err as Error).message}`);
    }
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
  }
}
