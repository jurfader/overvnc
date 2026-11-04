import type { WebSocket } from 'ws';
import { audit, type Db } from './db.ts';

/** Wiadomość w obie strony: agent <-> serwer <-> panel. */
export interface Envelope {
  type: string;
  id?: string;
  data?: unknown;
}

interface AgentConn {
  socket: WebSocket;
  ip: string;
  connectedAt: number;
  alive: boolean;
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
  metrics: unknown;
}

const PING_INTERVAL_MS = 30_000;

export class Hub {
  private agents = new Map<string, AgentConn>();
  private panels = new Set<WebSocket>();
  private db: Db;

  constructor(db: Db) {
    this.db = db;
    setInterval(() => this.pingAll(), PING_INTERVAL_MS).unref();
  }

  // ---------- agenci ----------

  attachAgent(agentId: string, socket: WebSocket, ip: string): void {
    const existing = this.agents.get(agentId);
    if (existing) existing.socket.close(4000, 'replaced by new connection');

    const conn: AgentConn = { socket, ip, connectedAt: Date.now(), alive: true };
    this.agents.set(agentId, conn);
    this.db.prepare('UPDATE agents SET last_seen = ?, last_ip = ? WHERE id = ?').run(Date.now(), ip, agentId);
    audit(this.db, `agent:${agentId}`, 'agent.connect', agentId, null, ip);

    socket.on('pong', () => (conn.alive = true));
    socket.on('message', (raw, isBinary) => {
      conn.alive = true;
      if (isBinary) return; // binarne ramki zarezerwowane na pulpit zdalny (etap 4)
      let msg: Envelope;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.handleAgentMessage(agentId, msg);
    });
    socket.on('close', () => {
      // zamknięcie starego połączenia po podmianie nie może wyrejestrować nowego
      if (this.agents.get(agentId) !== conn) return;
      this.agents.delete(agentId);
      this.db.prepare('UPDATE agents SET last_seen = ? WHERE id = ?').run(Date.now(), agentId);
      audit(this.db, `agent:${agentId}`, 'agent.disconnect', agentId, null, ip);
      this.broadcast({ type: 'agent_offline', id: agentId });
    });

    this.broadcast({ type: 'agent_online', id: agentId, data: this.summary(agentId) });
  }

  private handleAgentMessage(agentId: string, msg: Envelope): void {
    const now = Date.now();
    switch (msg.type) {
      case 'hello': {
        const d = (msg.data ?? {}) as { version?: string; inventory?: Record<string, any> };
        const inv = d.inventory ?? {};
        const host = inv.host ?? {};
        this.db
          .prepare(
            `UPDATE agents SET hostname = ?, os = ?, platform = ?, arch = ?, agent_version = ?,
             inventory_json = ?, last_seen = ? WHERE id = ?`,
          )
          .run(
            str(host.hostname, 'unknown'),
            str(host.os),
            [host.platform, host.platformVersion].filter(Boolean).join(' '),
            str(host.arch),
            str(d.version),
            JSON.stringify(inv),
            now,
            agentId,
          );
        this.broadcast({ type: 'agent_updated', id: agentId, data: this.summary(agentId) });
        break;
      }
      case 'inventory': {
        this.db.prepare('UPDATE agents SET inventory_json = ?, last_seen = ? WHERE id = ?').run(JSON.stringify(msg.data ?? {}), now, agentId);
        this.broadcast({ type: 'agent_updated', id: agentId, data: this.summary(agentId) });
        break;
      }
      case 'metrics': {
        this.db.prepare('UPDATE agents SET metrics_json = ?, last_seen = ? WHERE id = ?').run(JSON.stringify(msg.data ?? {}), now, agentId);
        this.broadcast({ type: 'agent_metrics', id: agentId, data: msg.data });
        break;
      }
      default:
        // nieznane typy ignorujemy — starszy serwer musi tolerować nowszych agentów
        break;
    }
  }

  sendToAgent(agentId: string, msg: Envelope): boolean {
    const conn = this.agents.get(agentId);
    if (!conn) return false;
    conn.socket.send(JSON.stringify(msg));
    return true;
  }

  disconnectAgent(agentId: string, reason: string): void {
    this.agents.get(agentId)?.socket.close(4001, reason);
  }

  isOnline(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  // ---------- panele (przeglądarki administratorów) ----------

  attachPanel(socket: WebSocket): void {
    this.panels.add(socket);
    (socket as any).alive = true;
    socket.on('pong', () => ((socket as any).alive = true));
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
      if (!(p as any).alive) {
        p.terminate();
        continue;
      }
      (p as any).alive = false;
      p.ping();
    }
  }
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

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v.slice(0, 255) : fallback;
}
