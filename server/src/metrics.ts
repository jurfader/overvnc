import type { Db } from './db.ts';

/** Jedna próbka historii — wartości procentowe 0–100, sieć w bajtach/s. */
export interface MetricSample {
  ts: number;
  cpu: number;
  mem: number;
  memUsed: number;
  disk: number;
  rx: number;
  tx: number;
}

// Agent wysyła metryki co ~15 s; do historii zapisujemy najwyżej jedną próbkę na minutę,
// żeby baza nie puchła (1/min ≈ 20 tys. wierszy / komputer przy 14-dniowej retencji).
const MIN_SAMPLE_INTERVAL_MS = 55_000;
export const RETENTION_MS = 14 * 24 * 3600_000;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Zapisuje i odczytuje historię metryk komputerów. */
export class MetricsStore {
  private db: Db;
  private lastAt = new Map<string, number>();

  constructor(db: Db) {
    this.db = db;
  }

  /** Dokłada próbkę z bieżących metryk agenta (z throttlingiem do ~1/min). */
  record(agentId: string, m: Record<string, unknown> | null | undefined): void {
    if (!m) return;
    const ts = num(m.ts) || Date.now();
    const prev = this.lastAt.get(agentId) ?? 0;
    if (ts - prev < MIN_SAMPLE_INTERVAL_MS) return;
    this.lastAt.set(agentId, ts);

    const disks = Array.isArray(m.disks) ? (m.disks as Record<string, unknown>[]) : [];
    const disk = disks.reduce((mx, d) => Math.max(mx, num(d?.usedPercent)), 0);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO metrics_history (agent_id, ts, cpu, mem_percent, mem_used, disk_percent, net_rx, net_tx)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(agentId, ts, num(m.cpuPercent), num(m.memPercent), Math.round(num(m.memUsed)), disk, num(m.netRxBps), num(m.netTxBps));
  }

  /** Historia od `sinceMs` do teraz, zredukowana do najwyżej `maxPoints` punktów (uśrednianie kubełkami). */
  history(agentId: string, sinceMs: number, maxPoints = 360): MetricSample[] {
    const rows = this.db
      .prepare(
        `SELECT ts, cpu, mem_percent AS mem, mem_used AS memUsed, disk_percent AS disk, net_rx AS rx, net_tx AS tx
         FROM metrics_history WHERE agent_id = ? AND ts >= ? ORDER BY ts`,
      )
      .all(agentId, sinceMs) as unknown as MetricSample[];
    return downsample(rows, maxPoints);
  }

  /** Usuwa próbki starsze niż retencja. Zwraca liczbę usuniętych wierszy. */
  prune(olderThanMs = RETENTION_MS): number {
    const info = this.db.prepare('DELETE FROM metrics_history WHERE ts < ?').run(Date.now() - olderThanMs);
    if (info.changes) this.lastAt.clear();
    return Number(info.changes ?? 0);
  }
}

/** Uśrednia próbki w równych kubełkach, gdy jest ich więcej niż `maxPoints` (wykres zostaje czytelny). */
function downsample(rows: MetricSample[], maxPoints: number): MetricSample[] {
  if (rows.length <= maxPoints) return rows;
  const bucket = Math.ceil(rows.length / maxPoints);
  const out: MetricSample[] = [];
  for (let i = 0; i < rows.length; i += bucket) {
    const slice = rows.slice(i, i + bucket);
    const n = slice.length;
    const sum = slice.reduce(
      (a, r) => ({ cpu: a.cpu + r.cpu, mem: a.mem + r.mem, memUsed: a.memUsed + r.memUsed, disk: a.disk + r.disk, rx: a.rx + r.rx, tx: a.tx + r.tx }),
      { cpu: 0, mem: 0, memUsed: 0, disk: 0, rx: 0, tx: 0 },
    );
    out.push({
      ts: slice[n - 1].ts,
      cpu: r1(sum.cpu / n),
      mem: r1(sum.mem / n),
      memUsed: Math.round(sum.memUsed / n),
      disk: r1(sum.disk / n),
      rx: Math.round(sum.rx / n),
      tx: Math.round(sum.tx / n),
    });
  }
  return out;
}

const r1 = (f: number): number => Math.round(f * 10) / 10;
