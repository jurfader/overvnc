import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, openSync, closeSync, readdirSync, rmSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { audit } from '../db.ts';
import { HttpError, notFound, parse } from '../errors.ts';
import { actorOf, agentFromRequest, requireUser } from '../auth.ts';
import { canSeeOwned } from './scripts.ts';

/**
 * Pliki do wdrażania (instalatory, konfiguracje). Wysyłanie kawałkami po 8 MB — mieści się w limicie
 * Cloudflare (100 MB na żądanie) i można je wznowić. Agent pobiera plik tylko wtedy, gdy ma
 * oczekujące zadanie „Wdrożenie” z tym plikiem.
 */

export const CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_PACKAGE = 4 * 1024 * 1024 * 1024;
const STALE_UPLOAD_MS = 24 * 3600_000;

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const CreateBody = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((n) => !/[\\/:*?"<>|\x00-\x1f]/.test(n) && n !== '.' && n !== '..', 'Nazwa pliku zawiera niedozwolone znaki.'),
  size: z.number().int().min(1).max(MAX_PACKAGE, 'Plik może mieć najwyżej 4 GB.'),
  description: z.string().trim().max(500).default(''),
  clientId: z.number().int().positive().nullable().default(null),
});
const ChunkQuery = z.object({ offset: z.coerce.number().int().min(0) });

export interface PackageRow {
  id: number;
  name: string;
  description: string;
  size: number;
  received: number;
  sha256: string | null;
  client_id: number | null;
  created_by: string;
  created_at: number;
  completed_at: number | null;
}

export function packageDto(r: PackageRow) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    size: r.size,
    received: r.received,
    sha256: r.sha256,
    ready: r.completed_at !== null,
    clientId: r.client_id,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

function readBody(req: FastifyRequest, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let n = 0;
    req.raw.on('data', (c: Buffer) => {
      n += c.length;
      if (n > limit) {
        req.raw.destroy();
        reject(new HttpError(413, 'too_large', 'Za duży kawałek pliku.'));
        return;
      }
      parts.push(c);
    });
    req.raw.on('end', () => resolve(Buffer.concat(parts)));
    req.raw.on('error', reject);
  });
}

