import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { audit, type Db } from './db.ts';
import { HttpError } from './errors.ts';
import type { Scope } from './context.ts';
import type { MetricsStore } from './metrics.ts';
import { canSeeClient, scopeSql } from './scope.ts';
import { assessSecurity, diffInventory, diffSecurity, type Change, type SecuritySummary } from './security.ts';

/** Zdarzenia, które agent może dopisać do dziennika. */
const AGENT_AUDIT_ACTIONS = new Set(['kiosk.session_end']);

/** Najwięcej wpisów historii zmian na komputer (najstarsze usuwamy). */
const MAX_CHANGES = 2000;

/**
 * Protokół agent <-> serwer (JSON w ramkach tekstowych WebSocket), opis: docs/protocol.md
 *
 *  agent -> serwer (zdarzenia):   { type: "hello" | "metrics" | "inventory", data }
 *  serwer -> agent (żądanie):     { type: "<polecenie>", id, data }
 *  agent -> serwer (odpowiedź):   { type: "result", id, data } | { type: "error", id, error: { code, message } }
 */
export interface Envelope {
  type: string;
  id?: string;
  data?: unknown;
  error?: { code: string; message: string };
}

export const PROTOCOL_VERSION = 1;

interface AgentConn {
  socket: WebSocket;
  ip: string;
  connectedAt: number;
  alive: boolean;
  protocol: number;
  capabilities: string[];
  shells: string[];
  runAs: string;
}

/** Odbiorca strumienia (np. terminal w przeglądarce). */
export interface ChannelSink {
  onData(payload: Buffer): void;
  /** agent potwierdził zapis `bytes` bajtów (wysyłanie do agenta z kontrolą przepływu) */
  onAck?(bytes: number): void;
  onClose(info: { reason: 'exited' | 'agent_disconnected' | 'server_closing'; exitCode?: number; error?: string }): void;
}

interface ChannelEntry {
  agentId: string;
  channel: number;
  sink: ChannelSink;
}

const FRAME_DATA = 1;
const FRAME_ACK = 2;

/** Ramka binarna: [rodzaj u8][kanał u32 BE][dane] — ten sam format co w agent/channels.go. */
export function encodeFrame(kind: number, channel: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head[0] = kind;
  head.writeUInt32BE(channel, 1);
  return Buffer.concat([head, payload]);
}

