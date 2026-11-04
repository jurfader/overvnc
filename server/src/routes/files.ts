import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { audit } from '../db.ts';
import { HttpError, parse } from '../errors.ts';
import { actorOf, requireUser } from '../auth.ts';
import { assertAgentAccess } from '../scope.ts';
import type { ChannelSink } from '../hub.ts';

const CHUNK = 64 * 1024;
/** Maks. bajtów wysłanych do agenta bez potwierdzenia zapisu (agent ma kolejkę 4 MB). */
const UPLOAD_WINDOW = 2 * 1024 * 1024;

const Path = z.string().min(1).max(4096);
const IdParams = z.object({ id: z.uuid() });
const PathQuery = z.object({ path: Path });
const DownloadQuery = z.object({ path: Path, zip: z.enum(['0', '1']).default('0') });
const UploadQuery = z.object({
  dir: Path,
  name: z
    .string()
    .min(1)
    .max(255)
    .refine((n) => !/[\\/\0]/.test(n) && n !== '.' && n !== '..', 'Nieprawidłowa nazwa pliku.'),
  overwrite: z.enum(['0', '1']).default('0'),
});
const MkdirBody = z.object({ path: Path });
const RenameBody = z.object({ from: Path, to: Path });
const DeleteBody = z.object({ paths: z.array(Path).min(1).max(1000) });
const TextBody = z.object({ path: Path, content: z.string().max(1024 * 1024), expectedModified: z.number().int().nonnegative().default(0) });

