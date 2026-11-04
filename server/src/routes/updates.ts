import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { audit } from '../db.ts';
import { HttpError, parse } from '../errors.ts';
import { actorOf, agentFromRequest, requireGlobal, requireUser } from '../auth.ts';
import { assertAgentAccess } from '../scope.ts';
import { newerVersion } from '../updates.ts';

const Platform = z.string().regex(/^(windows|darwin|linux)-(amd64|arm64)$/, 'Nieznana platforma.');
const OfferQuery = z.object({ version: z.string().max(50), platform: Platform });
const DownloadParams = z.object({ version: z.string().regex(/^[\w.-]{1,50}$/), platform: Platform });
const PolicyBody = z.object({ policy: z.enum(['auto', 'manual']) });
const ApproveBody = z.object({ version: z.string().max(50) });
const IdParams = z.object({ id: z.uuid() });

/** Odstęp między komputerami przy wdrażaniu — flota nie pobiera binarki w tej samej sekundzie. */
export const ROLLOUT_STAGGER_MS = 2000;
/** Opóźnienie aktualizacji po połączeniu nieaktualnego agenta (losowe — po awarii serwera nie wszystkie naraz). */
export const RECONNECT_UPDATE_DELAY = { minMs: 20_000, spreadMs: 40_000 };

