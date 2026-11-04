import { useEffect, useState, type FormEvent } from 'react';
import { KeyRound, Lock, LockOpen, Pencil, ShieldOff, Trash2, UserPlus, Users } from 'lucide-react';
import { api, errorMessage, ROLE_HINTS, ROLE_LABELS, type Role, type TeamMember } from '../api.ts';
import { Badge, Button, EmptyState, Field, Modal, SecretBox, toast } from '../components.tsx';
import { ago } from '../format.ts';
import { useMe, useOrg } from '../state.tsx';

const ROLE_ORDER: Role[] = ['owner', 'admin', 'tech', 'viewer'];
const ROLE_BADGE: Record<Role, 'brand' | 'info' | 'success' | 'neutral'> = { owner: 'brand', admin: 'info', tech: 'success', viewer: 'neutral' };

type Dialog =
  | { kind: 'edit'; member: TeamMember | null }
  | { kind: 'password'; username: string; password: string }
  | { kind: 'confirm'; title: string; text: string; action: string; danger?: boolean; run: () => Promise<void> };

export function Team() {
  const { me } = useMe();
  const { clients } = useOrg();
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const load = () => api.users().then(setMembers, (err) => toast(errorMessage(err), 'err'));
  useEffect(() => {
    void load();
  }, []);

  const scopeOf = (m: TeamMember) =>
    m.allClients
      ? 'Wszyscy klienci'
      : clients
          .filter((c) => m.clientIds.includes(c.id))
          .map((c) => c.name)
          .join(', ') || 'Brak klientów';

  /** Okno potwierdzenia; po sukcesie zamyka się, chyba że akcja otworzyła kolejne okno (np. hasło tymczasowe). */
  const act = (title: string, text: string, action: string, run: () => Promise<void>, danger = false) =>
    setDialog({
      kind: 'confirm',
      title,
      text,
      action,
      danger,
      run: async () => {
        await run();
        setDialog((d) => (d?.kind === 'confirm' ? null : d));
      },
    });

  return (
    <>
      <header className="page-head anim-rise">
        <div>
          <h1>Zespół</h1>
          <div className="sub">Konta osób z dostępem do panelu, ich role i zakres klientów</div>
        </div>
        <Button variant="primary" icon={UserPlus} onClick={() => setDialog({ kind: 'edit', member: null })}>
          Dodaj osobę
        </Button>
      </header>

      {members && members.length === 0 ? (
        <EmptyState icon={Users} title="Brak kont" />
      ) : (
        <div className="glass-card table-card anim-rise" style={{ animationDelay: '40ms' }}>
          <div className="table-scroll">
            <table className="table hover">
              <thead>
                <tr>
                  <th>Osoba</th>
                  <th>Rola</th>
                  <th>Dostęp do</th>
                  <th>Zabezpieczenia</th>
                  <th>Ostatnie logowanie</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(members ?? []).map((m) => {
                  const self = m.id === me.id;
                  return (
                    <tr key={m.id} style={m.disabled ? { opacity: 0.55 } : undefined}>
                      <td>
                        <div className="host">
                          <span className="avatar" style={{ width: 32, height: 32, fontSize: 11 }}>
                            {(m.displayName || m.username).slice(0, 2).toUpperCase()}
                          </span>
                          <div>
                            <div className="strong">
                              {m.displayName || m.username} {self && <span className="muted small">(Ty)</span>}
                            </div>
                            <div className="muted small">{m.username}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <Badge variant={ROLE_BADGE[m.role]}>{ROLE_LABELS[m.role]}</Badge>
                      </td>
                      <td className="small">{scopeOf(m)}</td>
                      <td>
                        <div className="member-meta">
                          {m.disabled && <Badge variant="danger">Zablokowane</Badge>}
                          {m.mfaEnabled ? <Badge variant="success">2FA</Badge> : <Badge variant="warning">bez 2FA</Badge>}
                          {m.mustChangePassword && <Badge>hasło tymczasowe</Badge>}
                        </div>
                      </td>
                      <td className="small ink-2">{m.lastLoginAt ? ago(m.lastLoginAt) : 'nigdy'}</td>
                      <td>
                        <div className="menu-actions">
                          <Button size="sm" variant="ghost" icon={Pencil} title="Edytuj" onClick={() => setDialog({ kind: 'edit', member: m })} />
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={KeyRound}
                            title="Resetuj hasło"
                            onClick={() =>
                              act('Zresetować hasło?', `Konto ${m.username} dostanie hasło tymczasowe, a wszystkie jego sesje zostaną zakończone.`, 'Resetuj hasło', async () => {
                                const { temporaryPassword } = await api.resetPassword(m.id);
                                setDialog({ kind: 'password', username: m.username, password: temporaryPassword });
                                void load();
                              })
                            }
                          />
                          {m.mfaEnabled && !self && (
                            <Button
                              size="sm"
                              variant="ghost"
                              icon={ShieldOff}
                              title="Resetuj 2FA"
                              onClick={() =>
                                act('Zresetować 2FA?', `Użyj, gdy właściciel konta ${m.username} nie ma dostępu do telefonu. Przy następnym logowaniu konfiguracja 2FA będzie wymagana od nowa.`, 'Resetuj 2FA', async () => {
                                  await api.reset2fa(m.id);
                                  toast('2FA zresetowane');
                                  void load();
                                })
                              }
                            />
                          )}
                          {!self && (
                            <Button
                              size="sm"
                              variant="ghost"
                              icon={m.disabled ? LockOpen : Lock}
                              title={m.disabled ? 'Odblokuj' : 'Zablokuj'}
                              onClick={() =>
                                m.disabled
                                  ? void api.updateUser(m.id, { disabled: false }).then(() => (toast('Konto odblokowane'), load()), (e) => toast(errorMessage(e), 'err'))
                                  : act('Zablokować konto?', `Wszystkie sesje konta ${m.username} zostaną natychmiast zakończone, a logowanie będzie niemożliwe do czasu odblokowania.`, 'Zablokuj', async () => {
                                      await api.updateUser(m.id, { disabled: true });
                                      toast('Konto zablokowane');
                                      void load();
                                    }, true)
                              }
                            />
                          )}
                          {!self && (
                            <Button
                              size="sm"
                              variant="ghost"
                              icon={Trash2}
                              title="Usuń"
                              onClick={() =>
                                act('Usunąć konto?', `Konto ${m.username} zostanie trwale usunięte. Wpisy w dzienniku zdarzeń pozostaną.`, 'Usuń konto', async () => {
                                  await api.deleteUser(m.id);
                                  toast('Konto usunięte');
                                  void load();
                                }, true)
                              }
                            />
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <MemberModal
        open={dialog?.kind === 'edit'}
        member={dialog?.kind === 'edit' ? dialog.member : null}
        onClose={() => setDialog(null)}
        onCreated={(username, password) => {
          setDialog({ kind: 'password', username, password });
          void load();
        }}
        onSaved={() => {
          setDialog(null);
          toast('Zapisano');
          void load();
        }}
      />

      <Modal open={dialog?.kind === 'password'} onClose={() => setDialog(null)}>
        {dialog?.kind === 'password' && (
          <>
            <h3>Hasło tymczasowe</h3>
            <p>
              Przekaż je właścicielowi konta <strong>{dialog.username}</strong> bezpiecznym kanałem. Przy pierwszym logowaniu trzeba będzie ustawić
              własne hasło (i skonfigurować 2FA, jeśli rola tego wymaga). Hasła nie da się wyświetlić ponownie.
            </p>
            <SecretBox lines={[dialog.password]} />
            <div className="okno-actions">
              <Button variant="primary" onClick={() => setDialog(null)}>
                Gotowe
              </Button>
            </div>
          </>
        )}
      </Modal>

      <ConfirmModal dialog={dialog?.kind === 'confirm' ? dialog : null} onClose={() => setDialog(null)} />
    </>
  );
}

function ConfirmModal({ dialog, onClose }: { dialog: Extract<Dialog, { kind: 'confirm' }> | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={!!dialog} onClose={onClose}>
      {dialog && (
        <>
          <h3>{dialog.title}</h3>
          <p>{dialog.text}</p>
          <div className="okno-actions">
            <Button variant="ghost" onClick={onClose}>
              Anuluj
            </Button>
            <Button
              variant={dialog.danger ? 'danger' : 'primary'}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await dialog.run();
                  // run może otworzyć kolejne okno (np. hasło tymczasowe) — wtedy go nie zamykamy
                } catch (err) {
                  toast(errorMessage(err), 'err');
                  onClose();
                } finally {
                  setBusy(false);
                }
              }}
            >
              {dialog.action}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

function MemberModal({
  open,
  member,
  onClose,
  onCreated,
  onSaved,
}: {
  open: boolean;
  member: TeamMember | null;
  onClose: () => void;
  onCreated: (username: string, password: string) => void;
  onSaved: () => void;
}) {
  const { clients } = useOrg();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<Role>('tech');
  const [allClients, setAllClients] = useState(true);
  const [clientIds, setClientIds] = useState<number[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setUsername(member?.username ?? '');
    setDisplayName(member?.displayName ?? '');
    setRole(member?.role ?? 'tech');
    setAllClients(member?.allClients ?? true);
    setClientIds(member?.clientIds ?? []);
    setError('');
  }, [open, member]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!allClients && clientIds.length === 0) return setError('Wybierz co najmniej jednego klienta albo dostęp do wszystkich.');
    setBusy(true);
    setError('');
    try {
      if (member) {
        await api.updateUser(member.id, { displayName, role, allClients, clientIds });
        onSaved();
      } else {
        const r = await api.createUser({ username: username.trim(), displayName, role, allClients, clientIds });
        onCreated(r.user.username, r.temporaryPassword);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} wide>
      <form onSubmit={submit}>
        <h3>{member ? `Edycja: ${member.username}` : 'Dodaj osobę do zespołu'}</h3>
        <div className="form-2">
          <Field label="Login" hint={member ? 'Loginu nie można zmienić.' : 'Litery, cyfry oraz . _ @ -'}>
            <input className="pole" value={username} onChange={(e) => setUsername(e.target.value)} disabled={!!member} required autoFocus={!member} />
          </Field>
          <Field label="Imię i nazwisko">
            <input className="pole" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="opcjonalnie" />
          </Field>
        </div>

        <Field label="Rola">
          <div className="choice-list">
            {ROLE_ORDER.map((r) => (
              <label key={r} className={`choice ${role === r ? 'on' : ''}`}>
                <input type="radio" name="role" checked={role === r} onChange={() => setRole(r)} />
                <span>
                  {ROLE_LABELS[r]}
                  <small>{ROLE_HINTS[r]}</small>
                </span>
              </label>
            ))}
          </div>
        </Field>

        <Field label="Dostęp do klientów">
          <div className="choice-list">
            <label className={`choice ${allClients ? 'on' : ''}`}>
              <input type="radio" name="scope" checked={allClients} onChange={() => setAllClients(true)} />
              <span>
                Wszyscy klienci<small>Także komputery bez przypisanego klienta.</small>
              </span>
            </label>
            <label className={`choice ${!allClients ? 'on' : ''}`}>
              <input type="radio" name="scope" checked={!allClients} onChange={() => setAllClients(false)} />
              <span>
                Tylko wybrani klienci<small>Pozostałe komputery będą dla tej osoby niewidoczne.</small>
              </span>
            </label>
          </div>
        </Field>
        {!allClients && (
          <div className="check-list">
            {clients.length === 0 && <span className="muted small" style={{ padding: 8 }}>Najpierw dodaj klientów w zakładce Klienci.</span>}
            {clients.map((c) => (
              <label key={c.id}>
                <input
                  type="checkbox"
                  className="cb"
                  checked={clientIds.includes(c.id)}
                  onChange={(e) => setClientIds(e.target.checked ? [...clientIds, c.id] : clientIds.filter((x) => x !== c.id))}
                />
                <span className="client-dot" style={{ background: c.color || 'rgb(var(--faint))' }} />
                {c.name}
              </label>
            ))}
          </div>
        )}

        {error && <div className="form-error">{error}</div>}
        <div className="okno-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            Anuluj
          </Button>
          <Button variant="primary" icon={member ? undefined : UserPlus} loading={busy}>
            {member ? 'Zapisz' : 'Utwórz konto'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
