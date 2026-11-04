import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx, SessionUser } from '../context.ts';
import { audit } from '../db.ts';
import { HttpError, notFound, parse } from '../errors.ts';
import { actorOf, requireUser } from '../auth.ts';
import { assertAgentAccess, canSeeClient } from '../scope.ts';
import { nextRun, resolveTargets, type ScheduleRow } from '../schedules.ts';
import { MessageBody } from './kiosk.ts';

/** Biblioteka skryptów i harmonogram. Zakres jak u komputerów: wpis wspólny (bez klienta) widzą tylko konta z dostępem do wszystkich. */

const SHELLS = ['powershell', 'pwsh', 'cmd', 'bash', 'zsh', 'sh'] as const;
const IdParams = z.object({ id: z.coerce.number().int().positive() });

const ScriptBody = z.object({
  name: z.string().trim().min(1, 'Wpisz nazwę.').max(100),
  description: z.string().trim().max(500).default(''),
  shell: z.enum(SHELLS),
  body: z
    .string()
    .max(256 * 1024)
    .refine((s) => s.trim().length > 0, 'Wpisz treść skryptu.'),
  timeoutSec: z.number().int().min(10).max(4 * 3600).default(600),
  asUser: z.boolean().default(false),
  clientId: z.number().int().positive().nullable().default(null),
});

const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Godzina w formacie GG:MM.');
const Target = z.discriminatedUnion('type', [
  z.object({ type: z.literal('agents'), agentIds: z.array(z.uuid()).min(1, 'Wybierz co najmniej jeden komputer.').max(500) }),
  z.object({ type: z.literal('client') }),
  z.object({ type: z.literal('tag'), tagId: z.number().int().positive() }),
  z.object({ type: z.literal('all') }),
]);
const ScheduleCommon = {
  name: z.string().trim().min(1, 'Wpisz nazwę.').max(100),
  clientId: z.number().int().positive().nullable().default(null),
  target: Target,
  days: z.number().int().min(1, 'Wybierz co najmniej jeden dzień.').max(127),
  time: TIME,
  waitHours: z.number().min(0).max(7 * 24).default(1),
  enabled: z.boolean().default(true),
};
const ScheduleBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('script'), params: z.object({ scriptId: z.number().int().positive() }), ...ScheduleCommon }),
  z.object({ kind: z.literal('message'), params: MessageBody, ...ScheduleCommon }),
  z.object({
    kind: z.literal('power'),
    params: z.object({ action: z.enum(['reboot', 'shutdown']), delayMinutes: z.number().int().min(0).max(1440).default(0), message: z.string().max(200).default('') }),
    ...ScheduleCommon,
  }),
  z.object({ kind: z.literal('inventory'), params: z.object({}).default({}), ...ScheduleCommon }),
]);

interface ScriptRow {
  id: number;
  name: string;
  description: string;
  shell: string;
  body: string;
  timeout_sec: number;
  as_user: number;
  client_id: number | null;
  created_by: string;
  created_at: number;
  updated_by: string;
  updated_at: number;
}

/** Wpis z klientem — według zakresu konta; wspólny — tylko konta z dostępem do wszystkich. */
export function canSeeOwned(user: SessionUser, clientId: number | null): boolean {
  return clientId === null ? user.allClients : canSeeClient(user, clientId);
}