interface Pending {
  agentId: string;
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface AgentSummary {
  id: string;
  hostname: string;
  label: string;
  os: string;
  platform: string;
  arch: string;
  agentVersion: string;
  lastIp: string | null;
  enrolledAt: number;
  lastSeen: number | null;
  online: boolean;
  connectedAt: number | null;
  capabilities: string[];
  shells: string[];
  /** konto, na którym działa agent (gdy online) */
  runAs: string;
  metrics: unknown;
  clientId: number | null;
  clientName: string | null;
  clientColor: string | null;
  siteId: number | null;
  siteName: string | null;
  tags: TagRef[];
  notes: string;
  /** ocena zabezpieczeń (null — agent jeszcze nie zgłosił / starsza wersja) */
  security: SecuritySummary | null;
  /** profil: zwykły komputer albo kiosk */
  kind: 'computer' | 'kiosk';
  /** kiosk: aplikacja „Zdjęcia z telefonu” */
  phoneApp: boolean;
  /** kiosk: przycisk „Zakończ i usuń moje dane” */
  endButton: boolean;
}

export interface TagRef {
  id: number;
  name: string;
  color: string;
}

export interface HubEvents {
  metrics: (agentId: string, data: Record<string, unknown>) => void;
  connected: (agentId: string) => void;
  /** agent przedstawił się (wersja i możliwości znane) */
  ready: (agentId: string) => void;
  /** nowy inwentarz (m.in. licencja Windows) */
  inventory: (agentId: string, inv: Record<string, any>) => void;
  /** nowa ocena zabezpieczeń (z inwentarzem albo osobno, co godzinę) */
  security: (agentId: string, sec: SecuritySummary) => void;
}

interface PanelState {
  alive: boolean;
  userId: number;
  scope: Scope;
}

export interface AgentRow {
  id: string;
  secret_hash: string;
  hostname: string;
  os: string;
  platform: string;
  arch: string;
  agent_version: string;
  label: string;
  inventory_json: string | null;
  metrics_json: string | null;
  last_ip: string | null;
  enrolled_at: number;
  last_seen: number | null;
  client_id: number | null;
  site_id: number | null;
  notes: string;
  security_json: string | null;
  kind: string;
  phone_app: number;
  end_button: number;
}

type SummaryRow = AgentRow & { client_name: string | null; client_color: string | null; site_name: string | null };

const SUMMARY_SQL = `SELECT a.*, c.name AS client_name, c.color AS client_color, s.name AS site_name
  FROM agents a LEFT JOIN clients c ON c.id = a.client_id LEFT JOIN sites s ON s.id = a.site_id`;

const PING_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export class Hub {
  private agents = new Map<string, AgentConn>();
  private panels = new Set<WebSocket>();
  private pending = new Map<string, Pending>();
  private panelState = new Map<WebSocket, PanelState>();
  private channels = new Map<string, ChannelEntry>();
  private nextChannel = 1;
  private db: Db;
  private metrics?: MetricsStore;
  private pingTimer: NodeJS.Timeout;
  private closed = false;
  /** Słuchacze zdarzeń agentów (silnik alertów, aktualizacje, zadania); błąd słuchacza nie przerywa obsługi agenta. */
  private listeners: { [K in keyof HubEvents]: HubEvents[K][] } = { metrics: [], connected: [], ready: [], inventory: [], security: [] };

  on<K extends keyof HubEvents>(name: K, fn: HubEvents[K]): void {
    this.listeners[name].push(fn);
  }

  private notify<K extends keyof HubEvents>(name: K, ...args: Parameters<HubEvents[K]>): void {
    for (const fn of this.listeners[name]) {
      try {
        (fn as (...a: unknown[]) => void)(...args);
      } catch (err) {
        console.error(`hub: słuchacz ${name}:`, err);
      }
    }
  }

  constructor(db: Db, metrics?: MetricsStore) {
    this.db = db;
    this.metrics = metrics;
    this.pingTimer = setInterval(() => this.pingAll(), PING_INTERVAL_MS);
    this.pingTimer.unref();
  }

  /** Zamyka huba przy wyłączaniu serwera — potem żadne zdarzenie gniazda nie dotyka już bazy. */
  close(): void {
    this.closed = true;
    clearInterval(this.pingTimer);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new HttpError(503, 'server_closing', 'Serwer jest wyłączany.'));
    }
    this.pending.clear();
    this.closeChannelsOf(null, 'server_closing');
    for (const conn of this.agents.values()) conn.socket.terminate();
    for (const p of this.panels) p.terminate();
    this.agents.clear();
    this.panels.clear();
    this.panelState.clear();
  }

  // ---------- agenci ----------

  attachAgent(agentId: string, socket: WebSocket, ip: string): void {
    if (this.closed) return void socket.terminate();
    this.agents.get(agentId)?.socket.close(4000, 'replaced by new connection');

    const conn: AgentConn = { socket, ip, connectedAt: Date.now(), alive: true, protocol: 0, capabilities: [], shells: [], runAs: '' };
    this.agents.set(agentId, conn);
    this.db.prepare('UPDATE agents SET last_seen = ?, last_ip = ? WHERE id = ?').run(Date.now(), ip, agentId);
    audit(this.db, `agent:${agentId}`, 'agent.connect', agentId, null, ip);

    socket.on('pong', () => (conn.alive = true));
    socket.on('message', (raw, isBinary) => {
      conn.alive = true;
      if (this.closed) return;
      if (isBinary) return this.handleAgentFrame(agentId, raw as Buffer);
      let msg: Envelope;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (typeof msg?.type === 'string') this.handleAgentMessage(agentId, conn, msg);
    });
    socket.on('close', () => {
      // zamknięcie starego połączenia po podmianie nie może wyrejestrować nowego
      if (this.closed || this.agents.get(agentId) !== conn) return;
      this.agents.delete(agentId);
      this.closeChannelsOf(agentId, 'agent_disconnected');
      this.rejectPendingFor(agentId, new HttpError(502, 'agent_disconnected', 'Komputer rozłączył się w trakcie operacji.'));
      this.db.prepare('UPDATE agents SET last_seen = ? WHERE id = ?').run(Date.now(), agentId);
      audit(this.db, `agent:${agentId}`, 'agent.disconnect', agentId, null, ip);
      this.broadcastAgent(agentId, { type: 'agent_offline', id: agentId });
    });

    this.broadcastAgent(agentId, { type: 'agent_online', id: agentId, data: this.summary(agentId) });
    this.notify('connected', agentId);
  }

  private handleAgentMessage(agentId: string, conn: AgentConn, msg: Envelope): void {
    const now = Date.now();
    switch (msg.type) {
      case 'hello': {
        const d = (msg.data ?? {}) as { version?: string; protocol?: number; capabilities?: unknown; shells?: unknown; runAs?: unknown; inventory?: Record<string, any> };
        const strings = (v: unknown) => (Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string').slice(0, 100) : []);
        conn.protocol = Number(d.protocol) || 0;
        conn.capabilities = strings(d.capabilities);
        conn.shells = strings(d.shells);
        conn.runAs = str(d.runAs);
        this.db.prepare('UPDATE agents SET agent_version = ?, last_seen = ? WHERE id = ?').run(str(d.version), now, agentId);
        if (d.inventory) this.storeInventory(agentId, d.inventory);
        this.broadcastAgent(agentId, { type: 'agent_updated', id: agentId, data: this.summary(agentId) });
        this.notify('ready', agentId);
        break;
      }
      case 'inventory': {
        this.storeInventory(agentId, (msg.data ?? {}) as Record<string, any>);
        this.broadcastAgent(agentId, { type: 'agent_updated', id: agentId, data: this.summary(agentId) });
        break;
      }
      case 'audit': {
        // zdarzenia agenta do dziennika — tylko znane rodzaje
        const d = (msg.data ?? {}) as { action?: string; details?: unknown };
        if (d.action && AGENT_AUDIT_ACTIONS.has(d.action)) audit(this.db, `agent:${agentId}`, d.action, agentId, d.details ?? null);
        break;
      }
      case 'security': {
        if (msg.data && typeof msg.data === 'object') this.storeSecurity(agentId, msg.data as Record<string, any>);
        this.broadcastAgent(agentId, { type: 'agent_updated', id: agentId, data: this.summary(agentId) });
        break;
      }
      case 'metrics': {
        this.db.prepare('UPDATE agents SET metrics_json = ?, last_seen = ? WHERE id = ?').run(JSON.stringify(msg.data ?? {}), now, agentId);
        this.metrics?.record(agentId, (msg.data ?? null) as Record<string, unknown> | null);
        this.broadcastAgent(agentId, { type: 'agent_metrics', id: agentId, data: msg.data });
        if (msg.data && typeof msg.data === 'object') this.notify('metrics', agentId, msg.data as Record<string, unknown>);
        break;
      }
      case 'channel.closed': {
        const d = (msg.data ?? {}) as { channel?: number; exitCode?: number; error?: string };
        const key = `${agentId}:${d.channel}`;
        const entry = this.channels.get(key);
        if (entry) {
          this.channels.delete(key);
          entry.sink.onClose({
            reason: 'exited',
            exitCode: typeof d.exitCode === 'number' ? d.exitCode : undefined,
            error: typeof d.error === 'string' ? d.error.slice(0, 500) : undefined,
          });
        }
        break;
      }
      case 'result':
      case 'error': {
        const p = msg.id ? this.pending.get(msg.id) : undefined;
        // odpowiedź musi przyjść od tego samego agenta, do którego wysłano żądanie
        if (!p || p.agentId !== agentId) return;
        this.pending.delete(msg.id!);
        clearTimeout(p.timer);
        if (msg.type === 'result') p.resolve(msg.data);
        else p.reject(new HttpError(422, msg.error?.code ?? 'agent_error', msg.error?.message ?? 'Agent zgłosił błąd.'));
        break;
      }
      default:
        // nieznane typy ignorujemy — starszy serwer musi tolerować nowszych agentów
        break;
    }
  }

  storeInventory(agentId: string, inv: Record<string, any>): void {
    const host = inv.host ?? {};
    const prev = this.previous(agentId);
    const os = str(host.os) || prev.os;
    // starszy agent nie zbiera zabezpieczeń — zostaje poprzednia ocena
    const sec = inv.security ? assessSecurity(inv.security, os) : prev.security;
    this.db
      .prepare('UPDATE agents SET hostname = ?, os = ?, platform = ?, arch = ?, inventory_json = ?, security_json = ?, last_seen = ? WHERE id = ?')
      .run(
        str(host.hostname, 'unknown'),
        str(host.os),
        [host.platform, host.platformVersion].filter(Boolean).join(' '),
        str(host.arch),
        JSON.stringify(inv),
        sec ? JSON.stringify(sec) : null,
        Date.now(),
        agentId,
      );
    this.recordChanges(agentId, [...diffInventory(prev.inventory, inv), ...diffSecurity(prev.security, sec)]);
    this.notify('inventory', agentId, inv);
    if (sec && inv.security) this.notify('security', agentId, sec);
  }

  /** Stan zabezpieczeń między inwentarzami (agent wysyła co godzinę). */
  storeSecurity(agentId: string, raw: Record<string, any>): void {
    const prev = this.previous(agentId);
    const sec = assessSecurity(raw, prev.os);
    if (!sec) return;
    const inv = prev.inventory ?? {};
    inv.security = raw;
    this.db.prepare('UPDATE agents SET inventory_json = ?, security_json = ? WHERE id = ?').run(JSON.stringify(inv), JSON.stringify(sec), agentId);
    this.recordChanges(agentId, diffSecurity(prev.security, sec));
    this.notify('security', agentId, sec);
  }

  private previous(agentId: string): { inventory: Record<string, any> | null; security: SecuritySummary | null; os: string } {
    const row = this.db.prepare('SELECT inventory_json, security_json, os FROM agents WHERE id = ?').get(agentId) as
      | { inventory_json: string | null; security_json: string | null; os: string }
      | undefined;
    const parse = (s: string | null | undefined) => {
      try {
        return s ? JSON.parse(s) : null;
      } catch {
        return null;
      }
    };
    return { inventory: parse(row?.inventory_json), security: parse(row?.security_json), os: row?.os ?? '' };
  }

  private recordChanges(agentId: string, changes: Change[], now = Date.now()): void {
    if (changes.length === 0) return;
    const ins = this.db.prepare('INSERT INTO agent_changes (agent_id, ts, kind, title, detail) VALUES (?, ?, ?, ?, ?)');
    for (const c of changes) ins.run(agentId, now, c.kind, c.title.slice(0, 300), c.detail?.slice(0, 1000) ?? null);
    this.db
      .prepare('DELETE FROM agent_changes WHERE agent_id = ? AND id NOT IN (SELECT id FROM agent_changes WHERE agent_id = ? ORDER BY ts DESC, id DESC LIMIT ?)')
      .run(agentId, agentId, MAX_CHANGES);
  }

  /**
   * Wysyła polecenie do agenta i czeka na odpowiedź.
   * Rzuca HttpError: 409 agent_offline, 501 unsupported, 504 agent_timeout, 422 (błąd zgłoszony przez agenta).
   */
  request<T = unknown>(agentId: string, type: string, data?: unknown, opts: { timeoutMs?: number; capability?: string } = {}): Promise<T> {
    const conn = this.agents.get(agentId);
    if (!conn) return Promise.reject(new HttpError(409, 'agent_offline', 'Komputer jest offline.'));
    if (opts.capability && !conn.capabilities.includes(opts.capability)) {
      return Promise.reject(new HttpError(501, 'unsupported', 'Ta wersja agenta nie obsługuje tej funkcji — zaktualizuj agenta.'));
    }
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HttpError(504, 'agent_timeout', 'Komputer nie odpowiedział na czas.'));
      }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      this.pending.set(id, { agentId, resolve: resolve as (d: unknown) => void, reject, timer });
      conn.socket.send(JSON.stringify({ type, id, data } satisfies Envelope));
    });
  }

  // ---------- kanały strumieniowe (terminal; później pulpit i pliki) ----------

  /**
   * Otwiera kanał na agencie. Odbiorca jest rejestrowany PRZED wysłaniem żądania,
   * bo agent może zacząć nadawać dane, zanim dotrze jego odpowiedź.
   */
  async openChannel<T = unknown>(agentId: string, type: string, params: Record<string, unknown>, sink: ChannelSink): Promise<{ channel: number; result: T }> {
    const channel = this.nextChannel;
    this.nextChannel = this.nextChannel >= 0xfffffff0 ? 1 : this.nextChannel + 1;
    const key = `${agentId}:${channel}`;
    this.channels.set(key, { agentId, channel, sink });
    try {
      const result = await this.request<T>(agentId, type, { ...params, channel }, { capability: type, timeoutMs: 20_000 });
      return { channel, result };
    } catch (err) {
      this.channels.delete(key);
      throw err;
    }
  }

  sendChannelData(agentId: string, channel: number, payload: Buffer): boolean {
    const conn = this.agents.get(agentId);
    if (!conn || !this.channels.has(`${agentId}:${channel}`)) return false;
    conn.socket.send(encodeFrame(FRAME_DATA, channel, payload), { binary: true });
    return true;
  }

  /** Potwierdzenie dla agenta, że odbiorca (przeglądarka) przyjął `bytes` bajtów — agent może nadawać dalej. */
  sendAck(agentId: string, channel: number, bytes: number): void {
    const conn = this.agents.get(agentId);
    if (!conn || !this.channels.has(`${agentId}:${channel}`)) return;
    const n = Buffer.alloc(4);
    n.writeUInt32BE(bytes);
    conn.socket.send(encodeFrame(FRAME_ACK, channel, n), { binary: true });
  }

  /** Zamknięcie z inicjatywy serwera/panelu — agent kończy proces po swojej stronie. */
  closeChannel(agentId: string, channel: number): void {
    if (!this.channels.delete(`${agentId}:${channel}`)) return;
    this.request(agentId, 'channel.close', { channel }, { timeoutMs: 10_000 }).catch(() => {});
  }

  private handleAgentFrame(agentId: string, raw: Buffer): void {
    if (raw.length < 5) return;
    // klucz zawiera agentId — agent nie może pisać do cudzego kanału
    const entry = this.channels.get(`${agentId}:${raw.readUInt32BE(1)}`);
    if (!entry) return;
    if (raw[0] === FRAME_DATA) entry.sink.onData(raw.subarray(5));
    else if (raw[0] === FRAME_ACK && raw.length === 9) entry.sink.onAck?.(raw.readUInt32BE(5));
  }

  private closeChannelsOf(agentId: string | null, reason: 'agent_disconnected' | 'server_closing'): void {
    for (const [key, entry] of this.channels) {
      if (agentId !== null && entry.agentId !== agentId) continue;
      this.channels.delete(key);
      entry.sink.onClose({ reason });
    }
  }

  openChannelCount(agentId?: string): number {
    let n = 0;
    for (const e of this.channels.values()) if (!agentId || e.agentId === agentId) n++;
    return n;
  }

  private rejectPendingFor(agentId: string, err: Error): void {
    for (const [id, p] of this.pending) {
      if (p.agentId !== agentId) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(err);
    }
  }

  disconnectAgent(agentId: string, reason: string): void {
    this.agents.get(agentId)?.socket.close(4001, reason);
  }

  isOnline(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  // ---------- panele (przeglądarki zespołu) ----------

  attachPanel(socket: WebSocket, userId: number, scope: Scope): void {
    if (this.closed) return void socket.terminate();
    const state: PanelState = { alive: true, userId, scope };
    this.panels.add(socket);
    this.panelState.set(socket, state);
    socket.on('pong', () => (state.alive = true));
    socket.on('close', () => {
      this.panels.delete(socket);
      this.panelState.delete(socket);
    });
  }

  /** Zdarzenie bez danych wrażliwych do wszystkich paneli (np. zmiana listy klientów/tagów — panel sam pobierze to, co widzi). */
  broadcastAll(msg: Envelope): void {
    const payload = JSON.stringify(msg);
    for (const socket of this.panelState.keys()) if (socket.readyState === socket.OPEN) socket.send(payload);
  }

  /** Rozłącza panele konta (np. po zmianie roli/zakresu lub blokadzie) — panel połączy się ponownie z nowym zakresem. */
  disconnectPanelsOf(userId: number): void {
    for (const [socket, st] of this.panelState) if (st.userId === userId) socket.close(4003, 'session changed');
  }

  /**
   * Zdarzenie dotyczące komputera trafia tylko do paneli, które go widzą.
   * Po zmianie klienta (agent_updated) panele, które utraciły widoczność, dostają agent_removed.
   */
  broadcastAgent(agentId: string, msg: Envelope): void {
    const row = this.db.prepare('SELECT client_id FROM agents WHERE id = ?').get(agentId) as { client_id: number | null } | undefined;
    const payload = JSON.stringify(msg);
    let removal: string | null = null;
    for (const [socket, st] of this.panelState) {
      if (socket.readyState !== socket.OPEN) continue;
      if (!row || canSeeClient(st.scope, row.client_id)) socket.send(payload);
      else if (msg.type === 'agent_updated') socket.send((removal ??= JSON.stringify({ type: 'agent_removed', id: agentId })));
    }
  }

  // ---------- odczyt ----------

  summary(agentId: string): AgentSummary | null {
    const row = this.db.prepare(`${SUMMARY_SQL} WHERE a.id = ?`).get(agentId) as SummaryRow | undefined;
    if (!row) return null;
    const tags = this.db
      .prepare('SELECT t.id, t.name, t.color FROM agent_tags x JOIN tags t ON t.id = x.tag_id WHERE x.agent_id = ? ORDER BY t.name')
      .all(agentId) as unknown as TagRef[];
    return this.toSummary(row, tags);
  }

  listSummaries(scope: Scope): AgentSummary[] {
    const where = scopeSql(scope, 'a.client_id');
    const rows = this.db.prepare(`${SUMMARY_SQL} WHERE ${where.sql} ORDER BY a.hostname COLLATE NOCASE`).all(...where.params) as unknown as SummaryRow[];
    const tagRows = this.db
      .prepare('SELECT x.agent_id, t.id, t.name, t.color FROM agent_tags x JOIN tags t ON t.id = x.tag_id ORDER BY t.name')
      .all() as unknown as (TagRef & { agent_id: string })[];
    const byAgent = new Map<string, TagRef[]>();
    for (const t of tagRows) {
      const list = byAgent.get(t.agent_id) ?? [];
      list.push({ id: t.id, name: t.name, color: t.color });
      byAgent.set(t.agent_id, list);
    }
    return rows.map((r) => this.toSummary(r, byAgent.get(r.id) ?? []));
  }

  private toSummary(r: SummaryRow, tags: TagRef[]): AgentSummary {
    const conn = this.agents.get(r.id);
    return {
      id: r.id,
      hostname: r.hostname,
      label: r.label,
      os: r.os,
      platform: r.platform,
      arch: r.arch,
      agentVersion: r.agent_version,
      lastIp: r.last_ip,
      enrolledAt: r.enrolled_at,
      lastSeen: r.last_seen,
      online: !!conn,
      connectedAt: conn?.connectedAt ?? null,
      capabilities: conn?.capabilities ?? [],
      shells: conn?.shells ?? [],
      runAs: conn?.runAs ?? '',
      metrics: r.metrics_json ? JSON.parse(r.metrics_json) : null,
      clientId: r.client_id,
      clientName: r.client_name,
      clientColor: r.client_color,
      siteId: r.site_id,
      siteName: r.site_name,
      tags,
      notes: r.notes,
      security: r.security_json ? JSON.parse(r.security_json) : null,
      kind: r.kind === 'kiosk' ? 'kiosk' : 'computer',
      phoneApp: !!r.phone_app,
      endButton: !!r.end_button,
    };
  }

  private pingAll(): void {
    for (const conn of this.agents.values()) {
      if (!conn.alive) {
        conn.socket.terminate();
        continue;
      }
      conn.alive = false;
      conn.socket.ping();
    }
    for (const [p, st] of this.panelState) {
      if (!st.alive) {
        p.terminate();
        continue;
      }
      st.alive = false;
      p.ping();
    }
  }
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v.slice(0, 255) : fallback;
}
