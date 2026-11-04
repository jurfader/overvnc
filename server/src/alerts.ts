import type { Db } from './db.ts';
import type { Hub } from './hub.ts';
import type { Notifier } from './notify.ts';

export const ALERT_KINDS = ['offline', 'cpu', 'mem', 'disk'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export interface AlertRule {
  id: number;
  name: string;
  kind: AlertKind;
  threshold: number;
  durationMin: number;
  clientId: number | null;
  enabled: boolean;
  notify: boolean;
}

/** Alert w postaci dla panelu. */
export interface AlertView {
  id: number;
  ruleId: number | null;
  agentId: string;
  hostname: string;
  label: string;
  clientId: number | null;
  clientName: string | null;
  kind: AlertKind;
  title: string;
  detail: string;
  value: number | null;
  startedAt: number;
  resolvedAt: number | null;
  ackBy: string | null;
  ackAt: number | null;
}

// alert metryki zamykamy dopiero, gdy wartość spadnie wyraźnie poniżej progu — bez „migania” na granicy
const HYSTERESIS = 3;
const OFFLINE_TICK_MS = 60_000;

export const ALERT_VIEW_SQL = `SELECT x.id, x.rule_id AS ruleId, x.agent_id AS agentId, a.hostname, a.label, a.client_id AS clientId, c.name AS clientName,
  x.kind, x.title, x.detail, x.value, x.started_at AS startedAt, x.resolved_at AS resolvedAt, x.ack_by AS ackBy, x.ack_at AS ackAt
  FROM alerts x JOIN agents a ON a.id = x.agent_id LEFT JOIN clients c ON c.id = a.client_id`;

interface AgentInfo {
  id: string;
  hostname: string;
  label: string;
  client_id: number | null;
  client_name: string | null;
  last_seen: number | null;
}

const pct = (v: number) => `${Math.round(v)}%`;

export function ruleFromRow(r: Record<string, unknown>): AlertRule {
  return {
    id: Number(r.id),
    name: String(r.name),
    kind: r.kind as AlertKind,
    threshold: Number(r.threshold),
    durationMin: Number(r.duration_min),
    clientId: r.client_id == null ? null : Number(r.client_id),
    enabled: !!r.enabled,
    notify: !!r.notify,
  };
}

/**
 * Silnik alertów: reguły metryk liczone przy każdej próbce od agenta, reguły „offline” co minutę.
 * Stan „od kiedy warunek trwa” trzymamy w pamięci; otwarte alerty — w bazie (przeżywają restart).
 */
export class AlertEngine {
  private db: Db;
  private hub: Hub;
  private notifier: Notifier;
  private rules: AlertRule[] = [];
  /** `${ruleId}:${agentId}` -> od kiedy warunek jest spełniony */
  private since = new Map<string, number>();
  /** `${ruleId}:${agentId}` -> id otwartego alertu */
  private open = new Map<string, number>();
  private startedAt: number;
  private timer: NodeJS.Timeout;

  constructor(db: Db, hub: Hub, notifier: Notifier, now = Date.now()) {
    this.db = db;
    this.hub = hub;
    this.notifier = notifier;
    this.startedAt = now;
    this.reload();
    this.timer = setInterval(() => this.tick(), OFFLINE_TICK_MS);
    this.timer.unref();
  }

  close(): void {
    clearInterval(this.timer);
  }

  /** Wczytuje reguły i otwarte alerty z bazy; alerty reguł usuniętych/wyłączonych zamyka. */
  reload(): void {
    this.rules = (this.db.prepare('SELECT * FROM alert_rules ORDER BY id').all() as Record<string, unknown>[]).map(ruleFromRow);
    this.open.clear();
    const active = new Set(this.rules.filter((r) => r.enabled).map((r) => r.id));
    for (const row of this.db.prepare('SELECT id, rule_id, agent_id FROM alerts WHERE resolved_at IS NULL').all() as { id: number; rule_id: number | null; agent_id: string }[]) {
      if (row.rule_id === null || !active.has(row.rule_id)) this.resolveById(row.id, row.agent_id, Date.now());
      else this.open.set(`${row.rule_id}:${row.agent_id}`, row.id);
    }
  }

  /** Zmiana reguły: jej otwarte alerty zamykamy po cichu (otworzą się ponownie, jeśli warunek trwa). */
  ruleChanged(ruleId: number): void {
    for (const [key, id] of this.open) {
      if (!key.startsWith(`${ruleId}:`)) continue;
      this.resolveById(id, key.slice(key.indexOf(':') + 1), Date.now());
    }
    for (const key of [...this.since.keys()]) if (key.startsWith(`${ruleId}:`)) this.since.delete(key);
    this.reload();
  }

  private agent(agentId: string): AgentInfo | undefined {
    return this.db
      .prepare('SELECT a.id, a.hostname, a.label, a.client_id, c.name AS client_name, a.last_seen FROM agents a LEFT JOIN clients c ON c.id = a.client_id WHERE a.id = ?')
      .get(agentId) as AgentInfo | undefined;
  }

  private applies(rule: AlertRule, a: AgentInfo): boolean {
    return rule.enabled && (rule.clientId === null || rule.clientId === a.client_id);
  }

  /** Nowa próbka metryk od agenta. */
  onMetrics(agentId: string, m: Record<string, unknown>, now = Date.now()): void {
    const a = this.agent(agentId);
    if (!a) return;
    for (const rule of this.rules) {
      const key = `${rule.id}:${agentId}`;
      if (rule.kind === 'offline') {
        // metryki = komputer jest online
        if (this.open.has(key)) this.resolve(key, rule, a, now);
        continue;
      }
      if (!this.applies(rule, a)) {
        this.since.delete(key);
        if (this.open.has(key)) this.resolve(key, rule, a, now, false);
        continue;
      }
      const reading = this.read(rule.kind, m);
      if (!reading) continue;
      const { value, detail } = reading;
      if (value >= rule.threshold) {
        if (!this.since.has(key)) this.since.set(key, now);
        const since = this.since.get(key)!;
        if (!this.open.has(key) && now - since >= rule.durationMin * 60_000) this.openAlert(rule, a, value, detail, since);
      } else {
        if (!this.open.has(key)) this.since.delete(key);
        else if (value < rule.threshold - HYSTERESIS) {
          this.since.delete(key);
          this.resolve(key, rule, a, now);
        }
      }
    }
  }

  /** Komputer połączył się — zamknij jego alerty „offline”. */
  onConnected(agentId: string, now = Date.now()): void {
    const a = this.agent(agentId);
    if (!a) return;
    for (const rule of this.rules) {
      const key = `${rule.id}:${agentId}`;
      if (rule.kind === 'offline' && this.open.has(key)) this.resolve(key, rule, a, now);
    }
  }

  /** Okresowe sprawdzenie reguł „offline”. */
  tick(now = Date.now()): void {
    const offlineRules = this.rules.filter((r) => r.kind === 'offline');
    if (offlineRules.length === 0) return;
    const agents = this.db
      .prepare('SELECT a.id, a.hostname, a.label, a.client_id, c.name AS client_name, a.last_seen FROM agents a LEFT JOIN clients c ON c.id = a.client_id')
      .all() as unknown as AgentInfo[];
    for (const a of agents) {
      const online = this.hub.isOnline(a.id);
      for (const rule of offlineRules) {
        const key = `${rule.id}:${a.id}`;
        if (online || !this.applies(rule, a)) {
          if (this.open.has(key)) this.resolve(key, rule, a, now, online);
          continue;
        }
        if (this.open.has(key) || a.last_seen == null) continue; // nigdy niepołączony — pomijamy
        // po starcie serwera agenci potrzebują chwili na ponowne połączenie — liczymy od startu
        const offlineSince = Math.max(a.last_seen, this.startedAt);
        if (now - offlineSince >= rule.durationMin * 60_000) this.openAlert(rule, a, null, '', a.last_seen);
      }
    }
  }

  private read(kind: AlertKind, m: Record<string, unknown>): { value: number; detail: string } | null {
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    if (kind === 'cpu') {
      const v = num(m.cpuPercent);
      return v === null ? null : { value: v, detail: '' };
    }
    if (kind === 'mem') {
      const v = num(m.memPercent);
      return v === null ? null : { value: v, detail: '' };
    }
    if (kind === 'disk') {
      const disks = Array.isArray(m.disks) ? (m.disks as Record<string, unknown>[]) : [];
      let best: { value: number; detail: string } | null = null;
      for (const d of disks) {
        const v = num(d?.usedPercent);
        if (v !== null && (!best || v > best.value)) best = { value: v, detail: String(d.mountpoint ?? '') };
      }
      return best;
    }
    return null;
  }

  private openAlert(rule: AlertRule, a: AgentInfo, value: number | null, detail: string, startedAt: number): void {
    const key = `${rule.id}:${a.id}`;
    let id: number;
    try {
      const res = this.db
        .prepare('INSERT INTO alerts (rule_id, agent_id, kind, title, detail, value, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(rule.id, a.id, rule.kind, rule.name, detail, value === null ? null : Math.round(value * 10) / 10, startedAt);
      id = Number(res.lastInsertRowid);
    } catch {
      return; // już otwarty (indeks unikalny) — np. równoległa ścieżka
    }
    this.open.set(key, id);
    this.hub.broadcastAgent(a.id, { type: 'alert_opened', id: a.id, data: this.view(id) });
    if (rule.notify) {
      this.notifier.enqueue({
        title: `${machineName(a)}: ${rule.name}`,
        message: describe(rule, value, detail, startedAt),
        priority: rule.kind === 'offline' || rule.kind === 'disk' ? 1 : 0,
        url: this.notifier.machineUrl(a.id),
        urlTitle: 'Otwórz w panelu',
      });
    }
  }

  private resolve(key: string, rule: AlertRule, a: AgentInfo, now: number, notify = true): void {
    const id = this.open.get(key);
    if (id === undefined) return;
    const row = this.db.prepare('SELECT started_at FROM alerts WHERE id = ?').get(id) as { started_at: number } | undefined;
    this.resolveById(id, a.id, now);
    if (notify && rule.notify && row) {
      this.notifier.enqueue({
        title: `${machineName(a)}: ${rule.name} — koniec`,
        message: `Trwało ${formatDuration(now - row.started_at)}.`,
        priority: -1,
        url: this.notifier.machineUrl(a.id),
        urlTitle: 'Otwórz w panelu',
      });
    }
  }

  private resolveById(id: number, agentId: string, now: number): void {
    this.db.prepare('UPDATE alerts SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL').run(now, id);
    for (const [k, v] of this.open) if (v === id) this.open.delete(k);
    this.hub.broadcastAgent(agentId, { type: 'alert_resolved', id: agentId, data: this.view(id) });
  }

  view(id: number): AlertView | null {
    return (this.db.prepare(`${ALERT_VIEW_SQL} WHERE x.id = ?`).get(id) as AlertView | undefined) ?? null;
  }

  openCount(): number {
    return this.open.size;
  }
}

function machineName(a: { hostname: string; label: string; client_name?: string | null }): string {
  const name = a.label || a.hostname;
  return a.client_name ? `${name} (${a.client_name})` : name;
}

function describe(rule: AlertRule, value: number | null, detail: string, startedAt: number): string {
  const since = new Date(startedAt).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  switch (rule.kind) {
    case 'offline':
      return `Brak połączenia od ${since}.`;
    case 'cpu':
      return `Procesor ${pct(value ?? 0)} (próg ${pct(rule.threshold)})${rule.durationMin ? ` od ${rule.durationMin} min` : ''}.`;
    case 'mem':
      return `Pamięć zajęta w ${pct(value ?? 0)} (próg ${pct(rule.threshold)})${rule.durationMin ? ` od ${rule.durationMin} min` : ''}.`;
    case 'disk':
      return `Dysk ${detail} zajęty w ${pct(value ?? 0)} (próg ${pct(rule.threshold)}).`;
  }
}

export function formatDuration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} godz. ${min % 60} min`;
  return `${Math.floor(h / 24)} dni`;
}