export async function scriptRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, scheduler } = ctx;
  const remote = { preHandler: requireUser(ctx, 'agents.remote') };

  const assertClient = (req: FastifyRequest, clientId: number | null) => {
    if (clientId !== null && !db.prepare('SELECT 1 FROM clients WHERE id = ?').get(clientId)) throw new HttpError(400, 'validation', 'Nieznany klient.');
    if (!canSeeOwned(req.user!, clientId))
      throw new HttpError(403, 'forbidden', clientId === null ? 'Wybierz klienta — wpisy wspólne tworzą konta z dostępem do wszystkich klientów.' : 'Brak dostępu do tego klienta.');
  };

  // ---------- biblioteka skryptów ----------

  const scriptDto = (r: ScriptRow, usedBy: string[] = []) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    shell: r.shell,
    body: r.body,
    timeoutSec: r.timeout_sec,
    asUser: !!r.as_user,
    clientId: r.client_id,
    createdBy: r.created_by,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
    usedBy,
  });

  const visibleScript = (req: FastifyRequest, id: number): ScriptRow => {
    const r = db.prepare('SELECT * FROM scripts WHERE id = ?').get(id) as ScriptRow | undefined;
    if (!r || !canSeeOwned(req.user!, r.client_id)) throw notFound();
    return r;
  };

  const usage = () => {
    const m = new Map<number, string[]>();
    for (const s of db.prepare("SELECT name, params_json FROM schedules WHERE kind = 'script'").all() as { name: string; params_json: string }[]) {
      const id = JSON.parse(s.params_json).scriptId as number;
      m.set(id, [...(m.get(id) ?? []), s.name]);
    }
    return m;
  };

  app.get('/api/scripts', remote, async (req) => {
    const used = usage();
    return (db.prepare('SELECT * FROM scripts ORDER BY name COLLATE NOCASE').all() as unknown as ScriptRow[])
      .filter((r) => canSeeOwned(req.user!, r.client_id))
      .map((r) => scriptDto(r, used.get(r.id)));
  });

  app.post('/api/scripts', remote, async (req) => {
    const b = parse(ScriptBody, req.body);
    assertClient(req, b.clientId);
    const now = Date.now();
    const r = db
      .prepare(
        'INSERT INTO scripts (name, description, shell, body, timeout_sec, as_user, client_id, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(b.name, b.description, b.shell, b.body, b.timeoutSec, b.asUser ? 1 : 0, b.clientId, req.user!.username, now, req.user!.username, now);
    audit(db, actorOf(req), 'script.create', b.name, { shell: b.shell, clientId: b.clientId }, req.ip);
    return scriptDto(visibleScript(req, Number(r.lastInsertRowid)));
  });

  app.put('/api/scripts/:id', remote, async (req) => {
    const { id } = parse(IdParams, req.params);
    const cur = visibleScript(req, id);
    const b = parse(ScriptBody, req.body);
    assertClient(req, b.clientId);
    db.prepare('UPDATE scripts SET name = ?, description = ?, shell = ?, body = ?, timeout_sec = ?, as_user = ?, client_id = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(
      b.name,
      b.description,
      b.shell,
      b.body,
      b.timeoutSec,
      b.asUser ? 1 : 0,
      b.clientId,
      req.user!.username,
      Date.now(),
      id,
    );
    audit(db, actorOf(req), 'script.update', b.name, { previousName: cur.name !== b.name ? cur.name : undefined, bodyChanged: cur.body !== b.body }, req.ip);
    return scriptDto(visibleScript(req, id), usage().get(id));
  });

  app.delete('/api/scripts/:id', remote, async (req) => {
    const { id } = parse(IdParams, req.params);
    const cur = visibleScript(req, id);
    const used = usage().get(id);
    if (used?.length) throw new HttpError(409, 'in_use', `Skrypt jest używany w harmonogramie: ${used.join(', ')}. Najpierw zmień albo usuń harmonogram.`);
    db.prepare('DELETE FROM scripts WHERE id = ?').run(id);
    audit(db, actorOf(req), 'script.delete', cur.name, null, req.ip);
    return { ok: true };
  });

  // ---------- harmonogram ----------

  const visibleSchedule = (req: FastifyRequest, id: number): ScheduleRow => {
    const r = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow | undefined;
    if (!r || !canSeeOwned(req.user!, r.client_id)) throw notFound();
    return r;
  };

  const scheduleDto = (r: ScheduleRow) => {
    const target = JSON.parse(r.target_json);
    const last = r.last_job_id
      ? (db.prepare('SELECT finished_at, (SELECT COUNT(*) FROM job_targets WHERE job_id = j.id) AS total, (SELECT COUNT(*) FROM job_targets WHERE job_id = j.id AND status = \'ok\') AS ok FROM jobs j WHERE id = ?').get(r.last_job_id) as
          | { finished_at: number | null; total: number; ok: number }
          | undefined)
      : undefined;
    const params = JSON.parse(r.params_json);
    const script = r.kind === 'script' ? (db.prepare('SELECT name FROM scripts WHERE id = ?').get(params.scriptId) as { name: string } | undefined) : undefined;
    const tag = r.target_type === 'tag' ? (db.prepare('SELECT name, color FROM tags WHERE id = ?').get(target.tagId) as { name: string; color: string } | undefined) : undefined;
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      params,
      scriptName: script?.name ?? null,
      clientId: r.client_id,
      target: { type: r.target_type, ...target, tagName: tag?.name, tagColor: tag?.color },
      targetCount: resolveTargets(db, r).length,
      days: r.days,
      time: r.time,
      waitHours: r.wait_hours,
      enabled: !!r.enabled,
      nextRunAt: r.next_run_at,
      lastRunAt: r.last_run_at,
      lastJob: r.last_job_id && last ? { id: r.last_job_id, finished: last.finished_at !== null, total: last.total, ok: last.ok } : null,
      createdBy: r.created_by,
    };
  };

  const validateSchedule = (req: FastifyRequest, b: z.infer<typeof ScheduleBody>) => {
    assertClient(req, b.clientId);
    if (b.target.type === 'client' && b.clientId === null) throw new HttpError(400, 'validation', 'Wybierz klienta.');
    if (b.target.type === 'all' && b.clientId !== null) throw new HttpError(400, 'validation', 'Dla jednego klienta wybierz cel „wszystkie komputery klienta”.');
    if (b.target.type === 'tag' && !db.prepare('SELECT 1 FROM tags WHERE id = ?').get(b.target.tagId)) throw new HttpError(400, 'validation', 'Nieznany tag.');
    if (b.target.type === 'agents') {
      for (const id of b.target.agentIds) {
        const { clientId } = assertAgentAccess(db, req.user!, id);
        if (b.clientId !== null && clientId !== b.clientId) throw new HttpError(400, 'validation', 'Wybrane komputery muszą należeć do klienta harmonogramu.');
      }
    }
    if (b.kind === 'script') {
      const sc = db.prepare('SELECT client_id FROM scripts WHERE id = ?').get(b.params.scriptId) as { client_id: number | null } | undefined;
      if (!sc || !canSeeOwned(req.user!, sc.client_id)) throw new HttpError(400, 'validation', 'Nieznany skrypt.');
      if (sc.client_id !== null && sc.client_id !== b.clientId) throw new HttpError(400, 'validation', 'Skrypt należy do innego klienta.');
    }
  };

  const targetJson = (t: z.infer<typeof Target>) => JSON.stringify(t.type === 'agents' ? { agentIds: [...new Set(t.agentIds)] } : t.type === 'tag' ? { tagId: t.tagId } : {});

  app.get('/api/schedules', remote, async (req) =>
    (db.prepare('SELECT * FROM schedules ORDER BY name COLLATE NOCASE').all() as unknown as ScheduleRow[]).filter((r) => canSeeOwned(req.user!, r.client_id)).map(scheduleDto),
  );

  app.post('/api/schedules', remote, async (req) => {
    const b = parse(ScheduleBody, req.body);
    validateSchedule(req, b);
    const r = db
      .prepare(
        'INSERT INTO schedules (name, kind, params_json, client_id, target_type, target_json, days, time, wait_hours, enabled, next_run_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        b.name,
        b.kind,
        JSON.stringify(b.params),
        b.clientId,
        b.target.type,
        targetJson(b.target),
        b.days,
        b.time,
        b.waitHours,
        b.enabled ? 1 : 0,
        b.enabled ? nextRun(Date.now(), b.days, b.time) : null,
        req.user!.username,
        Date.now(),
      );
    const id = Number(r.lastInsertRowid);
    audit(db, actorOf(req), 'schedule.create', b.name, { kind: b.kind, days: b.days, time: b.time, target: b.target.type }, req.ip);
    return scheduleDto(visibleSchedule(req, id));
  });

  app.put('/api/schedules/:id', remote, async (req) => {
    const { id } = parse(IdParams, req.params);
    visibleSchedule(req, id);
    const b = parse(ScheduleBody, req.body);
    validateSchedule(req, b);
    db.prepare('UPDATE schedules SET name = ?, kind = ?, params_json = ?, client_id = ?, target_type = ?, target_json = ?, days = ?, time = ?, wait_hours = ?, enabled = ? WHERE id = ?').run(
      b.name,
      b.kind,
      JSON.stringify(b.params),
      b.clientId,
      b.target.type,
      targetJson(b.target),
      b.days,
      b.time,
      b.waitHours,
      b.enabled ? 1 : 0,
      id,
    );
    scheduler.reschedule(id);
    audit(db, actorOf(req), 'schedule.update', b.name, { kind: b.kind, days: b.days, time: b.time, enabled: b.enabled }, req.ip);
    return scheduleDto(visibleSchedule(req, id));
  });

  app.delete('/api/schedules/:id', remote, async (req) => {
    const { id } = parse(IdParams, req.params);
    const cur = visibleSchedule(req, id);
    db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
    audit(db, actorOf(req), 'schedule.delete', cur.name, null, req.ip);
    return { ok: true };
  });

  app.post('/api/schedules/:id/run', remote, async (req) => {
    const { id } = parse(IdParams, req.params);
    const cur = visibleSchedule(req, id);
    const jobId = scheduler.run(id);
    if (!jobId) throw new HttpError(409, 'no_targets', cur.kind === 'script' ? 'Brak komputerów w celu albo skrypt został usunięty.' : 'Brak komputerów w celu harmonogramu.');
    audit(db, actorOf(req), 'schedule.run', cur.name, { job: jobId }, req.ip);
    return { jobId };
  });
}
