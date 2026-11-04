import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.ts';
import { audit } from '../db.ts';
import { HttpError } from '../errors.ts';
import { agentFromRequest, userFromRequest } from '../auth.ts';

export async function wsRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, hub } = ctx;

  // agent: uwierzytelnienie przed upgrade'em — zły sekret dostaje zwykłe 401
  app.get(
    '/ws/agent',
    {
      websocket: true,
      preValidation: async (req) => {
        if (!agentFromRequest(db, req)) {
          audit(db, 'system', 'agent.auth_failed', null, null, req.ip);
          throw new HttpError(401, 'unauthorized');
        }
      },
    },
    (socket, req) => hub.attachAgent(agentFromRequest(db, req)!, socket, req.ip),
  );

  // panel: sesja z ciasteczka + ochrona przed cross-site WebSocket hijacking
  app.get(
    '/ws/panel',
    {
      websocket: true,
      preValidation: async (req) => {
        const origin = req.headers.origin;
        if (origin) {
          let host: string | null = null;
          try {
            host = new URL(origin).host;
          } catch {
            /* nieprawidłowy Origin */
          }
          if (host !== req.headers.host) throw new HttpError(403, 'bad_origin');
        }
        const user = userFromRequest(ctx, req);
        if (!user) throw new HttpError(401, 'unauthorized');
        if (user.restriction) throw new HttpError(403, user.restriction);
        req.user = user;
      },
    },
    (socket, req) => hub.attachPanel(socket, req.user!.id, req.user!),
  );
}
