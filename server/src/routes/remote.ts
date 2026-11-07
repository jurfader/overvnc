import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { audit } from '../db.ts';
import { HttpError, parse } from '../errors.ts';
import { actorOf, requireUser } from '../auth.ts';
import { assertAgentAccess, canSeeClient } from '../scope.ts';
import { planWake, wakeMacs, type WolHost } from '../wol.ts';
import type { AgentRow } from '../hub.ts';
import { requestPower } from '../power.ts';

const IdParams = z.object({ id: z.uuid() });
const PidParams = z.object({ id: z.uuid(), pid: z.coerce.number().int().positive() });
const KillBody = z.object({ force: z.boolean().default(false), name: z.string().max(255).optional() });
const SvcParams = z.object({
  id: z.uuid(),
  name: z.string().regex(/^[A-Za-z0-9_.@:\-]{1,200}$/, 'Nieprawidłowa nazwa usługi.'),
  action: z.enum(['start', 'stop', 'restart', 'enable', 'disable']),
});
const POWER_ACTIONS = ['reboot', 'shutdown', 'cancel', 'logoff', 'lock'] as const;
const PowerBody = z.object({
  action: z.enum(POWER_ACTIONS),
  delayMinutes: z.number().int().min(0).max(24 * 60).default(0),
  message: z.string().max(200).default(''),
});

export const POWER_LABELS: Record<(typeof POWER_ACTIONS)[number], string> = {
  reboot: 'restart',
  shutdown: 'wyłączenie',
  cancel: 'anulowanie zaplanowanego restartu/wyłączenia',
  logoff: 'wylogowanie użytkowników',
  lock: 'blokada ekranu',
};

export async function remoteRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, hub } = ctx;
  const remote = { preHandler: requireUser(ctx, 'agents.remote') };

  const access = (req: FastifyRequest, params: unknown = req.params) => {
    const { id } = parse(IdParams.passthrough(), params);
    assertAgentAccess(db, req.user!, id);
    return id;
  };

  // ---------- procesy ----------

  app.get('/api/agents/:id/processes', remote, async (req) => {
    const id = access(req);
    return hub.request(id, 'proc.list', undefined, { capability: 'proc.list', timeoutMs: 30_000 });
  });

  app.post('/api/agents/:id/processes/:pid/kill', remote, async (req) => {
    const { id, pid } = parse(PidParams, req.params);
    assertAgentAccess(db, req.user!, id);
    const { force, name } = parse(KillBody, req.body);
    await hub.request(id, 'proc.kill', { pid, force }, { capability: 'proc.kill' });
    audit(db, actorOf(req), 'proc.kill', id, { pid, name, force }, req.ip);
    return { ok: true };
  });

  // ---------- usługi ----------

  app.get('/api/agents/:id/services', remote, async (req) => {
    const id = access(req);
    return hub.request(id, 'svc.list', undefined, { capability: 'svc.list', timeoutMs: 60_000 });
  });

  app.post('/api/agents/:id/services/:name/:action', remote, async (req) => {
    const { id, name, action } = parse(SvcParams, req.params);
    assertAgentAccess(db, req.user!, id);
    await hub.request(id, 'svc.control', { name, action }, { capability: 'svc.control', timeoutMs: 60_000 });
    audit(db, actorOf(req), 'svc.control', id, { name, action }, req.ip);
    return { ok: true };
  });

  // ---------- zasilanie ----------

  app.post('/api/agents/:id/power', remote, async (req) => {
    const id = access(req);
    const body = parse(PowerBody, req.body);
    await requestPower(hub, id, body);
    audit(db, actorOf(req), `power.${body.action}`, id, { delayMinutes: body.delayMinutes, message: body.message || undefined }, req.ip);
    return { ok: true };
  });

  // ---------- Wake-on-LAN ----------

  /** Plan wybudzenia w zakresie konta (przekaźnik musi być widoczny dla użytkownika). */
  const wakePlan = (req: FastifyRequest, id: string) => {
    const rows = db.prepare('SELECT id, client_id, site_id, last_ip, inventory_json, label, hostname FROM agents').all() as unknown as (Pick<
      AgentRow,
      'id' | 'client_id' | 'site_id' | 'last_ip' | 'inventory_json' | 'label' | 'hostname'
    >)[];
    const toHost = (r: (typeof rows)[number]): WolHost => {
      let network: WolHost['network'] = [];
      try {
        network = r.inventory_json ? (JSON.parse(r.inventory_json).network ?? []) : [];
      } catch {
        /* uszkodzony inwentarz */
      }
      return { id: r.id, clientId: r.client_id, siteId: r.site_id, lastIp: r.last_ip, online: hub.isOnline(r.id), network };
    };
    const target = rows.find((r) => r.id === id)!;
    const candidates = rows.filter((r) => canSeeClient(req.user!, r.client_id)).map(toHost);
    const targetHost = toHost(target);
    const plan = planWake(targetHost, candidates);
    const relay = plan ? rows.find((r) => r.id === plan.relayId)! : null;
    const reason: 'no_mac' | 'no_relay' | null = plan ? null : wakeMacs(targetHost.network).length === 0 ? 'no_mac' : 'no_relay';
    return { plan, relay, reason };
  };

  app.get('/api/agents/:id/wake', remote, async (req) => {
    const id = access(req);
    const { plan, relay, reason } = wakePlan(req, id);
    return {
      possible: !!plan,
      reason,
      relay: relay ? { id: relay.id, name: relay.label || relay.hostname } : null,
      macs: plan?.macs ?? [],
    };
  });

  app.post('/api/agents/:id/wake', remote, async (req) => {
    const id = access(req);
    if (hub.isOnline(id)) throw new HttpError(409, 'already_online', 'Komputer jest już włączony.');
    const { plan, relay, reason } = wakePlan(req, id);
    if (!plan || !relay) {
      throw reason === 'no_mac'
        ? new HttpError(409, 'no_mac', 'Nieznany adres MAC — komputer musi choć raz połączyć się z serwerem.')
        : new HttpError(409, 'no_relay', 'Brak włączonego komputera w tej samej sieci, który mógłby wysłać sygnał wybudzenia.');
    }
    await hub.request(plan.relayId, 'wol.send', { macs: plan.macs, broadcasts: plan.broadcasts }, { capability: 'wol.send' });
    audit(db, actorOf(req), 'agent.wake', id, { relay: plan.relayId, macs: plan.macs }, req.ip);
    return { ok: true, relay: { id: relay.id, name: relay.label || relay.hostname } };
  });
}
