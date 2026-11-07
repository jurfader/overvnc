import { useState } from 'react';
import { CalendarClock, CheckCircle2, KeyRound, Lock, LockOpen, RefreshCw, ShieldAlert, ShieldCheck, Wrench, XCircle } from 'lucide-react';
import { api, errorMessage, type Agent, type KioskAction, type WinStatus } from '../../api.ts';
import { Badge, Button, CardHead, Meter, Modal, toast } from '../../components.tsx';
import { ago, dateTime } from '../../format.ts';
import { useMe } from '../../state.tsx';

const EVAL_DAYS = 90;
const LICENSE_STATUS: Record<number, string> = { 0: 'brak licencji', 1: 'aktywowany', 2: 'okres przejściowy', 3: 'okres przejściowy', 4: 'nieoryginalny', 5: 'wymaga aktywacji', 6: 'okres rozszerzony' };

interface Confirm {
  action: KioskAction;
  title: string;
  text: string;
  button: string;
}

/** Windows na kiosku: licencja (wersja próbna 90 dni), ochrona przed zapisem (UWF), zadania z restartami. */
export function WindowsCard({ agent, win }: { agent: Agent; win: WinStatus }) {
  const { can } = useMe();
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const lic = win.license;
  const uwf = win.uwf;
  const canAct = can('agents.remote') && agent.online && agent.capabilities.includes('kiosk.action') && !win.task;
  const days = lic?.evaluation ? Math.floor(lic.graceMinutes / 1440) : null;

  const run = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      const r = await api.kioskAction(agent.id, confirm.action);
      toast(r.restarts === 2 ? 'Rozpoczęto — komputer uruchomi się ponownie dwa razy' : 'Komputer uruchomi się ponownie za 15 s');
      setConfirm(null);
    } catch (e) {
      toast(errorMessage(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="glass-card card anim-rise">
      <CardHead icon={KeyRound} title="Windows" />

      {win.task && (
        <div className="callout callout-brand" style={{ marginBottom: 14 }}>
          <RefreshCw />
          <div>
            <strong>Trwa: {win.task.kind === 'extend' ? 'przedłużanie okresu próbnego' : win.task.kind === 'profile' ? 'zapisywanie funkcji kiosku' : win.task.kind}</strong>
            <div className="small muted">
              {win.task.step === 'rearm' || win.task.step === 'apply'
                ? 'krok 1 z 2 — wyłączanie ochrony przed zapisem i restart'
                : win.task.step === 'verify' || win.task.step === 'done'
                  ? 'ostatni restart'
                  : 'przedłużanie'}{' '}
              · od {ago(win.task.started)}
            </div>
          </div>
        </div>
      )}
      {!win.task && win.lastTask && Date.now() - win.lastTask.at < 7 * 24 * 3600_000 && (
        <div className={`callout ${win.lastTask.ok ? 'callout-brand' : 'callout-danger'}`} style={{ marginBottom: 14 }}>
          {win.lastTask.ok ? <CheckCircle2 /> : <XCircle />}
          <div>
            <strong>{win.lastTask.ok ? 'Zadanie zakończone' : 'Zadanie nie powiodło się'}</strong>
            <div className="small">
              {win.lastTask.message} · {dateTime(win.lastTask.at)}
            </div>
          </div>
        </div>
      )}

      <div className="win-grid">
        <div className="win-block">
          <div className="win-head">
            <CalendarClock /> Licencja
          </div>
          {!lic ? (
            <div className="muted small">Brak danych — odśwież inwentarz.</div>
          ) : lic.evaluation ? (
            <>
              <div className="win-row">
                <Badge variant={days !== null && days <= 14 ? 'danger' : days !== null && days <= 30 ? 'warning' : 'info'}>wersja próbna</Badge>
                <span className="strong">{days} dni do końca</span>
              </div>
              {/* pasek dni bez procentów — czerwony przy ≤14 dniach, żółty przy ≤30 */}
              <div className="meter-track" style={{ width: '100%' }} title={`${days} z ${EVAL_DAYS} dni`}>
                <div className={`meter-fill ${(days ?? 0) <= 14 ? 'crit' : (days ?? 0) <= 30 ? 'warn' : 'ok'}`} style={{ width: `${Math.max(2, Math.min(100, ((days ?? 0) / EVAL_DAYS) * 100))}%` }} />
              </div>
              <div className="small muted">
                {lic.evalEnd ? `Koniec: ${new Date(lic.evalEnd).toLocaleDateString('pl-PL')} · ` : ''}pozostałe przedłużenia: {lic.rearmsLeft}
              </div>
              {canAct && lic.rearmsLeft > 0 && (
                <Button
                  size="sm"
                  icon={RefreshCw}
                  onClick={() =>
                    setConfirm({
                      action: 'extend',
                      title: 'Przedłużyć okres próbny Windows?',
                      text: uwf?.enabled
                        ? 'Komputer wyłączy ochronę przed zapisem i uruchomi się ponownie, wykona przedłużenie, włączy ochronę i uruchomi się drugi raz. Całość trwa kilka minut — w tym czasie kiosk jest niedostępny dla klientów.'
                        : 'Komputer wykona przedłużenie i uruchomi się ponownie. Ochrona przed zapisem jest teraz wyłączona i taka pozostanie.',
                      button: 'Przedłuż i uruchom ponownie',
                    })
                  }
                >
                  Przedłuż okres próbny
                </Button>
              )}
              {lic.rearmsLeft <= 0 && <div className="small" style={{ color: 'rgb(var(--danger))' }}>Limit przedłużeń wyczerpany — po końcu okresu potrzebna licencja i ponowna instalacja.</div>}
            </>
          ) : (
            <div className="win-row">
              <Badge variant={lic.status === 1 ? 'success' : 'warning'}>{LICENSE_STATUS[lic.status] ?? `stan ${lic.status}`}</Badge>
              <span className="small muted ellipsis">{lic.name}</span>
            </div>
          )}
        </div>

        <div className="win-block">
          <div className="win-head">
            {uwf?.enabled ? <ShieldCheck /> : <ShieldAlert />} Ochrona przed zapisem (UWF)
          </div>
          {!uwf ? (
            <div className="muted small">Nie jest zainstalowana — zmiany na dysku są trwałe.</div>
          ) : (
            <>
              <div className="win-row">
                <Badge variant={uwf.enabled ? 'success' : 'warning'}>{uwf.enabled ? 'włączona' : 'wyłączona — tryb serwisowy'}</Badge>
                {uwf.nextEnabled !== uwf.enabled && <span className="small muted">po restarcie: {uwf.nextEnabled ? 'włączona' : 'wyłączona'}</span>}
              </div>
              {uwf.enabled && (
                <Meter
                  value={uwf.overlayUsedMB + uwf.overlayFreeMB > 0 ? (uwf.overlayUsedMB / (uwf.overlayUsedMB + uwf.overlayFreeMB)) * 100 : null}
                  caption={`nakładka: ${uwf.overlayUsedMB} MB z ${uwf.overlayUsedMB + uwf.overlayFreeMB} MB`}
                />
              )}
              {!uwf.agentExcluded && uwf.enabled && (
                <div className="small" style={{ color: 'rgb(var(--warning))' }}>Folder OVERVNC nie jest wykluczony z ochrony — aktualizacje agenta znikną po restarcie.</div>
              )}
              {canAct &&
                (uwf.nextEnabled ? (
                  <Button
                    size="sm"
                    icon={Wrench}
                    onClick={() =>
                      setConfirm({
                        action: 'service-on',
                        title: 'Włączyć tryb serwisowy?',
                        text: 'Ochrona przed zapisem zostanie wyłączona i komputer uruchomi się ponownie. Zmiany na dysku będą trwałe, dopóki nie włączysz ochrony z powrotem. Logowanie klienta zostaje włączone — rób to poza godzinami pracy.',
                        button: 'Wyłącz ochronę i uruchom ponownie',
                      })
                    }
                  >
                    Tryb serwisowy
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    icon={Lock}
                    onClick={() =>
                      setConfirm({
                        action: 'service-off',
                        title: 'Włączyć ochronę przed zapisem?',
                        text: 'Komputer uruchomi się ponownie z włączoną ochroną — od tej chwili każdy restart przywraca stan dysku.',
                        button: 'Włącz ochronę i uruchom ponownie',
                      })
                    }
                  >
                    Włącz ochronę
                  </Button>
                ))}
            </>
          )}
        </div>
      </div>

      <Modal open={!!confirm} onClose={() => setConfirm(null)}>
        <h3>{confirm?.title}</h3>
        <p>{confirm?.text}</p>
        <div className="okno-actions">
          <Button variant="ghost" onClick={() => setConfirm(null)}>
            Anuluj
          </Button>
          <Button variant="primary" icon={uwf?.enabled && confirm?.action === 'service-on' ? LockOpen : RefreshCw} loading={busy} onClick={run}>
            {confirm?.button}
          </Button>
        </div>
      </Modal>
    </section>
  );
}