function sha256File(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(p)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

export async function packageRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, config } = ctx;
  const dir = config.packagesDir;
  mkdirSync(dir, { recursive: true });
  const fileOf = (id: number) => path.join(dir, `${id}.bin`);
  const remote = { preHandler: requireUser(ctx, 'agents.remote') };

  // porządki po starcie: przerwane wysyłanie sprzed doby i pliki bez wpisu w bazie
  const cleanup = () => {
    const stale = db.prepare('SELECT id FROM packages WHERE completed_at IS NULL AND created_at < ?').all(Date.now() - STALE_UPLOAD_MS) as { id: number }[];
    for (const r of stale) {
      db.prepare('DELETE FROM packages WHERE id = ?').run(r.id);
      rmSync(fileOf(r.id), { force: true });
    }
    const known = new Set((db.prepare('SELECT id FROM packages').all() as { id: number }[]).map((r) => `${r.id}.bin`));
    for (const f of readdirSync(dir)) if (!known.has(f)) rmSync(path.join(dir, f), { force: true });
  };
  cleanup();
  const cleanupTimer = setInterval(cleanup, 6 * 3600_000);
  cleanupTimer.unref();
  app.addHook('onClose', async () => clearInterval(cleanupTimer));

  const visible = (req: FastifyRequest, id: number): PackageRow => {
    const r = db.prepare('SELECT * FROM packages WHERE id = ?').get(id) as PackageRow | undefined;
    if (!r || !canSeeOwned(req.user!, r.client_id)) throw notFound();
    return r;
  };

  app.get('/api/packages', remote, async (req) =>
    (db.prepare('SELECT * FROM packages ORDER BY created_at DESC').all() as unknown as PackageRow[]).filter((r) => canSeeOwned(req.user!, r.client_id)).map(packageDto),
  );

  app.post('/api/packages', remote, async (req) => {
    const b = parse(CreateBody, req.body);
    if (b.clientId !== null && !db.prepare('SELECT 1 FROM clients WHERE id = ?').get(b.clientId)) throw new HttpError(400, 'validation', 'Nieznany klient.');
    if (!canSeeOwned(req.user!, b.clientId)) throw new HttpError(403, 'forbidden', b.clientId === null ? 'Wybierz klienta.' : 'Brak dostępu do tego klienta.');
    const r = db
      .prepare('INSERT INTO packages (name, description, size, client_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(b.name, b.description, b.size, b.clientId, req.user!.username, Date.now());
    const id = Number(r.lastInsertRowid);
    closeSync(openSync(fileOf(id), 'w'));
    return { ...packageDto(visible(req, id)), chunkSize: CHUNK_BYTES };
  });

  // kolejny kawałek pliku; offset musi być równy liczbie już odebranych bajtów (wznawianie po przerwie)
  app.put('/api/packages/:id/data', remote, async (req) => {
    const { id } = parse(IdParams, req.params);
    const { offset } = parse(ChunkQuery, req.query);
    const p = visible(req, id);
    if (p.completed_at) throw new HttpError(409, 'complete', 'Plik jest już wysłany.');
    if (offset !== p.received) throw new HttpError(409, 'offset', 'Nieprawidłowe miejsce wznowienia.', { received: p.received });
    const data = await readBody(req, Math.min(CHUNK_BYTES, p.size - p.received));
    if (data.length === 0) throw new HttpError(400, 'empty', 'Pusty kawałek pliku.');
    const fd = openSync(fileOf(id), 'r+');
    try {
      writeSync(fd, data, 0, data.length, offset);
    } finally {
      closeSync(fd);
    }
    const received = offset + data.length;
    db.prepare('UPDATE packages SET received = ? WHERE id = ?').run(received, id);
    if (received === p.size) {
      const sum = await sha256File(fileOf(id));
      db.prepare('UPDATE packages SET sha256 = ?, completed_at = ? WHERE id = ?').run(sum, Date.now(), id);
      audit(db, actorOf(req), 'package.upload', p.name, { id, size: p.size, sha256: sum, clientId: p.client_id }, req.ip);
    }
    return packageDto(visible(req, id));
  });

  app.delete('/api/packages/:id', remote, async (req) => {
    const { id } = parse(IdParams, req.params);
    const p = visible(req, id);
    const busy = db
      .prepare(
        `SELECT COUNT(*) AS n FROM job_targets t JOIN jobs j ON j.id = t.job_id
         WHERE j.kind = 'deploy' AND json_extract(j.params_json, '$.packageId') = ? AND t.status IN ('queued', 'running')`,
      )
      .get(id) as { n: number };
    if (busy.n > 0) throw new HttpError(409, 'in_use', 'Plik jest właśnie wdrażany — poczekaj na koniec zadania albo je anuluj.');
    db.prepare('DELETE FROM packages WHERE id = ?').run(id);
    rmSync(fileOf(id), { force: true });
    audit(db, actorOf(req), 'package.delete', p.name, { id }, req.ip);
    return { ok: true };
  });

  // ---------- pobieranie przez agenta (klucz agenta + oczekujące zadanie z tym plikiem) ----------

  app.get('/api/agent/packages/:id', async (req, reply) => {
    const agentId = agentFromRequest(db, req);
    if (!agentId) throw new HttpError(401, 'unauthorized');
    const { id } = parse(IdParams, req.params);
    const allowed = db
      .prepare(
        `SELECT 1 FROM job_targets t JOIN jobs j ON j.id = t.job_id
         WHERE t.agent_id = ? AND j.kind = 'deploy' AND json_extract(j.params_json, '$.packageId') = ? AND t.status IN ('queued', 'running')`,
      )
      .get(agentId, id);
    const p = db.prepare('SELECT * FROM packages WHERE id = ?').get(id) as PackageRow | undefined;
    if (!allowed || !p || !p.completed_at || !existsSync(fileOf(id))) throw new HttpError(403, 'forbidden', 'Plik nie jest przeznaczony dla tego komputera.');
    const size = statSync(fileOf(id)).size;
    reply.header('Content-Type', 'application/octet-stream').header('Cache-Control', 'no-store').header('Accept-Ranges', 'bytes');
    const m = /^bytes=(\d+)-$/.exec(String(req.headers.range ?? ''));
    if (m && Number(m[1]) < size) {
      const start = Number(m[1]);
      reply.code(206).header('Content-Range', `bytes ${start}-${size - 1}/${size}`).header('Content-Length', String(size - start));
      return reply.send(createReadStream(fileOf(id), { start }));
    }
    reply.header('Content-Length', String(size));
    return reply.send(createReadStream(fileOf(id)));
  });
}
