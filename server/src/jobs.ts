import { randomBytes } from 'node:crypto';
import type { Db } from './db.ts';
import { HttpError } from './errors.ts';
import type { Hub } from './hub.ts';

/**
 * Zadania: jedno polecenie (skrypt, komunikat, restart…) na wielu komputerach, wykonywane przez serwer w tle —
 * zamknięcie przeglądarki niczego nie przerywa. Komputery offline dostają zadanie po połączeniu (do `expires_at`).
 * Skrypt działa na agencie niezależnie od połączenia; po zerwaniu serwer odbiera wynik poleceniem script.result.
 */

export const JOB_KINDS = ['script', 'message', 'power', 'inventory'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export type TargetStatus = 'queued' | 'running' | 'ok' | 'failed' | 'expired' | 'canceled' | 'lost';

export interface ScriptParams {
  shell: string;
  script: string;
  timeoutSec: number;
  asUser: boolean;
}
export interface MessageParams {
  title: string;
  text: string;
  seconds: number;
}
export interface PowerParams {
  action: 'reboot' | 'shutdown';
  delayMinutes: number;
  message: string;
}
export type JobParams = ScriptParams | MessageParams | PowerParams | Record<string, never>;

interface TargetRow {
  job_id: number;
  agent_id: string;
  run_id: string;
  status: TargetStatus;
  started_at: number | null;
  kind: JobKind;
  params_json: string;
}

interface ScriptResult {
  exitCode: number;
  output: string;
  truncated?: boolean;
  timedOut?: boolean;
  durationMs?: number;
  user?: string;
}

const MAX_OUTPUT = 70_000;
/** po ilu ms bez odpowiedzi uznajemy uruchomienie skryptu za utracone (ponad jego limit czasu) */
const LOST_GRACE_MS = 15 * 60_000;
const TICK_MS = 30_000;

export class JobRunner {
  private db: Db;
  private hub: Hub;
  private inflight = new Set<string>();
  private timer: NodeJS.Timeout;
  private closed = false;
  private log: (msg: string) => void;
  /** powiadomienie paneli (debounce po stronie panelu) */
  private changed = new Set<number>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(db: Db, hub: Hub, log: (msg: string) => void = () => {}) {
    this.db = db;
    this.hub = hub;
    this.log = log;
    hub.on('ready', (id) => this.onAgentReady(id));
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref();
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
  }

  /** Tworzy zadanie i od razu wysyła je do komputerów online. */
  create(input: { kind: JobKind; title: string; params: JobParams; agentIds: string[]; waitMs: number; userId: number | null; username: string; scheduleId?: number }): number {
    const now = Date.now();
    const ids = [...new Set(input.agentIds)];
    let jobId = 0;
    this.db.exec('BEGIN');
    try {
      const r = this.db
        .prepare('INSERT INTO jobs (kind, title, params_json, user_id, created_by, created_at, expires_at, schedule_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(input.kind, input.title, JSON.stringify(input.params), input.userId, input.username, now, now + input.waitMs, input.scheduleId ?? null);
      jobId = Number(r.lastInsertRowid);
      const ins = this.db.prepare('INSERT INTO job_targets (job_id, agent_id, run_id) VALUES (?, ?, ?)');
      for (const a of ids) ins.run(jobId, a, randomBytes(12).toString('base64url'));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    for (const t of this.targets(`t.job_id = ? AND t.status = 'queued'`, jobId)) {
      if (this.hub.isOnline(t.agent_id)) this.dispatch(t);
    }
    // nikt nie jest online, a czekanie wyłączone — od razu „nie wykonano”
    if (input.waitMs <= 0) this.expireDue(jobId);
    this.finalize(jobId);
    this.touch(jobId);
    return jobId;
  }

  /** Anuluje oczekujące komputery (trwające skrypty kończą się normalnie). */
  cancel(jobId: number): void {
    const now = Date.now();
    this.db.prepare(`UPDATE job_targets SET status = 'canceled', finished_at = ? WHERE job_id = ? AND status = 'queued'`).run(now, jobId);
    this.db.prepare('UPDATE jobs SET canceled_at = COALESCE(canceled_at, ?) WHERE id = ?').run(now, jobId);
    this.finalize(jobId);
    this.touch(jobId);
  }

  // ---------- wykonywanie ----------

  private targets(where: string, ...params: (string | number)[]): TargetRow[] {
    return this.db
      .prepare(`SELECT t.job_id, t.agent_id, t.run_id, t.status, t.started_at, j.kind, j.params_json FROM job_targets t JOIN jobs j ON j.id = t.job_id WHERE ${where}`)
      .all(...params) as unknown as TargetRow[];
  }

  private onAgentReady(agentId: string): void {
    if (this.closed) return;
    const now = Date.now();
    // oczekujące i nieprzeterminowane
    for (const t of this.targets(`t.agent_id = ? AND t.status = 'queued' AND j.canceled_at IS NULL AND j.expires_at >= ?`, agentId, now)) this.dispatch(t);
    // przerwane rozłączeniem (albo restartem serwera) — skrypt mógł się dalej wykonywać na komputerze
    for (const t of this.targets(`t.agent_id = ? AND t.status = 'running'`, agentId)) {
      if (this.inflight.has(key(t))) continue;
      if (t.kind === 'script') this.resumeScript(t);
      else this.finish(t, 'lost', { error: 'Połączenie przerwane w trakcie — wynik nieznany.' });
    }
  }

  private dispatch(t: TargetRow): void {
    if (this.inflight.has(key(t))) return;
    this.inflight.add(key(t));
    const now = Date.now();
    this.db.prepare(`UPDATE job_targets SET status = 'running', started_at = ?, error = NULL WHERE job_id = ? AND agent_id = ?`).run(now, t.job_id, t.agent_id);
    this.touch(t.job_id);
    const p = JSON.parse(t.params_json);
    let req: Promise<unknown>;
    switch (t.kind) {
      case 'script': {
        const s = p as ScriptParams;
        // agent bez obsługi „jako użytkownik” — czytelny błąd zamiast uruchomienia jako SYSTEM
        const cap = s.asUser ? 'script.user' : 'script.run';
        req = this.hub.request(t.agent_id, 'script.run', { runId: t.run_id, ...s }, { capability: cap, timeoutMs: s.timeoutSec * 1000 + 60_000 });
        break;
      }
      case 'message':
        req = this.hub.request(t.agent_id, 'screen.message', p, { capability: 'screen.message', timeoutMs: 15_000 });
        break;
      case 'power': {
        const pw = p as PowerParams;
        req = this.hub.request(t.agent_id, 'power.action', pw, { capability: `power.${pw.action}`, timeoutMs: 30_000 });
        break;
      }
      case 'inventory':
        req = this.hub.request(t.agent_id, 'inventory.refresh', undefined, { capability: 'inventory.refresh', timeoutMs: 120_000 });
        break;
      default:
        req = Promise.reject(new HttpError(400, 'bad_kind', 'Nieznany rodzaj zadania.'));
    }
    req.then(
      (res) => this.onResult(t, res),
      (err) => this.onError(t, err as HttpError),
    ).finally(() => this.inflight.delete(key(t)));
  }

  private resumeScript(t: TargetRow): void {
    this.inflight.add(key(t));
    const s = JSON.parse(t.params_json) as ScriptParams;
    const left = (t.started_at ?? Date.now()) + s.timeoutSec * 1000 + 60_000 - Date.now();
    this.hub
      .request(t.agent_id, 'script.result', { runId: t.run_id }, { capability: 'script.run', timeoutMs: Math.max(60_000, left) })
      .then(
        (res) => this.onResult(t, res),
        (err: HttpError) => {
          if ((err as HttpError).code === 'unknown_run') this.finish(t, 'lost', { error: 'Komputer uruchomił się ponownie w trakcie — wynik nieznany.' });
          else this.onError(t, err);
        },
      )
      .finally(() => this.inflight.delete(key(t)));
  }

  private onResult(t: TargetRow, res: unknown): void {
    if (t.kind === 'script') {
      const r = (res ?? {}) as ScriptResult;
      const ok = r.exitCode === 0 && !r.timedOut;
      let output = typeof r.output === 'string' ? r.output : '';
      if (output.length > MAX_OUTPUT) output = output.slice(0, MAX_OUTPUT) + '\n…';
      this.finish(t, ok ? 'ok' : 'failed', {
        exitCode: Number.isInteger(r.exitCode) ? r.exitCode : null,
        output,
        error: r.timedOut ? 'Przekroczono limit czasu — skrypt został zatrzymany.' : null,
        runAs: typeof r.user === 'string' ? r.user.slice(0, 120) : null,
      });
    } else {
      this.finish(t, 'ok', {});
    }
  }

  private onError(t: TargetRow, err: HttpError): void {
    const code = err?.code ?? '';
    if (code === 'agent_offline') {
      // rozłączył się między sprawdzeniem a wysłaniem — wróci do kolejki
      this.db.prepare(`UPDATE job_targets SET status = 'queued', started_at = NULL WHERE job_id = ? AND agent_id = ? AND status = 'running'`).run(t.job_id, t.agent_id);
      this.touch(t.job_id);
      return;
    }
    if (code === 'agent_disconnected' || code === 'server_closing') {
      // skrypt trwa dalej na komputerze — wynik odbierzemy po ponownym połączeniu
      if (t.kind === 'script') return;
      // restart/wyłączenie: rozłączenie to spodziewany skutek polecenia
      if (t.kind === 'power') return this.finish(t, 'ok', {});
      return this.finish(t, 'lost', { error: 'Połączenie przerwane w trakcie — wynik nieznany.' });
    }
    if (code === 'agent_timeout') return this.finish(t, 'failed', { error: 'Komputer nie odpowiedział w limicie czasu.' });
    this.finish(t, 'failed', { error: err?.message || 'Błąd wykonania.' });
  }

  private finish(t: Pick<TargetRow, 'job_id' | 'agent_id'>, status: TargetStatus, r: { exitCode?: number | null; output?: string; error?: string | null; runAs?: string | null }): void {
    if (this.closed) return;
    this.db
      .prepare(`UPDATE job_targets SET status = ?, finished_at = ?, exit_code = ?, output = ?, error = ?, run_as = ? WHERE job_id = ? AND agent_id = ? AND status IN ('queued', 'running')`)
      .run(status, Date.now(), r.exitCode ?? null, r.output ?? null, r.error ?? null, r.runAs ?? null, t.job_id, t.agent_id);
    this.finalize(t.job_id);
    this.touch(t.job_id);
  }

  /** Zadanie kończy się, gdy żaden komputer nie czeka ani nie wykonuje. */
  private finalize(jobId: number): void {
    const open = this.db.prepare(`SELECT COUNT(*) AS n FROM job_targets WHERE job_id = ? AND status IN ('queued', 'running')`).get(jobId) as { n: number };
    if (open.n === 0) this.db.prepare('UPDATE jobs SET finished_at = COALESCE(finished_at, ?) WHERE id = ?').run(Date.now(), jobId);
  }

  private expireDue(jobId?: number): void {
    const now = Date.now();
    const rows = this.db
      .prepare(
        `SELECT t.job_id, t.agent_id FROM job_targets t JOIN jobs j ON j.id = t.job_id
         WHERE t.status = 'queued' AND j.expires_at <= ? ${jobId ? 'AND t.job_id = ?' : ''}`,
      )
      .all(...(jobId ? [now, jobId] : [now])) as { job_id: number; agent_id: string }[];
    for (const r of rows) this.finish(r, 'expired', { error: 'Komputer nie połączył się w wyznaczonym czasie.' });
  }

  /** Okresowo: przeterminowane oczekiwania i skrypty, na których wynik nie ma już szans. */
  tick(): void {
    if (this.closed) return;
    try {
      this.expireDue();
      const now = Date.now();
      for (const t of this.targets(`t.status = 'running'`)) {
        if (this.inflight.has(key(t))) continue;
        const limit = t.kind === 'script' ? (JSON.parse(t.params_json) as ScriptParams).timeoutSec * 1000 : 0;
        if ((t.started_at ?? 0) + limit + LOST_GRACE_MS < now) this.finish(t, 'lost', { error: 'Brak wyniku — komputer nie wrócił online.' });
      }
    } catch (err) {
      this.log(`zadania: ${(err as Error).message}`);
    }
  }

  private touch(jobId: number): void {
    this.changed.add(jobId);
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = null;
      const ids = [...this.changed];
      this.changed.clear();
      // bez danych — panel sam pobierze to, co widzi w swoim zakresie
      if (!this.closed) this.hub.broadcastAll({ type: 'jobs_changed', data: { ids } });
    }, 300);
    this.flushTimer.unref?.();
  }
}

function key(t: Pick<TargetRow, 'job_id' | 'agent_id'>): string {
  return `${t.job_id}:${t.agent_id}`;
}
