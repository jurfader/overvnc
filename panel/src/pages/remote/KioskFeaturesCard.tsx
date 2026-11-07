import { useEffect, useState, type FormEvent } from 'react';
import { Copy, FolderOpen, LogOut, Smartphone, Store } from 'lucide-react';
import { api, errorMessage, type Agent, type ShareStatus } from '../../api.ts';
import { Button, CardHead, Modal, toast } from '../../components.tsx';
import { useMe } from '../../state.tsx';

type Feature = 'phoneApp' | 'endButton';
type ShareMode = Agent['shareMode'];

const FEATURES: { key: Feature; icon: typeof Smartphone; title: string; on: string; off: string }[] = [
  {
    key: 'phoneApp',
    icon: Smartphone,
    title: 'Zdjęcia z telefonu',
    on: 'Gdy klient podłączy telefon kablem USB, otworzy się aplikacja — przegląda zdjęcia, kopiuje je do Pobranych i usuwa z telefonu. Kafelek jest też w menu Start.',
    off: 'Klient podłącza telefon (Android, iPhone) kablem USB i w prostej aplikacji kopiuje zdjęcia do Pobranych albo usuwa je z telefonu.',
  },
  {
    key: 'endButton',
    icon: LogOut,
    title: 'Przycisk „Zakończ i usuń moje dane”',
    on: 'Klient widzi przycisk w lewym dolnym rogu ekranu (i kafelek w Start). Po potwierdzeniu programy się zamykają, Pobrane są usuwane, a kiosk uruchamia się ponownie — UWF odrzuca wszystkie zmiany.',
    off: 'Klient sam kończy sesję jednym kliknięciem: zamknięcie programów i wylogowanie ze stron, usunięcie Pobranych i restart czyszczący (ok. 1–2 min).',
  },
];

const SHARE_MODES: { value: ShareMode; label: string }[] = [
  { value: 'off', label: 'Wyłączone' },
  { value: 'read', label: 'Tylko odczyt' },
  { value: 'delete', label: 'Odczyt i usuwanie' },
];

/** Kiosk: funkcje dla klientów i pracowników — zapisywane w trybie kiosku (Assigned Access), menu Start i systemie. */
export function KioskFeaturesCard({ agent, uwf, share }: { agent: Agent; uwf: boolean; share?: ShareStatus | null }) {
  const { can } = useMe();
  const manage = can('agents.manage');
  const [busy, setBusy] = useState<string | null>(null);
  // kiosk z ochroną przed zapisem: zapis zmiany = dwa restarty — najpierw pytamy
  const [confirm, setConfirm] = useState<{ run: () => Promise<void> } | null>(null);
  const supported = !agent.online || agent.capabilities.includes('agent.profile');
  const withConfirm = (run: () => Promise<void>) => (uwf && agent.online ? setConfirm({ run }) : void run());

  const save = async (key: string, patch: Parameters<typeof api.updateAgent>[1], label: string) => {
    setBusy(key);
    try {
      const r = await api.updateAgent(agent.id, patch);
      toast(r.profileNote ? `${label}. ${r.profileNote}` : agent.online ? label : `${label} — kiosk zastosuje zmianę po połączeniu.`);
    } catch (e) {
      toast(errorMessage(e), 'err');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="glass-card card anim-rise" style={{ animationDelay: '120ms' }}>
      <CardHead icon={Store} title="Funkcje kiosku" />
      <div className="kiosk-features">
        {FEATURES.map((f) => (
          <div key={f.key} className="kiosk-feature">
            <span className={`kiosk-feature-icon ${agent[f.key] ? 'on' : ''}`}>
              <f.icon />
            </span>
            <div className="kiosk-feature-body">
              <strong>{f.title}</strong>
              <div className="small muted">{agent[f.key] ? f.on : f.off}</div>
            </div>
            {manage && supported && (
              <Button
                size="sm"
                variant={agent[f.key] ? 'secondary' : 'primary'}
                loading={busy === f.key}
                disabled={busy !== null}
                onClick={() => withConfirm(() => save(f.key, { [f.key]: !agent[f.key] }, `${f.title}: ${agent[f.key] ? 'wyłączone' : 'włączone'}`))}
              >
                {agent[f.key] ? 'Wyłącz' : 'Włącz'}
              </Button>
            )}
          </div>
        ))}
        <ShareSection agent={agent} share={share} manage={manage && supported} busy={busy} setBusy={setBusy} save={save} withConfirm={withConfirm} />
      </div>
      {!supported && <p className="small muted">Wymaga agenta w wersji 0.20.0 lub nowszej — zaktualizuj agenta.</p>}
      <p className="small muted" style={{ marginBottom: 0 }}>
        Przy włączonej ochronie przed zapisem (UWF) kiosk sam uruchomi się dwa razy ponownie, żeby zapisać zmianę na stałe (ok. 3 minuty). Kiosk offline zastosuje zmianę po
        połączeniu.
      </p>
      <Modal open={confirm !== null} onClose={() => setConfirm(null)}>
        <h3>Kiosk uruchomi się dwa razy ponownie</h3>
        <p className="muted">
          Kiosk ma włączoną ochronę przed zapisem (UWF). Żeby zapisać zmianę na stałe, OVERVNC wyłączy ochronę, zapisze ustawienia i włączy ją z powrotem — z dwoma restartami (ok.
          3 minuty). Jeśli ktoś teraz korzysta z kiosku, straci otwarte pliki.
        </p>
        <div className="okno-actions">
          <Button variant="ghost" onClick={() => setConfirm(null)}>
            Anuluj
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              const c = confirm!;
              setConfirm(null);
              void c.run();
            }}
          >
            Zapisz i uruchom ponownie
          </Button>
        </div>
      </Modal>
    </section>
  );
}

