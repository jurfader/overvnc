import { useEffect, useState, type FormEvent } from 'react';
import { Expand, ImageOff, MessageSquareText, MonitorSmartphone, RefreshCw, ScreenShare } from 'lucide-react';
import { api, errorMessage, type Agent } from '../../api.ts';
import { Button, CardHead, Field, Modal, toast } from '../../components.tsx';
import { useOrg } from '../../state.tsx';
import { ago, plural } from '../../format.ts';
import { useScreenshot } from '../../hooks/useScreenshot.ts';

/** Czy panel może pokazywać podgląd ekranu bez powiadomienia (klient w trybie „Bez komunikatu”). */
export function useSilentPreview(agent: Agent): boolean {
  const { clientById } = useOrg();
  return clientById(agent.clientId)?.consentMode === 'none';
}

/** Karta „Ekran” na stronie komputera: miniatura, duży podgląd, komunikat na ekranie, skrót do pulpitu. */
export function KioskCard({ agent }: { agent: Agent }) {
  const silent = useSilentPreview(agent);
  const canShot = agent.online && agent.capabilities.includes('screen.capture') && silent;
  const canMsg = agent.online && agent.capabilities.includes('screen.message');
  const shot = useScreenshot(agent.id, 640, { enabled: canShot, intervalMs: 15_000 });
  const [big, setBig] = useState(false);
  const [msgOpen, setMsgOpen] = useState(false);

  if (!agent.capabilities.includes('screen.capture') && !canMsg) return null;

  return (
    <section className="glass-card card anim-rise kiosk-card">
      <CardHead icon={ScreenShare} title="Ekran">
        <div className="toolbar kiosk-actions">
          {canShot && <Button size="sm" variant="ghost" icon={RefreshCw} loading={shot.loading} title="Odśwież zrzut" onClick={shot.refresh} />}
          {canShot && <Button size="sm" variant="ghost" icon={Expand} title="Duży podgląd" onClick={() => setBig(true)} />}
          {canMsg && (
            <Button size="sm" icon={MessageSquareText} onClick={() => setMsgOpen(true)}>
              Komunikat
            </Button>
          )}
          <a className="btn btn-secondary btn-sm" href={`#/m/${agent.id}/desktop`}>
            <MonitorSmartphone /> Pulpit
          </a>
        </div>
      </CardHead>
      {canShot ? (
        <button type="button" className="kiosk-shot" onClick={() => setBig(true)} aria-label="Powiększ zrzut ekranu">
          {shot.url ? <img src={shot.url} alt={`Ekran: ${agent.label || agent.hostname}`} /> : <ShotPlaceholder error={shot.error} loading={shot.loading} />}
          {shot.at && <span className="kiosk-shot-time">{ago(shot.at)}</span>}
        </button>
      ) : (
        <div className="muted small">
          {!agent.online
            ? 'Komputer jest offline.'
            : !silent
              ? 'Podgląd bez powiadomienia jest wyłączony — klient ma tryb zgody „Powiadomienie” lub „Pytaj”. Ekran zobaczysz w zakładce Pulpit.'
              : 'Ta wersja agenta nie obsługuje zrzutów ekranu — zaktualizuj agenta.'}
        </div>
      )}
      {big && <BigShot agent={agent} onClose={() => setBig(false)} />}
      <MessageModal open={msgOpen} agents={[agent]} onClose={() => setMsgOpen(false)} />
    </section>
  );
}

export function ShotPlaceholder({ error, loading, text }: { error?: string | null; loading?: boolean; text?: string }) {
  return (
    <span className="shot-placeholder">
      {loading && !error ? <span className="spinner" /> : <ImageOff />}
      <span>{error ?? text ?? (loading ? 'Pobieranie obrazu…' : 'Brak obrazu')}</span>
    </span>
  );
}

function BigShot({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const shot = useScreenshot(agent.id, 1600, { enabled: true, intervalMs: 5000 });
  return (
    <Modal open onClose={onClose} wide>
      <div className="editor-head">
        <h3>Ekran: {agent.label || agent.hostname}</h3>
        <span className="muted small">{shot.at ? `odświeżany co 5 s · ${ago(shot.at)}` : ''}</span>
      </div>
      <div className="big-shot">{shot.url ? <img src={shot.url} alt="" /> : <ShotPlaceholder error={shot.error} loading={shot.loading} />}</div>
      <div className="okno-actions">
        <Button variant="ghost" onClick={onClose}>
          Zamknij
        </Button>
        <a className="btn btn-primary" href={`#/m/${agent.id}/desktop`} onClick={onClose}>
          <MonitorSmartphone /> Otwórz pulpit
        </a>
      </div>
    </Modal>
  );
}

const DURATIONS = [
  { value: 30, label: '30 sekund' },
  { value: 60, label: '1 minuta' },
  { value: 300, label: '5 minut' },
  { value: 900, label: '15 minut' },
  { value: 3600, label: '1 godzina' },
];

/** Komunikat na ekranie jednego lub wielu komputerów. */
export function MessageModal({ open, agents, onClose }: { open: boolean; agents: Agent[]; onClose: () => void }) {
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [seconds, setSeconds] = useState(60);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setBusy(false);
  }, [open]);

  const targets = agents.filter((a) => a.online && a.capabilities.includes('screen.message'));
  const skipped = agents.length - targets.length;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const results = await Promise.allSettled(targets.map((a) => api.screenMessage(a.id, { text: text.trim(), title: title.trim(), seconds })));
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    setBusy(false);
    if (failed.length === 0) {
      toast(targets.length === 1 ? 'Komunikat wyświetlony' : `Komunikat wyświetlony na ${targets.length} ${plural(targets.length, 'komputerze', 'komputerach', 'komputerach')}`);
      setText('');
      onClose();
    } else toast(`Nie udało się na ${failed.length} z ${targets.length}: ${errorMessage(failed[0].reason)}`, 'err');
  };

  return (
    <Modal open={open} onClose={onClose}>
      <form onSubmit={submit}>
        <h3>Komunikat na ekranie</h3>
        <p className="small">
          {targets.length === 1 ? `Okno z komunikatem pojawi się na ekranie komputera ${targets[0].label || targets[0].hostname}.` : `Okno z komunikatem pojawi się na ${targets.length} ${plural(targets.length, 'komputerze', 'komputerach', 'komputerach')}.`}
          {skipped > 0 && ` Pominięte: ${skipped} (offline lub stara wersja agenta).`}
        </p>
        <Field label="Treść">
          <textarea className="pole" value={text} onChange={(e) => setText(e.target.value)} maxLength={500} required autoFocus placeholder="np. Przerwa techniczna do 14:00. Przepraszamy." />
        </Field>
        <div className="form-2">
          <Field label="Tytuł okna (opcjonalnie)">
            <input className="pole" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder="Komunikat" />
          </Field>
          <Field label="Zniknie po">
            <select className="pole" value={seconds} onChange={(e) => setSeconds(Number(e.target.value))}>
              {DURATIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="okno-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            Anuluj
          </Button>
          <Button variant="primary" icon={MessageSquareText} loading={busy} disabled={targets.length === 0 || !text.trim()}>
            Wyświetl
          </Button>
        </div>
      </form>
    </Modal>
  );
}
