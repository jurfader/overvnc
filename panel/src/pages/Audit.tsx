import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api, type AuditEntry } from '../api.ts';
import { Badge, Button } from '../components.tsx';
import { dateTime } from '../format.ts';
import { AllChanges } from './protection.tsx';

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'brand';

const ACTIONS: Record<string, [string, Tone]> = {
  'auth.login': ['Logowanie', 'success'],
  'auth.login_failed': ['Nieudane logowanie', 'danger'],
  'user.create': ['Utworzenie konta', 'brand'],
  'user.passwd': ['Zmiana hasła', 'brand'],
  'enroll_token.create': ['Utworzenie tokenu', 'brand'],
  'enroll_token.delete': ['Usunięcie tokenu', 'neutral'],
  'agent.enroll': ['Rejestracja komputera', 'success'],
  'agent.enroll_rejected': ['Odrzucona rejestracja', 'danger'],
  'agent.auth_failed': ['Odrzucone połączenie agenta', 'danger'],
  'agent.connect': ['Komputer połączony', 'info'],
  'agent.disconnect': ['Komputer rozłączony', 'neutral'],
  'agent.delete': ['Usunięcie komputera', 'warning'],
  'agent.refresh_inventory': ['Odświeżenie inwentarza', 'neutral'],
  'agent.update': ['Zmiana komputera', 'neutral'],
  'agent.bulk_update': ['Zmiana zbiorcza', 'neutral'],
  'auth.login_disabled': ['Logowanie na zablokowane konto', 'danger'],
  'auth.mfa_failed': ['Błędny kod 2FA', 'danger'],
  'auth.mfa_enable': ['Włączenie 2FA', 'success'],
  'auth.mfa_disable': ['Wyłączenie 2FA', 'warning'],
  'auth.recovery_codes_regenerate': ['Nowe kody zapasowe', 'brand'],
  'auth.password_change': ['Zmiana hasła', 'brand'],
  'auth.session_revoke': ['Wylogowanie sesji', 'neutral'],
  'auth.session_revoke_others': ['Wylogowanie pozostałych sesji', 'neutral'],
  'user.update': ['Zmiana konta', 'brand'],
  'user.delete': ['Usunięcie konta', 'warning'],
  'user.reset_password': ['Reset hasła', 'warning'],
  'user.reset_2fa': ['Reset 2FA', 'warning'],
  'user.unlock': ['Odblokowanie konta', 'brand'],
  'client.create': ['Nowy klient', 'brand'],
  'client.update': ['Zmiana klienta', 'neutral'],
  'client.delete': ['Usunięcie klienta', 'warning'],
  'site.create': ['Nowa lokalizacja', 'brand'],
  'site.update': ['Zmiana lokalizacji', 'neutral'],
  'site.delete': ['Usunięcie lokalizacji', 'warning'],
  'tag.create': ['Nowy tag', 'brand'],
  'tag.update': ['Zmiana tagu', 'neutral'],
  'tag.delete': ['Usunięcie tagu', 'warning'],
  'term.open': ['Otwarcie terminala', 'warning'],
  'term.close': ['Zamknięcie terminala', 'neutral'],
  'proc.kill': ['Zakończenie procesu', 'warning'],
  'svc.control': ['Sterowanie usługą', 'warning'],
  'power.reboot': ['Restart komputera', 'warning'],
  'power.shutdown': ['Wyłączenie komputera', 'warning'],
  'power.cancel': ['Anulowanie restartu', 'neutral'],
  'power.logoff': ['Wylogowanie użytkowników', 'warning'],
  'power.lock': ['Blokada ekranu', 'neutral'],
  'agent.wake': ['Wybudzenie (WoL)', 'info'],
  'fs.upload': ['Wysłanie pliku', 'info'],
  'fs.download': ['Pobranie pliku', 'info'],
  'fs.delete': ['Usunięcie plików', 'warning'],
  'fs.rename': ['Zmiana nazwy pliku', 'neutral'],
  'fs.mkdir': ['Nowy folder', 'neutral'],
  'fs.edit': ['Edycja pliku', 'warning'],
  'update.check': ['Sprawdzenie wydań', 'neutral'],
  'update.policy': ['Zmiana polityki aktualizacji', 'brand'],
  'update.approve': ['Zatwierdzenie wydania', 'brand'],
  'update.rollout': ['Wdrożenie aktualizacji', 'brand'],
  'update.import': ['Import wydania', 'brand'],
  'agent.upgrade': ['Aktualizacja agenta', 'brand'],
  'desktop.open': ['Otwarcie pulpitu zdalnego', 'warning'],
  'desktop.close': ['Zamknięcie pulpitu zdalnego', 'neutral'],
  'desktop.sas': ['Ctrl+Alt+Del na pulpicie zdalnym', 'warning'],
  'desktop.take': ['Przejęcie sterowania pulpitem', 'neutral'],
  'kiosk.session_end': ['Klient zakończył sesję (dane usunięte)', 'info'],
};

