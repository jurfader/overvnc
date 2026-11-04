import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { audit, tx } from '../db.ts';
import { hashPassword, randomToken } from '../crypto.ts';
import { HttpError, notFound, parse } from '../errors.ts';
import { actorOf, clientIdsOf, requireUser } from '../auth.ts';
import { ROLES, type Role } from '../permissions.ts';

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const Username = z
  .string()
  .trim()
  .min(3, 'Login musi mieć co najmniej 3 znaki.')
  .max(50)
  .regex(/^[a-zA-Z0-9._@-]+$/, 'Login może zawierać litery, cyfry oraz . _ @ -');
const ScopeFields = {
  allClients: z.boolean(),
  clientIds: z.array(z.number().int().positive()).max(1000),
};
const CreateBody = z.object({
  username: Username,
  displayName: z.string().trim().max(100).default(''),
  role: z.enum(ROLES),
  ...ScopeFields,
});
const PatchBody = z.object({
  displayName: z.string().trim().max(100).optional(),
  role: z.enum(ROLES).optional(),
  allClients: ScopeFields.allClients.optional(),
  clientIds: ScopeFields.clientIds.optional(),
  disabled: z.boolean().optional(),
});

interface UserListRow {
  id: number;
  username: string;
  display_name: string;
  role: Role;
  all_clients: number;
  disabled: number;
  must_change_password: number;
  totp_enabled: number;
  last_login_at: number | null;
  created_at: number;
}

/** Hasło tymczasowe: czytelne, bez łatwych do pomylenia znaków, ~80 bitów. */
function tempPassword(): string {
  return randomToken(10).replace(/[-_]/g, 'x');
}

export async function userRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, hub } = ctx;
  const owner = { preHandler: requireUser(ctx, 'team.manage') };

  const toDto = (r: UserListRow) => ({
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    role: r.role,
    allClients: !!r.all_clients,
    clientIds: r.all_clients ? [] : clientIdsOf(db, r.id),
    disabled: !!r.disabled,
    mustChangePassword: !!r.must_change_password,
    mfaEnabled: !!r.totp_enabled,
    lastLoginAt: r.last_login_at,
    createdAt: r.created_at,
  });

  const getRow = (id: number) => {
    const r = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserListRow | undefined;
    if (!r) throw notFound();
    return r;
  };

  /** Musi zostać co najmniej jeden aktywny właściciel — inaczej nikt nie zarządzi zespołem. */
  const assertOwnerRemains = (excludingId: number) => {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND disabled = 0 AND id != ?").get(excludingId) as { n: number };
    if (n === 0) throw new HttpError(409, 'last_owner', 'Musi pozostać co najmniej jeden aktywny właściciel.');
  };

  const assertClientsExist = (ids: number[]) => {
    if (ids.length === 0) return;
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM clients WHERE id IN (${ids.map(() => '?').join(',')})`).get(...ids) as { n: number };
    if (n !== new Set(ids).size) throw new HttpError(400, 'validation', 'Nieznany klient na liście.');
  };

  const setClients = (userId: number, allClients: boolean, clientIds: number[]) => {
    db.prepare('DELETE FROM user_clients WHERE user_id = ?').run(userId);
    if (allClients) return;
    const ins = db.prepare('INSERT INTO user_clients (user_id, client_id) VALUES (?, ?)');
    for (const c of new Set(clientIds)) ins.run(userId, c);
  };

  /** Wymusza ponowne zalogowanie i odświeżenie zakresu w panelu. */
  const kick = (userId: number) => {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    hub.disconnectPanelsOf(userId);
  };

  app.get('/api/users', owner, async () => {
    const rows = db.prepare('SELECT * FROM users ORDER BY role, username').all() as unknown as UserListRow[];
    return rows.map(toDto);
  });

  app.post('/api/users', owner, async (req) => {
    const body = parse(CreateBody, req.body);
    assertClientsExist(body.clientIds);
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(body.username)) {
      throw new HttpError(409, 'username_taken', 'Taki login już istnieje.');
    }
    const password = tempPassword();
    const hash = await hashPassword(password);
    const id = tx(db, () => {
      const res = db
        .prepare(
          'INSERT INTO users (username, display_name, password_hash, role, all_clients, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
        )
        .run(body.username, body.displayName, hash, body.role, body.allClients ? 1 : 0, Date.now());
      const newId = Number(res.lastInsertRowid);
      setClients(newId, body.allClients, body.clientIds);
      return newId;
    });
    audit(db, actorOf(req), 'user.create', body.username, { role: body.role, allClients: body.allClients, clientIds: body.clientIds }, req.ip);
    // hasło tymczasowe pokazujemy tylko raz — przy pierwszym logowaniu trzeba je zmienić
    return { user: toDto(getRow(id)), temporaryPassword: password };
  });

  app.patch('/api/users/:id', owner, async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(PatchBody, req.body);
    const cur = getRow(id);
    const self = id === req.user!.id;

    const losingOwner = cur.role === 'owner' && ((body.role && body.role !== 'owner') || body.disabled === true);
    if (losingOwner) assertOwnerRemains(id);
    if (self && body.disabled) throw new HttpError(409, 'self_disable', 'Nie możesz zablokować własnego konta.');
    if (body.clientIds) assertClientsExist(body.clientIds);

    const allClients = body.allClients ?? !!cur.all_clients;
    const scopeChanged = body.allClients !== undefined || body.clientIds !== undefined;
    tx(db, () => {
      db.prepare('UPDATE users SET display_name = ?, role = ?, all_clients = ?, disabled = ? WHERE id = ?').run(
        body.displayName ?? cur.display_name,
        body.role ?? cur.role,
        allClients ? 1 : 0,
        body.disabled === undefined ? cur.disabled : body.disabled ? 1 : 0,
        id,
      );
      if (scopeChanged) setClients(id, allClients, body.clientIds ?? clientIdsOf(db, id));
    });

    if (body.disabled) kick(id);
    else if (scopeChanged || (body.role && body.role !== cur.role)) hub.disconnectPanelsOf(id);
    audit(db, actorOf(req), 'user.update', cur.username, body, req.ip);
    return toDto(getRow(id));
  });

  app.post('/api/users/:id/reset-password', owner, async (req) => {
    const { id } = parse(IdParams, req.params);
    const cur = getRow(id);
    const password = tempPassword();
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(await hashPassword(password), id);
    kick(id);
    audit(db, actorOf(req), 'user.reset_password', cur.username, null, req.ip);
    return { temporaryPassword: password };
  });

  app.post('/api/users/:id/reset-2fa', owner, async (req) => {
    const { id } = parse(IdParams, req.params);
    const cur = getRow(id);
    db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = 0 WHERE id = ?').run(id);
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(id);
    kick(id);
    audit(db, actorOf(req), 'user.reset_2fa', cur.username, null, req.ip);
    return { ok: true };
  });

  app.delete('/api/users/:id', owner, async (req) => {
    const { id } = parse(IdParams, req.params);
    const cur = getRow(id);
    if (id === req.user!.id) throw new HttpError(409, 'self_delete', 'Nie możesz usunąć własnego konta.');
    if (cur.role === 'owner') assertOwnerRemains(id);
    hub.disconnectPanelsOf(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id); // sesje, przypisania i kody — kaskadowo
    audit(db, actorOf(req), 'user.delete', cur.username, null, req.ip);
    return { ok: true };
  });
}
