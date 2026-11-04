import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ChevronDown, Lock, LogOut, Power, PowerOff, RotateCcw, Sunrise, TimerOff } from 'lucide-react';
import { api, errorMessage, type Agent, type PowerAction } from '../../api.ts';
import { Button, Field, Modal, toast, useDismiss } from '../../components.tsx';

const ITEMS: { action: PowerAction; label: string; icon: typeof Power; danger?: boolean }[] = [
  { action: 'reboot', label: 'Uruchom ponownie…', icon: RotateCcw },
  { action: 'shutdown', label: 'Wyłącz…', icon: PowerOff, danger: true },
  { action: 'logoff', label: 'Wyloguj użytkowników', icon: LogOut },
  { action: 'lock', label: 'Zablokuj ekran', icon: Lock },
  { action: 'cancel', label: 'Anuluj zaplanowany restart/wyłączenie', icon: TimerOff },
];

const CONFIRM: Record<PowerAction, { title: string; text: string; button: string; done: string }> = {
  reboot: { title: 'Uruchomić ponownie?', text: '', button: 'Uruchom ponownie', done: 'Zlecono restart' },
  shutdown: { title: 'Wyłączyć komputer?', text: 'Włączenie będzie możliwe fizycznie albo przez Wake-on-LAN (jeśli jest skonfigurowany).', button: 'Wyłącz', done: 'Zlecono wyłączenie' },
  logoff: { title: 'Wylogować użytkowników?', text: 'Wszyscy zalogowani użytkownicy zostaną wylogowani — niezapisana praca zostanie utracona.', button: 'Wyloguj', done: 'Użytkownicy wylogowani' },
  lock: { title: 'Zablokować ekran?', text: 'Do odblokowania potrzebne będzie hasło użytkownika.', button: 'Zablokuj', done: 'Ekran zablokowany' },
  cancel: { title: 'Anulować zaplanowany restart lub wyłączenie?', text: '', button: 'Anuluj zaplanowane', done: 'Anulowano' },
};

const DELAYS = [
  { value: 0, label: 'Natychmiast' },
  { value: 1, label: 'Za 1 minutę' },
  { value: 5, label: 'Za 5 minut' },
  { value: 15, label: 'Za 15 minut' },
  { value: 60, label: 'Za godzinę' },
];

/** Menu zasilania — pokazuje tylko akcje, które agent zgłosił jako obsługiwane. */
export function PowerMenu({ agent }: { agent: Agent }) {
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<PowerAction | null>(null);
  const closeMenu = useRef(() => setOpen(false)).current;
  const ref = useDismiss<HTMLDivElement>(open, closeMenu);
  const items = ITEMS.filter((i) => agent.capabilities.includes(`power.${i.action}`));


  if (items.length === 0) return null;
  return (
    <div className="dropdown" ref={ref}>
      <Button icon={Power} onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        Zasilanie <ChevronDown style={{ width: 14, height: 14, marginLeft: -2 }} />
      </Button>
      {open && (
        <div className="dropdown-menu anim-pop" role="menu">
          {items.map(({ action: a, label, icon: Icon, danger }) => (
            <button
              key={a}
              role="menuitem"
              className={`dropdown-item ${danger ? 'danger' : ''}`}
              onClick={() => {
                setOpen(false);
                setAction(a);
              }}
            >
              <Icon /> {label}
            </button>
          ))}
        </div>
      )}
      <PowerModal agent={agent} action={action} onClose={() => setAction(null)} />
    </div>
  );
}

