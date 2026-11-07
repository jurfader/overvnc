import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { parse } from '../errors.ts';
import { requireUser } from '../auth.ts';
import { assertAgentAccess, scopeSql } from '../scope.ts';
import { CHAT_COLS } from '../chat.ts';

const IdParams = z.object({ id: z.uuid() });
const SendBody = z.object({ text: z.string().trim().min(1, 'Pusta wiadomość.').max(4000) });
const ListQuery = z.object({ before: z.coerce.number().int().positive().optional() });

export async function chatRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;
  const view = { preHandler: requireUser(ctx, 'agents.view') };
  // pisanie do użytkownika komputera = praca zdalna (technik), nie podgląd
  const remote = { preHandler: requireUser(ctx, 'agents.remote') };
  const access = (req: FastifyRequest) => {
    const { id } = parse(IdParams, req.params);
    assertAgentAccess(db, req.user!, id);
    return id;
  };

  app.get('/api/agents/:id/chat', view, async (req) => {
    const id = access(req);
    const q = parse(ListQuery, req.query);
    const rows = db
      .prepare(`SELECT ${CHAT_COLS} FROM chat_messages WHERE agent_id = ?${q.before ? ' AND id < ?' : ''} ORDER BY id DESC LIMIT 100`)
      .all(...([id, q.before].filter((v) => v !== undefined) as (string | number)[]));
    return { items: rows.reverse() };
  });

  app.post('/api/agents/:id/chat', remote, async (req) => {
    const id = access(req);
    const { text } = parse(SendBody, req.body);
    const u = req.user!;
    return ctx.chat.send(id, u.displayName || u.username, u.id, text);
  });

  app.post('/api/agents/:id/chat/read', view, async (req) => {
    const id = access(req);
    db.prepare("UPDATE chat_messages SET read_at = ? WHERE agent_id = ? AND direction = 'in' AND read_at IS NULL").run(Date.now(), id);
    ctx.hub.broadcastAgent(id, { type: 'chat_read', id });
    return { ok: true };
  });

  // nieprzeczytane wiadomości od użytkowników (licznik na liście komputerów)
  app.get('/api/chat/unread', view, async (req) => {
    const where = scopeSql(req.user!, 'a.client_id');
    return db
      .prepare(
        `SELECT m.agent_id AS agentId, COUNT(*) AS count, MAX(m.ts) AS lastTs FROM chat_messages m JOIN agents a ON a.id = m.agent_id
         WHERE m.direction = 'in' AND m.read_at IS NULL AND ${where.sql} GROUP BY m.agent_id`,
      )
      .all(...where.params);
  });
}
