import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { audit } from '../db.ts';
import { HttpError, notFound, parse } from '../errors.ts';
import { actorOf, requireGlobal, requireUser } from '../auth.ts';
import { canSeeClient, scopeSql } from '../scope.ts';
import { ALERT_KINDS, ALERT_VIEW_SQL, ruleFromRow, type AlertView } from '../alerts.ts';

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const ListQuery = z.object({
  state: z.enum(['open', 'all']).default('open'),
  limit: z.coerce.number().int().min(1).max(1000).default(300),
  agentId: z.uuid().optional(),
});
const RuleBody = z
  .object({
    name: z.string().trim().min(1, 'Nazwa jest wymagana.').max(100),
    kind: z.enum(ALERT_KINDS),
    threshold: z.number().min(0).max(100).default(0),
    durationMin: z.number().int().min(0).max(1440).default(0),
    clientId: z.number().int().positive().nullable().default(null),
    enabled: z.boolean().default(true),
    notify: z.boolean().default(true),
  })
  .refine((r) => r.kind === 'offline' || r.threshold >= 1, { message: 'Podaj próg w procentach (1–100).', path: ['threshold'] })
  .refine((r) => r.kind !== 'offline' || r.durationMin >= 1, { message: 'Dla reguły „offline” podaj czas co najmniej 1 min.', path: ['durationMin'] });
const PushoverBody = z.object({
  // puste pola = bez zmian; clear = usuń konfigurację
  token: z.string().trim().max(60).default(''),
  user: z.string().trim().max(60).default(''),
  clear: z.boolean().default(false),
});