export async function updateRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, hub, updates } = ctx;
  const manage = { preHandler: requireUser(ctx, 'agents.manage') };

  // ---------- dla agentów (uwierzytelnienie kluczem agenta) ----------

  app.get('/api/agent/update', async (req, reply) => {
    if (!agentFromRequest(db, req)) throw new HttpError(401, 'unauthorized');
    const { version, platform } = parse(OfferQuery, req.query);
    const rel = updates.offerFor(version, platform);
    if (!rel) return reply.code(204).send();
    return {
      version: rel.version,
      manifest: rel.manifestRaw.toString('base64'),
      signature: rel.signature.toString('base64'),
      download: `/api/agent/update/${encodeURIComponent(rel.version)}/${platform}`,
    };
  });

  app.get('/api/agent/update/:version/:platform', async (req, reply) => {
    if (!agentFromRequest(db, req)) throw new HttpError(401, 'unauthorized');
    const { version, platform } = parse(DownloadParams, req.params);
    const f = updates.filePath(version, platform);
    if (!f) throw new HttpError(404, 'not_found', 'Brak tej wersji.');
    reply.header('Content-Type', 'application/octet-stream').header('Content-Length', String(f.file.size)).header('Cache-Control', 'no-store');
    return reply.send(updates.stream(f.path));
  });

  // ---------- panel ----------

  /** Wysyła „sprawdź aktualizację” do włączonych, nieaktualnych komputerów — z odstępami. */
  const rollout = (ids?: string[]): number => {
    const target = updates.target();
    if (!target) return 0;
    const all = hub.listSummaries({ allClients: true, clientIds: [] });
    const due = all.filter(
      (a) => a.online && (!ids || ids.includes(a.id)) && a.capabilities.includes('update.check') && newerVersion(target.version, a.agentVersion),
    );
    due.forEach((a, i) =>
      setTimeout(() => hub.request(a.id, 'update.check', {}, { capability: 'update.check', timeoutMs: 5 * 60_000 }).catch(() => {}), i * ROLLOUT_STAGGER_MS).unref(),
    );
    return due.length;
  };
  ctx.rollout = rollout;

  // Komputer, który był offline w chwili wydania (albo wrócił po restarcie serwera), dostaje aktualizację
  // po połączeniu — inaczej czekałby do własnego sprawdzenia agenta (co kilka godzin).
  const pending = new Set<NodeJS.Timeout>();
  hub.on('ready', (id) => {
    const delay = RECONNECT_UPDATE_DELAY.minMs + Math.random() * RECONNECT_UPDATE_DELAY.spreadMs;
    const t = setTimeout(() => {
      pending.delete(t);
      try {
        rollout([id]);
      } catch (err) {
        app.log.warn(`aktualizacja po połączeniu: ${(err as Error).message}`);
      }
    }, delay);
    t.unref();
    pending.add(t);
  });
  app.addHook('onClose', async () => {
    for (const t of pending) clearTimeout(t);
    pending.clear();
  });

  app.get('/api/updates', manage, async (req) => {
    requireGlobal(req);
    const target = updates.target();
    const latest = updates.latest();
    const agents = hub.listSummaries({ allClients: true, clientIds: [] });
    const byVersion = new Map<string, { version: string; count: number; online: number }>();
    for (const a of agents) {
      const v = a.agentVersion || '?';
      const e = byVersion.get(v) ?? { version: v, count: 0, online: 0 };
      e.count++;
      if (a.online) e.online++;
      byVersion.set(v, e);
    }
    return {
      policy: updates.policy(),
      target: target?.version ?? null,
      latest: latest?.version ?? null,
      releases: updates.versions().map((v) => {
        const r = updates.get(v)!;
        return { version: v, created: r.manifest.created ?? null, platforms: Object.keys(r.manifest.files).sort() };
      }),
      source: { configured: !!ctx.config.github, repo: ctx.config.github?.repo ?? null, lastCheck: updates.lastCheck, lastError: updates.lastError },
      agents: [...byVersion.values()].sort((a, b) => (newerVersion(a.version, b.version) ? -1 : 1)),
      outdated: target ? agents.filter((a) => a.agentVersion && newerVersion(target.version, a.agentVersion)).length : 0,
    };
  });

  app.post('/api/updates/check', manage, async (req) => {
    requireGlobal(req);
    if (!ctx.config.github) throw new HttpError(409, 'not_configured', 'Nie skonfigurowano źródła wydań (GITHUB_REPO, GITHUB_TOKEN).');
    let added: string | null;
    try {
      added = await updates.syncFromGitHub(ctx.config.github);
    } catch (err) {
      throw new HttpError(502, 'github_error', `Nie udało się sprawdzić wydań: ${(err as Error).message}`);
    }
    audit(db, actorOf(req), 'update.check', null, { added }, req.ip);
    const queued = added && updates.policy() === 'auto' ? rollout() : 0;
    return { added, latest: updates.latest()?.version ?? null, queued };
  });

  app.put('/api/updates/policy', manage, async (req) => {
    requireGlobal(req);
    const { policy } = parse(PolicyBody, req.body);
    updates.setPolicy(policy);
    audit(db, actorOf(req), 'update.policy', null, { policy }, req.ip);
    return { policy };
  });

  app.post('/api/updates/approve', manage, async (req) => {
    requireGlobal(req);
    const { version } = parse(ApproveBody, req.body);
    if (updates.policy() !== 'manual') throw new HttpError(409, 'policy_auto', 'W trybie automatycznym wdrażana jest zawsze najnowsza wersja.');
    try {
      updates.approve(version);
    } catch {
      throw new HttpError(404, 'not_found', 'Brak takiego wydania na serwerze.');
    }
    const queued = rollout();
    audit(db, actorOf(req), 'update.approve', null, { version, queued }, req.ip);
    return { target: version, queued };
  });

  app.post('/api/updates/rollout', manage, async (req) => {
    requireGlobal(req);
    const queued = rollout();
    audit(db, actorOf(req), 'update.rollout', null, { target: updates.target()?.version, queued }, req.ip);
    return { queued };
  });

  app.post('/api/agents/:id/update', manage, async (req) => {
    const { id } = parse(IdParams, req.params);
    assertAgentAccess(db, req.user!, id);
    const r = await hub.request<{ status: string; version: string }>(id, 'update.check', {}, { capability: 'update.check', timeoutMs: 5 * 60_000 });
    audit(db, actorOf(req), 'agent.upgrade', id, r, req.ip);
    return r;
  });
}
