import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { audit } from '../db.ts';
import { HttpError, notFound, parse } from '../errors.ts';
import { actorOf, requireUser } from '../auth.ts';
import { assertAgentAccess, scopeSql } from '../scope.ts';
import type { JobKind, JobParams } from '../jobs.ts';
import { MessageBody } from './kiosk.ts';

const MAX_TARGETS = 500;
const HOUR = 3600_000;

const ScriptParams = z.object({
  shell: z.enum(['powershell', 'pwsh', 'cmd', 'bash', 'zsh', 'sh']),
  script: z
    .string()
    .min(1)
    .max(256 * 1024)
    .refine((s) => s.trim().length > 0, 'Wpisz treść skryptu.'),
  timeoutSec: z.number().int().min(10).max(4 * 3600).default(600),
  asUser: z.boolean().default(false),
});
const PowerParams = z.object({
  action: z.enum(['reboot', 'shutdown']),
  delayMinutes: z.number().int().min(0).max(24 * 60).default(0),
  message: z.string().max(200).default(''),
});

const Common = {
  agentIds: z.array(z.uuid()).min(1, 'Wybierz co najmniej jeden komputer.').max(MAX_TARGETS),
  /** ile godzin czekać na komputery offline (0 = tylko te, które są teraz online) */
  waitHours: z.number().min(0).max(7 * 24).default(24),
  title: z.string().trim().max(120).default(''),
};
const CreateBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('script'), params: ScriptParams, ...Common }),
  z.object({ kind: z.literal('message'), params: MessageBody, ...Common }),
  z.object({ kind: z.literal('power'), params: PowerParams, ...Common }),
  z.object({ kind: z.literal('inventory'), params: z.object({}).default({}), ...Common }),
]);

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const OutputParams = z.object({ id: z.coerce.number().int().positive(), agentId: z.uuid() });
const ListQuery = z.object({ agentId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });

const STATUSES = ['queued', 'running', 'ok', 'failed', 'expired', 'canceled', 'lost'] as const;

interface JobRow {
  id: number;
  kind: JobKind;
  title: string;
  params_json: string;
  created_by: string;
  created_at: number;
  expires_at: number;
  finished_at: number | null;
  canceled_at: number | null;
  schedule_id: number | null;
}

/** Tytuł zadania, gdy nie podano własnego. */
export function defaultTitle(kind: JobKind, params: any): string {
  switch (kind) {
    case 'script': {
      const line =
        String(params.script)
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => l && !l.startsWith('#') && !l.startsWith('::') && !/^rem\s/i.test(l) && !/^@echo/i.test(l)) ?? 'skrypt';
      return line.length > 80 ? line.slice(0, 79) + '…' : line;
    }
    case 'message':
      return `Komunikat: ${String(params.text).slice(0, 60)}`;
    case 'power':
      return (params.action === 'reboot' ? 'Restart' : 'Wyłączenie') + (params.delayMinutes ? ` za ${params.delayMinutes} min` : '');
    case 'inventory':
      return 'Odświeżenie inwentarza';
  }
}