export async function alertRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, alerts, notifier } = ctx;
  const view = { preHandler: requireUser(ctx, 'agents.view') };
  const ack = { preHandler: requireUser(ctx, 'agents.refresh') };
  const manage = { preHandler: requireUser(ctx, 'agents.manage') };

  /** Adres panelu (do linków w powiadomieniach) z żądania administratora — za proxy uwzględnia X-Forwarded-*. */
  const rememberPanelUrl = (req: FastifyRequest) => {
    const host = req.host;
    if (host) notifier.setPanelUrl(`${req.protocol}://${host}`);
  };

  // ---------- alerty ----------

  app.get('/api/alerts', view, async (req) => {
    const q = parse(ListQuery, req.query);
    const where = scopeSql(req.user!, 'a.client_id');
    const conds = [where.sql];
    const params: (string | number)[] = [...where.params];
    if (q.state === 'open') conds.push('x.resolved_at IS NULL');
    if (q.agentId) {
      conds.push('x.agent_id = ?');
      params.push(q.agentId);
    }
    return db.prepare(`${ALERT_VIEW_SQL} WHERE ${conds.join(' AND ')} ORDER BY x.started_at DESC LIMIT ?`).all(...params, q.limit) as unknown as AlertView[];
  });

  app.post('/api/alerts/:id/ack', ack, async (req) => {
    const { id } = parse(IdParams, req.params);
    const row = alerts.view(id);
    if (!row || !canSeeClient(req.user!, row.clientId)) throw notFound();
    if (row.ackAt === null) {
      db.prepare('UPDATE alerts SET ack_by = ?, ack_at = ? WHERE id = ?').run(req.user!.displayName || req.user!.username, Date.now(), id);
      audit(db, actorOf(req), 'alert.ack', row.agentId, { alert: id, title: row.title }, req.ip);
    }
    const updated = alerts.view(id)!;
    ctx.hub.broadcastAgent(updated.agentId, { type: 'alert_updated', id: updated.agentId, data: updated });
    return updated;
  });

  // ---------- reguły (globalne — mogą dotyczyć wszystkich klientów) ----------

  const ruleList = () =>
    (db.prepare('SELECT r.*, c.name AS client_name FROM alert_rules r LEFT JOIN clients c ON c.id = r.client_id ORDER BY r.id').all() as Record<string, unknown>[]).map(
      (r) => ({ ...ruleFromRow(r), clientName: (r.client_name as string | null) ?? null }),
    );

  const assertClient = (clientId: number | null) => {
    if (clientId !== null && !db.prepare('SELECT 1 FROM clients WHERE id = ?').get(clientId)) throw new HttpError(400, 'validation', 'Nieznany klient.');
  };

  app.get('/api/alert-rules', manage, async (req) => {
    requireGlobal(req);
    return ruleList();
  });

  app.post('/api/alert-rules', manage, async (req) => {
    requireGlobal(req);
    const b = parse(RuleBody, req.body);
    assertClient(b.clientId);
    const res = db
      .prepare('INSERT INTO alert_rules (name, kind, threshold, duration_min, client_id, enabled, notify, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(b.name, b.kind, b.kind === 'offline' ? 0 : b.threshold, b.durationMin, b.clientId, b.enabled ? 1 : 0, b.notify ? 1 : 0, Date.now());
    const id = Number(res.lastInsertRowid);
    alerts.ruleChanged(id);
    audit(db, actorOf(req), 'alert_rule.create', b.name, b, req.ip);
    return { id };
  });

  app.put('/api/alert-rules/:id', manage, async (req) => {
    requireGlobal(req);
    const { id } = parse(IdParams, req.params);
    if (!db.prepare('SELECT 1 FROM alert_rules WHERE id = ?').get(id)) throw notFound();
    const b = parse(RuleBody, req.body);
    assertClient(b.clientId);
    db.prepare('UPDATE alert_rules SET name = ?, kind = ?, threshold = ?, duration_min = ?, client_id = ?, enabled = ?, notify = ? WHERE id = ?').run(
      b.name,
      b.kind,
      b.kind === 'offline' ? 0 : b.threshold,
      b.durationMin,
      b.clientId,
      b.enabled ? 1 : 0,
      b.notify ? 1 : 0,
      id,
    );
    alerts.ruleChanged(id);
    audit(db, actorOf(req), 'alert_rule.update', b.name, b, req.ip);
    return { ok: true };
  });

  app.delete('/api/alert-rules/:id', manage, async (req) => {
    requireGlobal(req);
    const { id } = parse(IdParams, req.params);
    const cur = db.prepare('SELECT name FROM alert_rules WHERE id = ?').get(id) as { name: string } | undefined;
    if (!cur) throw notFound();
    alerts.ruleChanged(id); // zamyka otwarte alerty reguły, zanim zniknie
    db.prepare('DELETE FROM alert_rules WHERE id = ?').run(id);
    alerts.reload();
    audit(db, actorOf(req), 'alert_rule.delete', cur.name, null, req.ip);
    return { ok: true };
  });

  // ---------- powiadomienia (Pushover) ----------

  const notifyStatus = () => {
    const p = notifier.pushover();
    return { pushover: { configured: !!p, userHint: p ? `…${p.user.slice(-4)}` : null }, panelUrl: notifier.panelUrl() };
  };

  app.get('/api/settings/notifications', manage, async (req) => {
    requireGlobal(req);
    return notifyStatus();
  });

  app.put('/api/settings/notifications', manage, async (req) => {
    requireGlobal(req);
    const b = parse(PushoverBody, req.body);
    rememberPanelUrl(req);
    if (b.clear) {
      notifier.setPushover(null);
      audit(db, actorOf(req), 'notify.pushover_clear', null, null, req.ip);
      return notifyStatus();
    }
    const cur = notifier.pushover();
    const token = b.token || cur?.token || '';
    const user = b.user || cur?.user || '';
    const key = /^[A-Za-z0-9]{30}$/;
    if (!key.test(token)) throw new HttpError(400, 'validation', 'Token aplikacji Pushover ma 30 znaków (litery i cyfry).');
    if (!key.test(user)) throw new HttpError(400, 'validation', 'Klucz użytkownika Pushover ma 30 znaków (litery i cyfry).');
    notifier.setPushover({ token, user });
    audit(db, actorOf(req), 'notify.pushover_set', null, null, req.ip);
    return notifyStatus();
  });

  app.post('/api/settings/notifications/test', manage, async (req) => {
    requireGlobal(req);
    rememberPanelUrl(req);
    try {
      await notifier.sendNow({
        title: 'OVERVNC — powiadomienie testowe',
        message: 'Powiadomienia o alertach działają. Tak będą wyglądać wiadomości o problemach z komputerami.',
        url: notifier.panelUrl() ? `${notifier.panelUrl()}/#/alerts` : undefined,
        urlTitle: 'Otwórz alerty',
      });
    } catch (err) {
      throw new HttpError(422, 'push_failed', `Pushover odrzucił wiadomość: ${(err as Error).message}`);
    }
    return { ok: true };
  });
}
