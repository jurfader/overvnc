import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { audit } from '../db.ts';
import { HttpError, parse } from '../errors.ts';
import { userFromRequest } from '../auth.ts';
import { can } from '../permissions.ts';
import { assertAgentAccess } from '../scope.ts';
import { checkOrigin } from './ws.ts';
import { TERM_CLOSE } from './terminal.ts';

const Params = z.object({ id: z.uuid() });
const Query = z.object({
  quality: z.enum(['low', 'medium', 'high']).default('medium'),
  monitor: z.coerce.number().int().min(0).max(31).optional(),
  viewOnly: z.enum(['0', '1']).default('0'),
});
/** Zdarzenia z przeglądarki — walidowane, zanim trafią do komputera. */
const Event = z.discriminatedUnion('t', [
  z.object({ t: z.literal('ack') }),
  z.object({ t: z.literal('m'), x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
  z.object({ t: z.literal('b'), x: z.number().min(0).max(1), y: z.number().min(0).max(1), b: z.number().int().min(0).max(2), d: z.boolean() }),
  z.object({ t: z.literal('w'), dy: z.number().int().min(-2400).max(2400) }),
  z.object({ t: z.literal('k'), code: z.string().regex(/^[A-Za-z0-9]{1,24}$/), d: z.boolean() }),
  z.object({
    t: z.literal('cfg'),
    quality: z.enum(['low', 'medium', 'high']).optional(),
    monitor: z.number().int().min(0).max(31).optional(),
    // kursor w obrazie: false — przeglądarka pokazuje własny (natychmiastowa reakcja na ruch myszy)
    cursor: z.boolean().optional(),
    // pierwszeństwo dla osoby przy komputerze: gdy używa myszy/klawiatury, zdalne sterowanie czeka
    yield: z.boolean().optional(),
  }),
  z.object({ t: z.literal('kf') }),
  // wklejenie: tekst do schowka komputera i Ctrl+V (to też wejście — w trybie podglądu zablokowane)
  z.object({ t: z.literal('clip'), text: z.string().min(1).max(100_000) }),
]);
const INPUT_TYPES = new Set(['m', 'b', 'w', 'k', 'clip']);
const IDLE_MS = 60 * 60 * 1000;
const MAX_EVENT_BYTES = 512 * 1024;
const MAX_BUFFERED = 16 * 1024 * 1024;

export async function desktopRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, hub } = ctx;
  const sessions = new Set<(reason: string) => void>();
  app.addHook('preClose', async () => {
    for (const finish of [...sessions]) finish('server_shutdown');
  });

  app.get(
    '/ws/desktop/:id',
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
      const viewOnly = q.viewOnly === '1';
      const user = req.user!;
      const actor = `user:${user.username}`;
      const started = Date.now();
      let channel: number | null = null;
      let frames = 0;
      let bytesOut = 0;
      let ended = false;
      let idleTimer: NodeJS.Timeout;

      // tryb zgody wynika z klienta komputera (ustawiany w panelu: Klienci)
      const consent =
        (
          db.prepare('SELECT c.consent_mode AS m FROM agents a LEFT JOIN clients c ON c.id = a.client_id WHERE a.id = ?').get(id) as
            | { m: string | null }
            | undefined
        )?.m ?? 'notify';

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
        idleTimer = setTimeout(() => end(TERM_CLOSE.idle, 'Sesja zamknięta po godzinie bezczynności.'), IDLE_MS);
      };
      touch();
      const keepAlive = setInterval(() => socket.readyState === socket.OPEN && socket.ping(), 30_000);

      socket.send(JSON.stringify({ type: 'connecting', consent }));
      hub
        .openChannel(
          id,
          'desktop.open',
          { quality: q.quality, monitor: q.monitor, consent, viewer: user.displayName || user.username, viewOnly },
          {
            onData: (payload) => {
              bytesOut += payload.length;
              if (payload[0] === 0x46) frames++; // 'F'
              if (socket.bufferedAmount > MAX_BUFFERED) return end(TERM_CLOSE.overflow, 'Przeglądarka nie nadąża — sesja przerwana.');
              socket.send(payload, { binary: true });
            },
            onClose: ({ reason, error }) => {
              channel = null;
              if (reason === 'exited') end(TERM_CLOSE.exited, error ? `Przechwytywanie ekranu zakończone: ${error}` : 'Sesja pulpitu zakończona.');
              else end(TERM_CLOSE.agentGone, 'Komputer rozłączył się.');
            },
          },
        )
        .then(({ channel: ch }) => {
          if (ended || socket.readyState !== socket.OPEN) return hub.closeChannel(id, ch);
          channel = ch;
          audit(db, actor, 'desktop.open', id, { viewOnly, consent, quality: q.quality }, req.ip);
          socket.send(JSON.stringify({ type: 'ready', viewOnly }));
        })
        .catch((err: Error & { code?: string }) =>
          end(TERM_CLOSE.failed, err.code === 'consent_denied' ? 'Użytkownik komputera nie zgodził się na połączenie.' : err.message || 'Nie udało się otworzyć pulpitu.'),
        );

      socket.on('message', (data, isBinary) => {
        // wklejany tekst do 100 000 znaków (UTF-8: do 4 bajtów na znak) + JSON
        if (channel === null || isBinary || (data as Buffer).length > MAX_EVENT_BYTES) return;
        let ev: z.infer<typeof Event>;
        try {
          const r = Event.safeParse(JSON.parse(data.toString()));
          if (!r.success) return;
          ev = r.data;
        } catch {
          return;
        }
        if (ev.t === 'ack') {
          // przeglądarka narysowała klatkę -> komputer może wysłać następną
          hub.sendAck(id, channel, 1);
          return;
        }
        if (INPUT_TYPES.has(ev.t)) {
          if (viewOnly) return; // tryb podglądu wymuszany na serwerze, nie tylko w panelu
          touch();
        }
        hub.sendChannelData(id, channel, Buffer.from(JSON.stringify(ev)));
      });

      let finished = false;
      const finish = (reason?: string) => {
        if (finished) return;
        finished = true;
        sessions.delete(finish);
        ended = true;
        clearTimeout(idleTimer);
        clearInterval(keepAlive);
        if (channel !== null) hub.closeChannel(id, channel);
        audit(db, actor, 'desktop.close', id, { seconds: Math.round((Date.now() - started) / 1000), frames, bytesOut, viewOnly, reason }, req.ip);
        if (reason && socket.readyState === socket.OPEN) socket.close(1001, 'Serwer jest restartowany.');
      };
      sessions.add(finish);
      socket.on('close', () => finish());
    },
  );
}