export async function jobRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, jobs } = ctx;
  const remote = { preHandler: requireUser(ctx, 'agents.remote') };

  /** zadanie widoczne, gdy choć jeden jego komputer jest w zakresie konta */
  const visibleJob = (req: FastifyRequest, id: number): JobRow => {
    const where = scopeSql(req.user!, 'a.client_id');
    const row = db
      .prepare(
        `SELECT j.* FROM jobs j WHERE j.id = ? AND EXISTS (SELECT 1 FROM job_targets t JOIN agents a ON a.id = t.agent_id WHERE t.job_id = j.id AND ${where.sql})`,
      )
      .get(id, ...where.params) as JobRow | undefined;
    if (!row) throw notFound();
    return row;
  };

  const counts = (req: FastifyRequest, jobIds: number[]) => {
    const out = new Map<number, Record<string, number>>();
    if (jobIds.length === 0) return out;
    const where = scopeSql(req.user!, 'a.client_id');
    const rows = db
      .prepare(
        `SELECT t.job_id, t.status, COUNT(*) AS n FROM job_targets t JOIN agents a ON a.id = t.agent_id
         WHERE t.job_id IN (${jobIds.map(() => '?').join(',')}) AND ${where.sql} GROUP BY t.job_id, t.status`,
      )
      .all(...jobIds, ...where.params) as { job_id: number; status: string; n: number }[];
    for (const r of rows) {
      const c = out.get(r.job_id) ?? Object.fromEntries(STATUSES.map((s) => [s, 0]));
      c[r.status] = r.n;
      out.set(r.job_id, c);
    }
    return out;
  };

  const toDto = (j: JobRow, c: Record<string, number> | undefined) => {
    const cnt = c ?? Object.fromEntries(STATUSES.map((s) => [s, 0]));
    return {
      id: j.id,
      kind: j.kind,
      title: j.title,
      params: JSON.parse(j.params_json),
      createdBy: j.created_by,
      createdAt: j.created_at,
      expiresAt: j.expires_at,
      finishedAt: j.finished_at,
      canceledAt: j.canceled_at,
      scheduleId: j.schedule_id,
      counts: cnt,
      total: Object.values(cnt).reduce((a, b) => a + b, 0),
    };
  };

  app.post('/api/jobs', remote, async (req) => {
    const body = parse(CreateBody, req.body);
    const ids = [...new Set(body.agentIds)];
    for (const id of ids) assertAgentAccess(db, req.user!, id);
    const title = body.title || defaultTitle(body.kind, body.params);
    const jobId = jobs.create({
      kind: body.kind,
      title,
      params: body.params as JobParams,
      agentIds: ids,
      waitMs: Math.round(body.waitHours * HOUR),
      userId: req.user!.id,
      username: req.user!.username,
    });
    const details: Record<string, unknown> = { job: jobId, kind: body.kind, title, computers: ids.length };
    if (body.kind === 'script') Object.assign(details, { shell: body.params.shell, asUser: body.params.asUser, script: body.params.script.slice(0, 2000) });
    if (body.kind === 'message') details.text = body.params.text;
    if (body.kind === 'power') Object.assign(details, { action: body.params.action, delayMinutes: body.params.delayMinutes });
    audit(db, actorOf(req), 'job.create', ids.length === 1 ? ids[0] : null, details, req.ip);
    return { id: jobId };
  });

  app.get('/api/jobs', remote, async (req) => {
    const q = parse(ListQuery, req.query);
    const where = scopeSql(req.user!, 'a.client_id');
    const agentCond = q.agentId ? 'AND t.agent_id = ?' : '';
    const rows = db
      .prepare(
        `SELECT j.* FROM jobs j WHERE EXISTS (SELECT 1 FROM job_targets t JOIN agents a ON a.id = t.agent_id WHERE t.job_id = j.id AND ${where.sql} ${agentCond})
         ORDER BY j.created_at DESC LIMIT ?`,
      )
      .all(...where.params, ...(q.agentId ? [q.agentId] : []), q.limit) as unknown as JobRow[];
    const c = counts(
      req,
      rows.map((r) => r.id),
    );
    return rows.map((r) => toDto(r, c.get(r.id)));
  });

  app.get('/api/jobs/:id', remote, async (req) => {
    const { id } = parse(IdParams, req.params);
    const job = visibleJob(req, id);
    const where = scopeSql(req.user!, 'a.client_id');
    const targets = db
      .prepare(
        `SELECT t.agent_id, t.status, t.started_at, t.finished_at, t.exit_code, t.error, t.run_as, t.output,
                a.hostname, a.label, a.os, c.name AS client_name, c.color AS client_color
         FROM job_targets t JOIN agents a ON a.id = t.agent_id LEFT JOIN clients c ON c.id = a.client_id
         WHERE t.job_id = ? AND ${where.sql} ORDER BY a.hostname COLLATE NOCASE`,
      )
      .all(id, ...where.params) as any[];
    return {
      ...toDto(job, counts(req, [id]).get(id)),
      targets: targets.map((t) => ({
        agentId: t.agent_id,
        name: t.label || t.hostname,
        os: t.os,
        clientName: t.client_name,
        clientColor: t.client_color,
        online: ctx.hub.isOnline(t.agent_id),
        status: t.status,
        startedAt: t.started_at,
        finishedAt: t.finished_at,
        exitCode: t.exit_code,
        error: t.error,
        runAs: t.run_as,
        // podgląd: ostatnia niepusta linia wyjścia; całość osobno (wyniki mogą być duże)
        preview: lastLine(t.output),
        outputBytes: t.output ? Buffer.byteLength(t.output) : 0,
      })),
    };
  });

  app.get('/api/jobs/:id/output/:agentId', remote, async (req) => {
    const { id, agentId } = parse(OutputParams, req.params);
    visibleJob(req, id);
    assertAgentAccess(db, req.user!, agentId);
    const row = db.prepare('SELECT output FROM job_targets WHERE job_id = ? AND agent_id = ?').get(id, agentId) as { output: string | null } | undefined;
    if (!row) throw notFound();
    return { output: row.output ?? '' };
  });

  app.post('/api/jobs/:id/cancel', remote, async (req) => {
    const { id } = parse(IdParams, req.params);
    const job = visibleJob(req, id);
    if (job.finished_at) throw new HttpError(409, 'finished', 'Zadanie jest już zakończone.');
    jobs.cancel(id);
    audit(db, actorOf(req), 'job.cancel', null, { job: id, title: job.title }, req.ip);
    return { ok: true };
  });

  /** Ponowienie dla komputerów, na których się nie udało (w zakresie konta). */
  app.post('/api/jobs/:id/retry', remote, async (req) => {
    const { id } = parse(IdParams, req.params);
    const job = visibleJob(req, id);
    const where = scopeSql(req.user!, 'a.client_id');
    const ids = (
      db
        .prepare(
          `SELECT t.agent_id FROM job_targets t JOIN agents a ON a.id = t.agent_id
           WHERE t.job_id = ? AND t.status IN ('failed', 'expired', 'lost', 'canceled') AND ${where.sql}`,
        )
        .all(id, ...where.params) as { agent_id: string }[]
    ).map((r) => r.agent_id);
    if (ids.length === 0) throw new HttpError(409, 'nothing_to_retry', 'Nie ma komputerów do ponowienia.');
    const waitMs = Math.max(0, job.expires_at - job.created_at);
    const newId = jobs.create({
      kind: job.kind,
      title: job.title,
      params: JSON.parse(job.params_json),
      agentIds: ids,
      waitMs,
      userId: req.user!.id,
      username: req.user!.username,
    });
    audit(db, actorOf(req), 'job.retry', null, { job: id, newJob: newId, title: job.title, computers: ids.length }, req.ip);
    return { id: newId };
  });
}

function lastLine(s: string | null): string {
  if (!s) return '';
  const lines = s.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l) return l.length > 160 ? l.slice(0, 159) + '…' : l;
  }
  return '';
}
