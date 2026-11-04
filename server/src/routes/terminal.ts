import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { audit } from '../db.ts';
import { HttpError, parse } from '../errors.ts';
import { userFromRequest } from '../auth.ts';
import { can } from '../permissions.ts';
import { assertAgentAccess } from '../scope.ts';
import { checkOrigin } from './ws.ts';

const Params = z.object({ id: z.uuid() });
const Query = z.object({
  shell: z.string().regex(/^[a-z]{1,20}$/).optional(),
  cols: z.coerce.number().int().min(10).max(500).default(120),
  rows: z.coerce.number().int().min(5).max(300).default(32),
});
const ResizeMsg = z.object({ type: z.literal('resize'), cols: z.number().int().min(10).max(500), rows: z.number().int().min(5).max(300) });

/** Zamknięcie z powodem — panel pokazuje odpowiedni komunikat. */
export const TERM_CLOSE = {
  exited: 4100, // powłoka zakończyła działanie
  idle: 4101, // bezczynność
  agentGone: 4102, // komputer się rozłączył
  overflow: 4103, // przeglądarka nie nadąża z odbiorem
  failed: 4400, // nie udało się otworzyć
} as const;

const IDLE_MS = 30 * 60 * 1000;
const MAX_BUFFERED = 8 * 1024 * 1024;

export async function terminalRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, hub } = ctx;
  // otwarte sesje — przy wyłączaniu serwera kończymy je i zapisujemy w dzienniku, ZANIM zamknie się baza
  const sessions = new Set<(reason: string) => void>();
  app.addHook('preClose', async () => {
    for (const finish of [...sessions]) finish('server_shutdown');
  });

  app.get(
    '/ws/term/:id',
    {
      websocket: true,
      preValidation: async (req) => {
        checkOrigin(req);
        const user = userFromRequest(ctx, req);
        if (!user) throw new HttpError(401, 'unauthorized');
        if (user.restriction) throw new HttpError(403, user.restriction);
        if (!can(user.role, 'agents.remote')) throw new HttpError(403, 'forbidden');
        const { id } = parse(Params, req.params);
        assertAgentAccess(db, user, id);
        if (!hub.isOnline(id)) throw new HttpError(409, 'agent_offline');
        req.user = user;
      },
    },
    (socket, req) => {
      const { id } = parse(Params, req.params);
      const q = parse(Query, req.query);
      const actor = `user:${req.user!.username}`;
      const started = Date.now();
      let channel: number | null = null;
      let bytesIn = 0;
      let bytesOut = 0;
      let ended = false;
      let idleTimer: NodeJS.Timeout;

      const end = (code: number, message: string) => {
        if (ended) return;
        ended = true;
        clearTimeout(idleTimer);
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: 'closed', message }));
          socket.close(code, message.slice(0, 120));
        }
      };
      const touch = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => end(TERM_CLOSE.idle, 'Sesja zamknięta po 30 minutach bezczynności.'), IDLE_MS);
      };
      touch();

      hub
        .openChannel<{ shell: string; pid: number }>(id, 'term.open', { cols: q.cols, rows: q.rows, shell: q.shell ?? '' }, {
          onData: (payload) => {
            bytesOut += payload.length;
            // przeglądarka nie odbiera (np. `cat` dużego pliku przy wolnym łączu) — przerywamy zamiast puchnąć w pamięci
            if (socket.bufferedAmount > MAX_BUFFERED) return end(TERM_CLOSE.overflow, 'Zbyt dużo danych — sesja przerwana.');
            socket.send(payload, { binary: true });
          },
          onClose: ({ reason, exitCode }) => {
            channel = null;
            if (reason === 'exited') end(TERM_CLOSE.exited, `Powłoka zakończyła działanie${exitCode !== undefined ? ` (kod ${exitCode})` : ''}.`);
            else end(TERM_CLOSE.agentGone, 'Komputer rozłączył się.');
          },
        })
        .then(({ channel: ch, result }) => {
          if (ended || socket.readyState !== socket.OPEN) return hub.closeChannel(id, ch);
          channel = ch;
          audit(db, actor, 'term.open', id, { shell: result.shell }, req.ip);
          socket.send(JSON.stringify({ type: 'ready', shell: result.shell }));
        })
        .catch((err: Error) => end(TERM_CLOSE.failed, err.message || 'Nie udało się otworzyć terminala.'));

      socket.on('message', (data, isBinary) => {
        if (channel === null) return;
        touch();
        if (isBinary) {
          const buf = data as Buffer;
          bytesIn += buf.length;
          hub.sendChannelData(id, channel, buf);
          return;
        }
        let msg: unknown;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        const resize = ResizeMsg.safeParse(msg);
        if (resize.success) hub.request(id, 'term.resize', { channel, cols: resize.data.cols, rows: resize.data.rows }).catch(() => {});
      });

      let finished = false;
      const finish = (reason?: string) => {
        if (finished) return;
        finished = true;
        sessions.delete(finish);
        ended = true;
        clearTimeout(idleTimer);
        if (channel !== null) hub.closeChannel(id, channel);
        audit(db, actor, 'term.close', id, { seconds: Math.round((Date.now() - started) / 1000), bytesIn, bytesOut, reason }, req.ip);
        if (reason && socket.readyState === socket.OPEN) socket.close(1001, 'Serwer jest restartowany.');
      };
      sessions.add(finish);
      socket.on('close', () => finish());
    },
  );
}