export function Audit() {
  const [view, setView] = useState<'panel' | 'changes'>(() => (location.hash.includes('changes') ? 'changes' : 'panel'));
  return (
    <>
      <header className="page-head anim-rise">
        <div>
          <h1>Dziennik zdarzeń</h1>
          <div className="sub">{view === 'panel' ? 'Kto, co i kiedy zrobił w systemie' : 'Programy, system, sprzęt i zabezpieczenia na komputerach'}</div>
        </div>
      </header>
      <div className="seg anim-rise" role="tablist" aria-label="Rodzaj dziennika" style={{ alignSelf: 'flex-start', maxWidth: '100%', overflowX: 'auto' }}>
        {(
          [
            ['panel', 'Działania w panelu'],
            ['changes', 'Zmiany na komputerach'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={view === k} className={`seg-btn ${view === k ? 'on' : ''}`} onClick={() => setView(k)}>
            {label}
          </button>
        ))}
      </div>
      {view === 'panel' ? <PanelLog /> : <AllChanges />}
    </>
  );
}

function PanelLog() {
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [hideConn, setHideConn] = useState(true);
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    api.audit().then(setRows, () => {}).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const visible = hideConn ? rows.filter((r) => r.action !== 'agent.connect' && r.action !== 'agent.disconnect') : rows;

  return (
    <>
      <div className="toolbar audit-toolbar anim-rise">
        <label className="check">
          <input type="checkbox" checked={hideConn} onChange={(e) => setHideConn(e.target.checked)} /> Ukryj połączenia i rozłączenia
        </label>
        <Button icon={RefreshCw} loading={loading} onClick={load}>
          Odśwież
        </Button>
      </div>
      <div className="glass-card table-card anim-rise" style={{ animationDelay: '40ms' }}>
        <div className="table-scroll">
          <table className="table hover stack">
            <thead>
              <tr>
                <th>Czas</th>
                <th>Kto</th>
                <th>Zdarzenie</th>
                <th>Cel</th>
                <th>Szczegóły</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const [label, tone] = ACTIONS[r.action] ?? [r.action, 'neutral'];
                return (
                  <tr key={r.id} className={tone === 'danger' ? 'row-warn' : ''}>
                    <td className="small nowrap ink-2 s-end">{dateTime(r.ts)}</td>
                    <td className="mono s-meta">{r.actor.startsWith('agent:') ? `agent:${r.actor.slice(6, 14)}…` : r.actor}</td>
                    <td className="s-main">
                      <Badge variant={tone}>{label}</Badge>
                    </td>
                    <td className="mono s-meta" data-label="cel:">{r.target ? (r.target.length > 12 ? r.target.slice(0, 8) + '…' : r.target) : ''}</td>
                    <td className="mono muted s-full audit-details">{r.details}</td>
                    <td className="mono s-meta" data-label="IP:">{r.ip}</td>
                  </tr>
                );
              })}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={6} className="center-text">
                    Brak zdarzeń.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
