import { useEffect, useState, type FormEvent } from 'react';
import { KeyRound, LogOut, Monitor, RefreshCw, ShieldCheck, ShieldOff, Smartphone, User } from 'lucide-react';
import { api, errorMessage, type SessionInfo } from '../api.ts';
import { Badge, Button, CardHead, Field, Modal, SecretBox, toast } from '../components.tsx';
import { ago, dateTime, plural } from '../format.ts';
import { useMe, useOrg } from '../state.tsx';
import { MfaSetupFlow, PasswordForm } from './security.tsx';

/** Krótki opis przeglądarki z User-Agent. */
function describeAgent(ua: string | null): string {
  if (!ua) return 'Nieznane urządzenie';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Przeglądarka';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} · ${os}` : browser;
}

export function Account() {
  const { me, reloadMe } = useMe();
  const { clients } = useOrg();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [mfaOpen, setMfaOpen] = useState(false);
  const [confirm, setConfirm] = useState<null | 'disable' | 'codes'>(null);

  const loadSessions = () => api.sessions().then(setSessions, () => {});
  useEffect(() => {
    void loadSessions();
  }, []);

  const scopeText = me.allClients
    ? 'Wszyscy klienci'
    : clients
        .filter((c) => me.clientIds.includes(c.id))
        .map((c) => c.name)
        .join(', ') || 'Brak przypisanych klientów';

  return (
    <>
      <header className="page-head anim-rise">
        <div>
          <h1>Moje konto</h1>
          <div className="sub">Profil, hasło, weryfikacja dwuetapowa i aktywne sesje</div>
        </div>
      </header>

      <section className="grid grid-2 anim-rise" style={{ animationDelay: '40ms' }}>
        <div className="glass-card card">
          <CardHead icon={User} title="Profil" />
          <dl className="props">
            <dt>Login</dt>
            <dd className="strong">{me.username}</dd>
            {me.displayName && (
              <>
                <dt>Imię i nazwisko</dt>
                <dd>{me.displayName}</dd>
              </>
            )}
            <dt>Rola</dt>
            <dd>
              <Badge variant="brand">{me.roleLabel}</Badge>
            </dd>
            <dt>Dostęp do</dt>
            <dd>{scopeText}</dd>
          </dl>
        </div>

        <div className="glass-card card">
          <CardHead icon={ShieldCheck} title="Weryfikacja dwuetapowa (2FA)" />
          <div className="setting-row">
            <div className="desc">
              <strong>Aplikacja uwierzytelniająca</strong>
              <span>{me.mfaEnabled ? 'Przy logowaniu wymagany jest kod z telefonu.' : 'Wyłączona — konto chroni tylko hasło.'}</span>
            </div>
            {me.mfaEnabled ? <Badge variant="success">Włączona</Badge> : <Button variant="primary" icon={Smartphone} onClick={() => setMfaOpen(true)}>Włącz</Button>}
          </div>
          {me.mfaEnabled && (
            <>
              <div className="setting-row">
                <div className="desc">
                  <strong>Kody zapasowe</strong>
                  <span>Pozostało {me.recoveryCodesLeft} z 10. Każdy działa jednorazowo.</span>
                </div>
                <Button icon={RefreshCw} onClick={() => setConfirm('codes')}>
                  Nowe kody
                </Button>
              </div>
              <div className="setting-row">
                <div className="desc">
                  <strong>Wyłączenie 2FA</strong>
                  <span>{me.mfaRequired ? `Twoja rola (${me.roleLabel}) wymaga 2FA.` : 'Niezalecane.'}</span>
                </div>
                <Button variant="danger" icon={ShieldOff} disabled={me.mfaRequired} onClick={() => setConfirm('disable')}>
                  Wyłącz
                </Button>
              </div>
            </>
          )}
        </div>
      </section>

      <section className="glass-card card anim-rise" style={{ animationDelay: '80ms' }}>
        <CardHead icon={KeyRound} title="Zmiana hasła" />
        <PasswordForm
          onDone={() => {
            toast('Hasło zmienione. Pozostałe sesje zostały wylogowane.');
            void loadSessions();
          }}
        />
      </section>

      <section className="glass-card table-card anim-rise" style={{ animationDelay: '120ms' }}>
        <div className="card" style={{ paddingBottom: 0 }}>
          <CardHead icon={Monitor} title="Aktywne sesje">
            {sessions.length > 1 && (
              <Button
                size="sm"
                variant="danger"
                icon={LogOut}
                onClick={async () => {
                  const { revoked } = await api.revokeOtherSessions();
                  toast(`Wylogowano ${revoked} ${plural(revoked, 'sesję', 'sesje', 'sesji')}`);
                  void loadSessions();
                }}
              >
                Wyloguj pozostałe
              </Button>
            )}
          </CardHead>
        </div>
        <div className="table-scroll">
          <table className="table hover">
            <thead>
              <tr>
                <th>Urządzenie</th>
                <th>Adres IP</th>
                <th>Zalogowano</th>
                <th>Ostatnia aktywność</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td>
                    <span className="strong">{describeAgent(s.userAgent)}</span> {s.current && <Badge variant="brand">Ta sesja</Badge>}
                  </td>
                  <td className="mono">{s.ip ?? '—'}</td>
                  <td className="small ink-2">{dateTime(s.createdAt)}</td>
                  <td className="small ink-2">{s.current ? 'teraz' : ago(s.lastSeenAt)}</td>
                  <td className="right">
                    {!s.current && (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={LogOut}
                        title="Wyloguj tę sesję"
                        onClick={async () => {
                          await api.revokeSession(s.id);
                          void loadSessions();
                        }}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <Modal open={mfaOpen} onClose={() => setMfaOpen(false)} wide>
        <h3>Włącz weryfikację dwuetapową</h3>
        <MfaSetupFlow
          onCancel={() => setMfaOpen(false)}
          onDone={() => {
            setMfaOpen(false);
            void reloadMe();
            toast('Weryfikacja dwuetapowa włączona');
          }}
        />
      </Modal>
      <PasswordConfirm
        open={confirm !== null}
        mode={confirm}
        onClose={() => setConfirm(null)}
        onDone={() => {
          void reloadMe();
        }}
      />
    </>
  );
}

/** Operacje 2FA wymagające potwierdzenia hasłem. */
function PasswordConfirm({ open, mode, onClose, onDone }: { open: boolean; mode: null | 'disable' | 'codes'; onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setPassword('');
      setCodes(null);
      setError('');
    }
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'disable') {
        await api.mfaDisable(password);
        toast('Weryfikacja dwuetapowa wyłączona');
        onDone();
        onClose();
      } else {
        setCodes((await api.regenerateRecoveryCodes(password)).recoveryCodes);
        onDone();
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose}>
      {codes ? (
        <>
          <h3>Nowe kody zapasowe</h3>
          <p>Poprzednie kody przestały działać. Zapisz nowe w bezpiecznym miejscu.</p>
          <SecretBox lines={codes} filename="overvnc-kody-zapasowe.txt" />
          <div className="okno-actions">
            <Button variant="primary" onClick={onClose}>
              Gotowe
            </Button>
          </div>
        </>
      ) : (
        <form onSubmit={submit}>
          <h3>{mode === 'disable' ? 'Wyłączyć weryfikację dwuetapową?' : 'Wygenerować nowe kody zapasowe?'}</h3>
          <p>{mode === 'disable' ? 'Konto będzie chronione tylko hasłem.' : 'Dotychczasowe kody przestaną działać.'}</p>
          <Field label="Potwierdź hasłem">
            <input className="pole" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus required />
          </Field>
          {error && <div className="form-error">{error}</div>}
          <div className="okno-actions">
            <Button type="button" variant="ghost" onClick={onClose}>
              Anuluj
            </Button>
            <Button variant={mode === 'disable' ? 'danger' : 'primary'} loading={busy}>
              {mode === 'disable' ? 'Wyłącz 2FA' : 'Generuj kody'}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
