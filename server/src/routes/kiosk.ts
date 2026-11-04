import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { audit } from '../db.ts';
import { HttpError, parse } from '../errors.ts';
import { actorOf, requireUser } from '../auth.ts';
import { assertAgentAccess } from '../scope.ts';

const IdParams = z.object({ id: z.uuid() });
const ShotQuery = z.object({ w: z.coerce.number().int().min(160).max(1920).default(640) });
export const MessageBody = z.object({
  text: z.string().trim().min(1, 'Wpisz treść komunikatu.').max(500),
  title: z.string().trim().max(80).default(''),
  seconds: z.number().int().min(5).max(3600).default(60),
});

const KioskParams = z.object({ id: z.uuid(), action: z.enum(['service-on', 'service-off', 'extend']) });
const KIOSK_AUDIT: Record<string, string> = { 'service-on': 'kiosk.service_on', 'service-off': 'kiosk.service_off', extend: 'kiosk.extend_eval' };

const SHOT_CACHE_MS = 2000;
const SHOT_AUDIT_EVERY_MS = 10 * 60_000;

interface Shot {
  at: number;
  jpeg: Buffer;
  w: number;
  h: number;
}

/** Tryb zgody klienta komputera (bez klienta = „notify”, jak przy pulpicie zdalnym). */
export function consentOf(ctx: Ctx, agentId: string): string {
  const row = ctx.db.prepare('SELECT c.consent_mode AS m FROM agents a LEFT JOIN clients c ON c.id = a.client_id WHERE a.id = ?').get(agentId) as { m: string | null } | undefined;
  return row?.m ?? 'notify';
}

export async function kioskRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, hub } = ctx;
  const remote = { preHandler: requireUser(ctx, 'agents.remote') };

  const access = (req: FastifyRequest) => {
    const { id } = parse(IdParams, req.params);
    assertAgentAccess(db, req.user!, id);
    return id;
  };

  // ---------- zrzut ekranu (miniatury kiosków, szybki podgląd) ----------
  const cache = new Map<string, Shot>();
  const inflight = new Map<string, Promise<Shot>>();
  const lastAudit = new Map<string, number>();

  const capture = (id: string, w: number): Promise<Shot> => {
    const key = `${id}:${w}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < SHOT_CACHE_MS) return Promise.resolve(hit);
    let p = inflight.get(key);
    if (!p) {
      p = hub
        .request<{ jpeg: string; w: number; h: number; ts: number }>(id, 'screen.capture', { maxWidth: w }, { capability: 'screen.capture', timeoutMs: 25_000 })
        .then((r) => {
          const shot = { at: Date.now(), jpeg: Buffer.from(r.jpeg, 'base64'), w: r.w, h: r.h };
          cache.set(key, shot);
          return shot;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return p;
  };

  app.get('/api/agents/:id/screenshot', remote, async (req, reply) => {
    const id = access(req);
    const { w } = parse(ShotQuery, req.query);
    // podgląd bez pytania tylko tam, gdzie klient wybrał „Bez komunikatu” (kioski); w innych — pulpit z zgodą
    if (consentOf(ctx, id) !== 'none') {
      throw new HttpError(403, 'consent_required', 'Podgląd ekranu bez powiadomienia jest dostępny tylko u klientów z trybem zgody „Bez komunikatu” (kioski). Użyj zakładki Pulpit.');
    }
    const shot = await capture(id, w);
    const auditKey = `${req.user!.id}:${id}`;
    if (Date.now() - (lastAudit.get(auditKey) ?? 0) > SHOT_AUDIT_EVERY_MS) {
      lastAudit.set(auditKey, Date.now());
      audit(db, actorOf(req), 'screen.view', id, null, req.ip);
    }
    return reply
      .header('Content-Type', 'image/jpeg')
      .header('Cache-Control', 'no-store')
      .header('X-Captured-At', String(shot.at))
      .header('X-Screen-Size', `${shot.w}x${shot.h}`)
      .send(shot.jpeg);
  });

  // ---------- Windows: tryb serwisowy (UWF) i przedłużanie wersji próbnej — każda akcja kończy się restartem ----------
  app.post('/api/agents/:id/kiosk/:action', remote, async (req) => {
    const { id, action } = parse(KioskParams, req.params);
    assertAgentAccess(db, req.user!, id);
    const r = await hub.request<{ status: string; restarts?: number }>(id, 'kiosk.action', { action }, { capability: 'kiosk.action', timeoutMs: 120_000 });
    audit(db, actorOf(req), KIOSK_AUDIT[action], id, r, req.ip);
    return r;
  });

  // ---------- komunikat na ekranie komputera ----------
  app.post('/api/agents/:id/message', remote, async (req) => {
    const id = access(req);
    const body = parse(MessageBody, req.body);
    await hub.request(id, 'screen.message', body, { capability: 'screen.message', timeoutMs: 15_000 });
    audit(db, actorOf(req), 'screen.message', id, { title: body.title, text: body.text, seconds: body.seconds }, req.ip);
    return { ok: true };
  });
}