function PowerModal({ agent, action, onClose }: { agent: Agent; action: PowerAction | null; onClose: () => void }) {
  const [delay, setDelay] = useState(0);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const scheduled = action === 'reboot' || action === 'shutdown';
  const users = agent.metrics?.activeUsers ?? [];

  useEffect(() => {
    if (!action) return;
    // gdy ktoś pracuje, domyślnie dajemy mu czas na zapisanie pracy
    setDelay(scheduled && users.length > 0 ? 5 : 0);
    setMessage('');
  }, [action]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!action) return;
    setBusy(true);
    try {
      await api.power(agent.id, action, scheduled ? delay : 0, scheduled ? message : '');
      toast(CONFIRM[action].done + (scheduled && delay ? ` (za ${delay} min)` : ''));
      onClose();
    } catch (err) {
      toast(errorMessage(err), 'err');
    } finally {
      setBusy(false);
    }
  };

  const c = action ? CONFIRM[action] : null;
  return (
    <Modal open={!!action} onClose={onClose}>
      {c && action && (
        <form onSubmit={submit}>
          <h3>{c.title}</h3>
          {users.length > 0 && (action === 'reboot' || action === 'shutdown' || action === 'logoff') && (
            <div className="callout callout-warning">Zalogowani: {users.join(', ')}. Niezapisana praca może zostać utracona.</div>
          )}
          {c.text && <p>{c.text}</p>}
          {scheduled && (
            <>
              <Field label="Kiedy">
                <select className="pole" value={delay} onChange={(e) => setDelay(Number(e.target.value))}>
                  {DELAYS.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Komunikat dla użytkownika" hint="Wyświetli się na ekranie komputera (Windows, Linux).">
                <input className="pole" value={message} maxLength={200} onChange={(e) => setMessage(e.target.value)} placeholder="np. Instalacja aktualizacji — zapisz swoją pracę" />
              </Field>
            </>
          )}
          <div className="okno-actions">
            <Button type="button" variant="ghost" onClick={onClose}>
              Anuluj
            </Button>
            <Button variant={action === 'shutdown' || action === 'logoff' ? 'danger' : 'primary'} loading={busy}>
              {c.button}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

/** Wybudzenie wyłączonego komputera przez inny komputer z tej samej sieci. */
export function WakeButton({ agent }: { agent: Agent }) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.wakeInfo>> | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setInfo(null);
      api.wakeInfo(agent.id).then(setInfo, (err) => (toast(errorMessage(err), 'err'), setOpen(false)));
    }
  }, [open, agent.id]);

  return (
    <>
      <Button icon={Sunrise} onClick={() => setOpen(true)}>
        Wybudź
      </Button>
      <Modal open={open} onClose={() => setOpen(false)}>
        <h3>Wybudzenie przez sieć (Wake-on-LAN)</h3>
        {!info ? (
          <p>Szukanie komputera, który może wysłać sygnał…</p>
        ) : info.possible && info.relay ? (
          <p>
            Sygnał wyśle włączony komputer <strong>{info.relay.name}</strong> z tej samej sieci lokalnej. Komputer musi mieć włączoną funkcję Wake-on-LAN w
            BIOS/UEFI i być podłączony kablem.
          </p>
        ) : info.reason === 'no_mac' ? (
          <div className="callout callout-warning">
            Nieznany adres MAC tego komputera. Agent musi choć raz połączyć się z serwerem i przesłać inwentarz — dopiero wtedy wybudzanie będzie możliwe.
          </div>
        ) : (
          <div className="callout callout-warning">
            Brak włączonego komputera z OVERVNC w tej samej sieci lokalnej (ta sama podsieć oraz ten sam klient lub łącze internetowe). Sygnału nie da się wysłać
            z internetu — potrzebny jest inny włączony komputer w tym biurze.
          </div>
        )}
        <div className="okno-actions">
          <Button variant="ghost" onClick={() => setOpen(false)}>
            {info?.possible ? 'Anuluj' : 'Zamknij'}
          </Button>
          {info?.possible && (
            <Button
              variant="primary"
              icon={Sunrise}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await api.wake(agent.id);
                  toast(`Wysłano sygnał przez ${r.relay.name} — komputer powinien połączyć się w ciągu 1–2 minut`);
                  setOpen(false);
                } catch (err) {
                  toast(errorMessage(err), 'err');
                } finally {
                  setBusy(false);
                }
              }}
            >
              Wyślij sygnał
            </Button>
          )}
        </div>
      </Modal>
    </>
  );
}