/** Udział sieciowy folderu Pobrane klienta — pracownicy przeglądają (i ewentualnie usuwają) pliki z innych komputerów. */
function ShareSection({
  agent,
  share,
  manage,
  busy,
  setBusy,
  save,
  withConfirm,
}: {
  agent: Agent;
  share?: ShareStatus | null;
  manage: boolean;
  busy: string | null;
  setBusy: (b: string | null) => void;
  save: (key: string, patch: Parameters<typeof api.updateAgent>[1], label: string) => Promise<void>;
  withConfirm: (run: () => Promise<void>) => void;
}) {
  const [mode, setMode] = useState<ShareMode>(agent.shareMode);
  const [allow, setAllow] = useState(agent.shareAllow);
  const [password, setPassword] = useState('');
  useEffect(() => {
    setMode(agent.shareMode);
    setAllow(agent.shareAllow);
  }, [agent.shareMode, agent.shareAllow]);
  const dirty = mode !== agent.shareMode || (mode !== 'off' && allow.trim() !== agent.shareAllow);
  const on = agent.shareMode !== 'off';
  const ip = share?.addresses?.[0];
  const path = ip ? `\\\\${ip}\\Pobrane` : null;
  const login = share?.computer ? `${share.computer}\\pracownik` : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const label = mode === 'off' ? 'Udział Pobrane wyłączony' : `Udział Pobrane: ${mode === 'delete' ? 'odczyt i usuwanie' : 'tylko odczyt'}`;
    withConfirm(() => save('share', { shareMode: mode, shareAllow: mode === 'off' ? '' : allow.trim() }, label));
  };
  const setPass = (e: FormEvent) => {
    e.preventDefault();
    const pw = password;
    withConfirm(async () => {
      setBusy('pass');
      try {
        const r = await api.setSharePassword(agent.id, pw);
        setPassword('');
        toast(r.note ? `Hasło ustawione. ${r.note}` : 'Hasło ustawione');
      } catch (err) {
        toast(errorMessage(err), 'err');
      } finally {
        setBusy(null);
      }
    });
  };
  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast('Skopiowano'), () => toast('Nie udało się skopiować', 'err'));

  return (
    <div className="kiosk-feature kiosk-share">
      <span className={`kiosk-feature-icon ${on ? 'on' : ''}`}>
        <FolderOpen />
      </span>
      <div className="kiosk-feature-body">
        <strong>Udostępnianie Pobranych pracownikom</strong>
        <div className="small muted">
          Pracownicy otwierają folder Pobrane klienta z innego komputera w sieci (konto „pracownik”). Dostęp tylko z sieci lokalnej — albo tylko z podanych adresów.
        </div>

        {on && share?.mode && path && login && (
          <div className="share-info">
            <div>
              <span className="muted small">Adres w Eksploratorze</span>
              <code>{path}</code>
              <button type="button" className="icon-btn" onClick={() => copy(path)} title="Kopiuj adres">
                <Copy />
              </button>
            </div>
            <div>
              <span className="muted small">Użytkownik</span>
              <code>{login}</code>
              <button type="button" className="icon-btn" onClick={() => copy(login)} title="Kopiuj nazwę użytkownika">
                <Copy />
              </button>
            </div>
            {share.addresses && share.addresses.length > 1 && <div className="small muted">Inne adresy kiosku: {share.addresses.slice(1).join(', ')}</div>}
          </div>
        )}
        {!on && share?.mode && (
          <div className="share-warn small">
            Na kiosku działa udział „Pobrane” ustawiony poza panelem ({share.mode === 'delete' ? 'odczyt i usuwanie' : 'tylko odczyt'}). Wybierz tryb i zapisz, żeby zarządzać nim tutaj
            — „Wyłączone” go usunie.
          </div>
        )}
        {on && share && !share.userEnabled && <div className="share-warn small">Ustaw hasło konta „pracownik” — bez niego pracownicy nie zalogują się do udziału.</div>}
        {on && agent.online && share && !share.mode && <div className="small muted">Udział jest zapisywany na kiosku…</div>}

        {manage && (
          <>
            <form className="share-form" onSubmit={submit}>
              <div className="seg" role="radiogroup" aria-label="Dostęp do Pobranych">
                {SHARE_MODES.map((m) => (
                  <button key={m.value} type="button" role="radio" aria-checked={mode === m.value} className={`seg-btn ${mode === m.value ? 'on' : ''}`} onClick={() => setMode(m.value)}>
                    {m.label}
                  </button>
                ))}
              </div>
              {mode !== 'off' && (
                <input
                  className="pole"
                  value={allow}
                  onChange={(e) => setAllow(e.target.value)}
                  placeholder="Dozwolone adresy — puste = cała sieć lokalna, np. 192.168.1.20"
                  aria-label="Dozwolone adresy"
                />
              )}
              <Button size="sm" variant="primary" loading={busy === 'share'} disabled={!dirty || busy !== null}>
                Zapisz
              </Button>
            </form>
            {on && (
              <form className="share-form" onSubmit={setPass}>
                <input
                  className="pole"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Nowe hasło konta „pracownik” (min. 8 znaków)"
                  aria-label="Hasło konta pracownik"
                  minLength={8}
                />
                <Button size="sm" loading={busy === 'pass'} disabled={password.length < 8 || busy !== null || !agent.online} title={agent.online ? undefined : 'Kiosk musi być online'}>
                  Ustaw hasło
                </Button>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}
