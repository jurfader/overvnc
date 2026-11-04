import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import type { Config } from './config.ts';
import type { Ctx } from './context.ts';
import type { Db } from './db.ts';
import { errorHandler } from './errors.ts';
import { Hub } from './hub.ts';
import { RateLimiter } from './ratelimit.ts';
import { authRoutes } from './routes/auth.ts';
import { agentRoutes } from './routes/agents.ts';
import { tokenRoutes } from './routes/tokens.ts';
import { auditRoutes } from './routes/audit.ts';
import { wsRoutes } from './routes/ws.ts';
import { userRoutes } from './routes/users.ts';
import { clientRoutes } from './routes/clients.ts';
import { remoteRoutes } from './routes/remote.ts';
import { terminalRoutes } from './routes/terminal.ts';
import { fileRoutes } from './routes/files.ts';
import { updateRoutes } from './routes/updates.ts';
import { UpdateStore } from './updates.ts';
import { loadOrCreateKey } from './crypto.ts';

const CSP = [
  "default-src 'self'",
  "connect-src 'self' ws: wss:",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

/** Buduje kompletną aplikację bez nasłuchiwania na porcie (testy używają app.inject / listen na porcie 0). */
export async function buildApp(config: Config, db: Db): Promise<{ app: FastifyInstance; ctx: Ctx }> {
  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel },
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
  });

  const hub = new Hub(db);
  const ctx: Ctx = {
    config,
    db,
    hub,
    secretKey: loadOrCreateKey(config.keyFile),
    updates: new UpdateStore(db, config.updatesDir, config.releasePublicKey),
    limits: {
      login: new RateLimiter(10, 15 * 60 * 1000), // 10 prób / 15 min / IP
      enroll: new RateLimiter(20, 15 * 60 * 1000),
    },
  };
  // co 15 min sprawdzamy GitHuba; nowe wydanie w trybie automatycznym od razu trafia do komputerów
  let poll: NodeJS.Timeout | undefined;
  if (config.github) {
    const check = () =>
      ctx.updates.syncFromGitHub(config.github!).then(
        (added) => {
          if (added) app.log.info(`nowe wydanie agenta: ${added}`);
          if (added && ctx.updates.policy() === 'auto') ctx.rollout?.();
        },
        (err) => app.log.warn(`sprawdzanie wydań na GitHubie: ${(err as Error).message}`),
      );
    setTimeout(check, 10_000).unref();
    poll = setInterval(check, 15 * 60_000);
    poll.unref();
  }
  app.addHook('onClose', async () => {
    clearInterval(poll);
    hub.close();
    ctx.limits.login.close();
    ctx.limits.enroll.close();
  });

  app.setErrorHandler(errorHandler);
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', CSP);
  });

  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 16 * 1024 * 1024 } });

  await authRoutes(app, ctx);
  await agentRoutes(app, ctx);
  await tokenRoutes(app, ctx);
  await auditRoutes(app, ctx);
  await userRoutes(app, ctx);
  await clientRoutes(app, ctx);
  await remoteRoutes(app, ctx);
  await fileRoutes(app, ctx);
  await updateRoutes(app, ctx);
  await wsRoutes(app, ctx);
  await terminalRoutes(app, ctx);

  if (config.panelDir && existsSync(config.panelDir)) {
    // bez wildcard:false — pliki są serwowane dynamicznie, więc przebudowa panelu nie wymaga restartu
    await app.register(fastifyStatic, { root: config.panelDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/ws/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not_found', message: 'Nie znaleziono.' });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found', message: 'Nie znaleziono.' }));
    if (config.panelDir) app.log.warn(`Brak zbudowanego panelu w ${config.panelDir} — uruchom "npm run build" w katalogu panel/.`);
  }

  return { app, ctx };
}
