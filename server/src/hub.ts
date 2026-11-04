import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { audit, type Db } from './db.ts';
import { HttpError } from './errors.ts';

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
  metrics: unknown;
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
}

const PING_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export class Hub {
  private agents = new Map<string, AgentConn>();
  private panels = new Set<WebSocket>();
  private pending = new Map<string, Pending>();
  private panelState = new WeakMap<WebSocket, { alive: boolean }>();
  private db: Db;
  private pingTimer: NodeJS.Timeout;
  private closed = false;

  constructor(db: Db) {
    this.db = db;
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
    for (const conn of this.agents.values()) conn.socket.terminate();
    for (const p of this.panels) p.terminate();
    this.agents.clear();
    this.panels.clear();
  }

  // ---------- agenci ----------

  attachAgent(agentId: string, socket: WebSocket, ip: string): void {
    if (this.closed) return void socket.terminate();
    this.agents.get(agentId)?.socket.close(4000, 'replaced by new connection');

    const conn: AgentConn = { socket, ip, connectedAt: Date.now(), alive: true, protocol: 0, capabilities: [] };
    this.agents.set(agentId, conn);
    this.db.prepare('UPDATE agents SET last_seen = ?, last_ip = ? WHERE id = ?').run(Date.now(), ip, agentId);
    audit(this.db, `agent:${agentId}`, 'agent.connect', agentId, null, ip);

    socket.on('pong', () => (conn.alive = true));
    socket.on('message', (raw, isBinary) => {
      conn.alive = true;
      if (isBinary || this.closed) return; // ramki binarne zarezerwowane na strumienie (pulpit, pliki)
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
      this.rejectPendingFor(agentId, new HttpError(502, 'agent_disconnected', 'Komputer rozłączył się w trakcie operacji.'));
      this.db.prepare('UPDATE agents SET last_seen = ? WHERE id = ?').run(Date.now(), agentId);
      audit(this.db, `agent:${agentId}`, 'agent.disconnect', agentId, null, ip);
      this.broadcast({ type: 'agent_offline', id: agentId });
    });

    this.broadcast({ type: 'agent_online', id: agentId, data: this.summary(agentId) });
  }

  private handleAgentMessage(agentId: string, conn: AgentConn, msg: Envelope): void {
    const now = Date.now();
    switch (msg.type) {
      case 'hello': {
        const d = (msg.data ?? {}) as { version?: string; protocol?: number; capabilities?: unknown; inventory?: Record<string, any> };
        conn.protocol = Number(d.protocol) || 0;
        conn.capabilities = Array.isArray(d.capabilities) ? d.capabilities.filter((c): c is string => typeof c === 'string') : [];
        this.db.prepare('UPDATE agents SET agent_version = ?, last_seen = ? WHERE id = ?').run(str(d.version), now, agentId);
        if (d.inventory) this.storeInventory(agentId, d.inventory);
        this.broadcast({ type: 'agent_updated', id: agentId, data: this.summary(agentId) });
        break;
      }
      case 'inventory': {
        this.storeInventory(agentId, (msg.data ?? {}) as Record<string, any>);
        this.broadcast({ type: 'agent_updated', id: agentId, data: this.summary(agentId) });
        break;
      }
      case 'metrics': {
        this.db.prepare('UPDATE agents SET metrics_json = ?, last_seen = ? WHERE id = ?').run(JSON.stringify(msg.data ?? {}), now, agentId);
        this.broadcast({ type: 'agent_metrics', id: agentId, data: msg.data });
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
    this.db
      .prepare('UPDATE agents SET hostname = ?, os = ?, platform = ?, arch = ?, inventory_json = ?, last_seen = ? WHERE id = ?')
      .run(
        str(host.hostname, 'unknown'),
        str(host.os),
        [host.platform, host.platformVersion].filter(Boolean).join(' '),
        str(host.arch),
        JSON.stringify(inv),
        Date.now(),
        agentId,
      );
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

  // ---------- panele (przeglądarki administratorów) ----------

  attachPanel(socket: WebSocket): void {
    const state = { alive: true };
    this.panels.add(socket);
    this.panelState.set(socket, state);
    socket.on('pong', () => (state.alive = true));
    socket.on('close', () => this.panels.delete(socket));
  }

  broadcast(msg: Envelope): void {
    const payload = JSON.stringify(msg);
    for (const p of this.panels) if (p.readyState === p.OPEN) p.send(payload);
  }

  // ---------- odczyt ----------

  summary(agentId: string): AgentSummary | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as AgentRow | undefined;
    return row ? this.rowToSummary(row) : null;
  }

  listSummaries(): AgentSummary[] {
    const rows = this.db.prepare('SELECT * FROM agents ORDER BY hostname COLLATE NOCASE').all() as unknown as AgentRow[];
    return rows.map((r) => this.rowToSummary(r));
  }

  rowToSummary(r: AgentRow): AgentSummary {
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
      metrics: r.metrics_json ? JSON.parse(r.metrics_json) : null,
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
    for (const p of this.panels) {
      const st = this.panelState.get(p);
      if (st && !st.alive) {
        p.terminate();
        continue;
      }
      if (st) st.alive = false;
      p.ping();
    }
  }
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v.slice(0, 255) : fallback;
}