/** Content-Disposition z polską nazwą (RFC 6266/5987) i bezpiecznym zapasowym ASCII. */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/ł/g, 'l').replace(/Ł/g, 'L').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function fileRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, hub, config } = ctx;
  const remote = { preHandler: requireUser(ctx, 'agents.remote') };

  // treść wysyłanego pliku czytamy strumieniowo sami — Fastify nie buforuje jej w pamięci
  app.addContentTypeParser('application/octet-stream', (_req, _payload, done) => done(null));

  const access = (req: FastifyRequest) => {
    const { id } = parse(IdParams, req.params);
    assertAgentAccess(db, req.user!, id);
    return id;
  };
  const ask = <T>(id: string, cmd: string, data: unknown, timeoutMs = 30_000) => hub.request<T>(id, cmd, data, { capability: cmd, timeoutMs });

  // ---------- przeglądanie i operacje ----------

  app.get('/api/agents/:id/files/roots', remote, async (req) => ask(access(req), 'fs.roots', undefined));

  app.get('/api/agents/:id/files', remote, async (req) => {
    const id = access(req);
    const { path } = parse(PathQuery, req.query);
    return ask(id, 'fs.list', { path });
  });

  app.post('/api/agents/:id/files/mkdir', remote, async (req) => {
    const id = access(req);
    const { path } = parse(MkdirBody, req.body);
    const r = await ask(id, 'fs.mkdir', { path });
    audit(db, actorOf(req), 'fs.mkdir', id, { path }, req.ip);
    return r;
  });

  app.post('/api/agents/:id/files/rename', remote, async (req) => {
    const id = access(req);
    const body = parse(RenameBody, req.body);
    const r = await ask(id, 'fs.rename', body);
    audit(db, actorOf(req), 'fs.rename', id, body, req.ip);
    return r;
  });

  app.post('/api/agents/:id/files/delete', remote, async (req) => {
    const id = access(req);
    const { paths } = parse(DeleteBody, req.body);
    // dziennik przed operacją — nawet przy częściowym błędzie wiemy, co próbowano usunąć
    audit(db, actorOf(req), 'fs.delete', id, { count: paths.length, paths: paths.slice(0, 20) }, req.ip);
    return ask(id, 'fs.delete', { paths }, 120_000);
  });

  app.get('/api/agents/:id/files/text', remote, async (req) => {
    const id = access(req);
    const { path } = parse(PathQuery, req.query);
    return ask(id, 'fs.readText', { path });
  });

  app.put('/api/agents/:id/files/text', { ...remote, bodyLimit: 3 * 1024 * 1024 }, async (req) => {
    const id = access(req);
    const body = parse(TextBody, req.body);
    const r = await ask(id, 'fs.writeText', body);
    audit(db, actorOf(req), 'fs.edit', id, { path: body.path, bytes: Buffer.byteLength(body.content) }, req.ip);
    return r;
  });

  // ---------- pobieranie (strumień agent -> przeglądarka) ----------

  app.get('/api/agents/:id/files/download', remote, async (req, reply) => {
    const id = access(req);
    const { path, zip } = parse(DownloadQuery, req.query);
    const raw = reply.raw;
    let channel = 0;
    let headersSent = false;
    let finished = false;
    let bytes = 0;
    const early: Buffer[] = [];
    let earlyClose: Parameters<ChannelSink['onClose']>[0] | null = null;

    const write = (p: Buffer) => {
      bytes += p.length;
      // potwierdzenie dopiero, gdy Node przekazał dane do gniazda przeglądarki — wolna przeglądarka spowalnia agenta
      raw.write(p, () => hub.sendAck(id, channel, p.length));
    };
    const finish = (info: Parameters<ChannelSink['onClose']>[0]) => {
      if (finished) return;
      finished = true;
      if (info.reason === 'exited' && info.exitCode === 0) raw.end();
      else raw.destroy(new Error(info.error ?? 'przerwano'));
      audit(db, actorOf(req), 'fs.download', id, { path, zip: zip === '1', bytes, ok: info.exitCode === 0 }, req.ip);
    };

    const opened = await hub.openChannel<{ name: string; size: number }>(id, 'fs.read', { path, zip: zip === '1' }, {
      // dane mogą przyjść przed odpowiedzią na fs.read — buforujemy do wysłania nagłówków (najwyżej okno agenta, 2 MB)
      onData: (p) => (headersSent ? write(p) : early.push(p)),
      onClose: (info) => (headersSent ? finish(info) : (earlyClose = info)),
    });
    channel = opened.channel;

    reply.hijack();
    raw.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': contentDisposition(opened.result.name),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(opened.result.size >= 0 ? { 'Content-Length': String(opened.result.size) } : {}),
    });
    headersSent = true;
    for (const p of early.splice(0)) write(p);
    if (earlyClose) finish(earlyClose);

    // przeglądarka anulowała pobieranie — agent przestaje czytać plik
    raw.on('close', () => {
      if (finished) return;
      finished = true;
      hub.closeChannel(id, channel);
      audit(db, actorOf(req), 'fs.download', id, { path, zip: zip === '1', bytes, ok: false, cancelled: true }, req.ip);
    });
  });

  // ---------- wysyłanie (strumień przeglądarka -> agent) ----------

  app.post('/api/agents/:id/files/upload', remote, async (req) => {
    const id = access(req);
    const q = parse(UploadQuery, req.query);
    const size = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(411, 'length_required', 'Brak rozmiaru pliku (Content-Length).');
    if (size > config.maxUploadBytes) {
      throw new HttpError(413, 'too_large', `Plik jest za duży (limit ${Math.round(config.maxUploadBytes / 1024 ** 3)} GB).`);
    }
    const stream = req.raw;

    return new Promise((resolve, reject) => {
      let channel = 0;
      let inflight = 0;
      let sent = 0;
      let paused = false;
      let settled = false;

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        if (channel) hub.closeChannel(id, channel);
        stream.pause();
        audit(db, actorOf(req), 'fs.upload', id, { dir: q.dir, name: q.name, size, ok: false, error: err.message }, req.ip);
        reject(err);
      };

      hub
        .openChannel(id, 'fs.write', { dir: q.dir, name: q.name, size, overwrite: q.overwrite === '1' }, {
          onData: () => {},
          onAck: (n) => {
            inflight -= n;
            if (paused && inflight < UPLOAD_WINDOW / 2) {
              paused = false;
              stream.resume();
            }
          },
          onClose: (info) => {
            if (!settled) fail(new HttpError(422, 'write_failed', info.error ? `Zapis na komputerze nie powiódł się: ${info.error}` : 'Komputer przerwał zapis.'));
          },
        })
        .then(({ channel: ch }) => {
          channel = ch;
          stream.on('data', (chunk: Buffer) => {
            if (settled) return;
            for (let off = 0; off < chunk.length; off += CHUNK) {
              const part = chunk.subarray(off, off + CHUNK);
              if (!hub.sendChannelData(id, ch, part)) return fail(new HttpError(502, 'agent_disconnected', 'Komputer rozłączył się w trakcie wysyłania.'));
              inflight += part.length;
            }
            sent += chunk.length;
            if (sent > size) return fail(new HttpError(400, 'size_mismatch', 'Otrzymano więcej danych niż zapowiedziano.'));
            if (inflight >= UPLOAD_WINDOW && !paused) {
              paused = true;
              stream.pause();
            }
          });
          stream.on('end', () => {
            if (settled) return;
            if (sent !== size) return fail(new HttpError(400, 'size_mismatch', 'Przesyłanie przerwane — niekompletny plik.'));
            hub
              .request<{ path: string; size: number }>(id, 'fs.commit', { channel: ch, size }, { timeoutMs: 180_000 })
              .then((r) => {
                if (settled) return;
                settled = true;
                audit(db, actorOf(req), 'fs.upload', id, { path: r.path, size, ok: true }, req.ip);
                resolve(r);
              }, fail);
          });
          stream.on('aborted', () => fail(new HttpError(400, 'aborted', 'Przesyłanie anulowane.')));
          stream.on('error', (e) => fail(e));
          stream.resume();
        }, fail);
    });
  });
}
