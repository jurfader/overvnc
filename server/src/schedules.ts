import type { Db } from './db.ts';
import type { Hub } from './hub.ts';
import type { JobKind, JobParams, JobRunner } from './jobs.ts';

/**
 * Harmonogram: zadanie (skrypt z biblioteki, komunikat, restart, inwentarz) uruchamiane w wybrane dni tygodnia
 * o wybranej godzinie (czas polski). Cel liczony przy każdym uruchomieniu — „wszystkie komputery klienta”
 * albo „z tagiem” obejmuje też komputery dodane później.
 */

export const SCHEDULE_TZ = 'Europe/Warsaw';
/** zaległe uruchomienie (np. serwer był wyłączony) wykonujemy, jeśli spóźnienie nie przekracza tego czasu */
const MISSED_GRACE_MS = 15 * 60_000;
const TICK_MS = 20_000;

export type TargetType = 'agents' | 'client' | 'tag' | 'all';

export interface ScheduleRow {
  id: number;
  name: string;
  kind: JobKind;
  params_json: string;
  client_id: number | null;
  target_type: TargetType;
  target_json: string;
  days: number;
  time: string;
  wait_hours: number;
  enabled: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_job_id: number | null;
  created_by: string;
  created_at: number;
}

// ---------- czas ----------

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: SCHEDULE_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short',
  hourCycle: 'h23',
});
const WEEKDAY: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** Data i godzina „na zegarze” w Polsce dla chwili `ms`. */
export function wallClock(ms: number): { y: number; mo: number; d: number; h: number; mi: number; s: number; wd: number } {
  const p = Object.fromEntries(partsFmt.formatToParts(ms).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second, wd: WEEKDAY[p.weekday] };
}

/** Chwila (UTC ms) odpowiadająca godzinie na zegarze w Polsce; przy zmianie czasu — najbliższa istniejąca. */
export function fromWallClock(y: number, mo: number, d: number, h: number, mi: number): number {
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  let guess = naive;
  for (let i = 0; i < 3; i++) {
    const w = wallClock(guess);
    const shown = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
    guess += naive - shown;
  }
  return guess;
}

/** Najbliższe uruchomienie po `after` (ms) — dni z maski (bit 0 = poniedziałek) o godzinie `time` (HH:MM). */
export function nextRun(after: number, days: number, time: string): number | null {
  if (!(days & 0x7f)) return null;
  const [hh, mm] = time.split(':').map(Number);
  const today = wallClock(after);
  for (let i = 0; i <= 8; i++) {
    // kolejne dni kalendarzowe w Polsce (od południa — odporne na zmianę czasu)
    const noon = fromWallClock(today.y, today.mo, today.d, 12, 0) + i * 86_400_000;
    const w = wallClock(noon);
    if (!(days & (1 << w.wd))) continue;
    const at = fromWallClock(w.y, w.mo, w.d, hh, mm);
    if (at > after) return at;
  }
  return null;
}

// ---------- cele ----------

/** Komputery celu w chwili uruchomienia (zawsze w zakresie klienta harmonogramu). */
export function resolveTargets(db: Db, s: Pick<ScheduleRow, 'client_id' | 'target_type' | 'target_json'>): string[] {
  const t = JSON.parse(s.target_json || '{}') as { agentIds?: string[]; tagId?: number };
  const inClient = s.client_id === null ? '' : ' AND a.client_id = ?';
  const cp = s.client_id === null ? [] : [s.client_id];
  let rows: { id: string }[] = [];
  switch (s.target_type) {
    case 'all':
      rows = db.prepare(`SELECT a.id FROM agents a WHERE 1 = 1${inClient}`).all(...cp) as { id: string }[];
      break;
    case 'client':
      if (s.client_id !== null) rows = db.prepare('SELECT a.id FROM agents a WHERE a.client_id = ?').all(s.client_id) as { id: string }[];
      break;
    case 'tag':
      rows = db.prepare(`SELECT a.id FROM agents a JOIN agent_tags x ON x.agent_id = a.id WHERE x.tag_id = ?${inClient}`).all(t.tagId ?? -1, ...cp) as { id: string }[];
      break;
    case 'agents': {
      const ids = (t.agentIds ?? []).slice(0, 500);
      if (ids.length)
        rows = db.prepare(`SELECT a.id FROM agents a WHERE a.id IN (${ids.map(() => '?').join(',')})${inClient}`).all(...ids, ...cp) as { id: string }[];
      break;
    }
  }
  return rows.map((r) => r.id);
}

// ---------- wykonanie ----------

export class Scheduler {
  private db: Db;
  private jobs: JobRunner;
  private timer: NodeJS.Timeout;
  private log: (msg: string) => void;

  constructor(db: Db, _hub: Hub, jobs: JobRunner, log: (msg: string) => void = () => {}) {
    this.db = db;
    this.jobs = jobs;
    this.log = log;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref();
  }

  close(): void {
    clearInterval(this.timer);
  }

  /** Przelicza najbliższe uruchomienie (po zmianie harmonogramu). */
  reschedule(id: number, now = Date.now()): void {
    const s = this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow | undefined;
    if (!s) return;
    const next = s.enabled ? nextRun(now, s.days, s.time) : null;
    this.db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(next, id);
  }

  /** Uruchamia harmonogram od razu (ręcznie albo o czasie). Zwraca numer zadania albo null, gdy cel jest pusty. */
  run(id: number, now = Date.now()): number | null {
    const s = this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow | undefined;
    if (!s) return null;
    const agentIds = resolveTargets(this.db, s);
    let jobId: number | null = null;
    const params = this.jobParams(s);
    if (agentIds.length && params) {
      jobId = this.jobs.create({
        kind: s.kind,
        title: s.name,
        params,
        agentIds,
        waitMs: Math.round(s.wait_hours * 3600_000),
        userId: null,
        username: `harmonogram`,
        scheduleId: s.id,
      });
    } else if (!params) {
      this.log(`harmonogram „${s.name}”: skrypt nie istnieje — pominięto`);
    }
    this.db.prepare('UPDATE schedules SET last_run_at = ?, last_job_id = COALESCE(?, last_job_id) WHERE id = ?').run(now, jobId, id);
    return jobId;
  }

  /** Parametry zadania; skrypt pobierany z biblioteki w chwili uruchomienia (zmiany w bibliotece obowiązują od razu). */
  private jobParams(s: ScheduleRow): JobParams | null {
    const p = JSON.parse(s.params_json || '{}');
    if (s.kind !== 'script') return p;
    const sc = this.db.prepare('SELECT shell, body, timeout_sec, as_user FROM scripts WHERE id = ?').get(p.scriptId ?? -1) as
      | { shell: string; body: string; timeout_sec: number; as_user: number }
      | undefined;
    if (!sc) return null;
    return { shell: sc.shell, script: sc.body, timeoutSec: sc.timeout_sec, asUser: !!sc.as_user };
  }

  tick(now = Date.now()): void {
    let due: ScheduleRow[];
    try {
      due = this.db.prepare('SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?').all(now) as unknown as ScheduleRow[];
    } catch (err) {
      return this.log(`harmonogram: ${(err as Error).message}`);
    }
    for (const s of due) {
      try {
        if (now - s.next_run_at! <= MISSED_GRACE_MS) this.run(s.id, now);
        else this.log(`harmonogram „${s.name}”: pominięto zaległe uruchomienie (serwer był niedostępny)`);
      } catch (err) {
        this.log(`harmonogram „${s.name}”: ${(err as Error).message}`);
      } finally {
        this.db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(nextRun(now, s.days, s.time), s.id);
      }
    }
  }
}
