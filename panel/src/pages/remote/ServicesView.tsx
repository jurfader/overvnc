import { useCallback, useEffect, useMemo, useState } from 'react';
import { Play, Plug, RefreshCw, RotateCw, Search, Square } from 'lucide-react';
import { api, errorMessage, type Agent, type ServiceAction, type ServiceInfo } from '../../api.ts';
import { Badge, Button, EmptyState, Modal, toast } from '../../components.tsx';

type StatusFilter = 'all' | 'running' | 'stopped' | 'failed';

const STATUS: Record<ServiceInfo['status'], { label: string; variant: 'success' | 'neutral' | 'danger' | 'warning' | 'info' }> = {
  running: { label: 'Działa', variant: 'success' },
  stopped: { label: 'Zatrzymana', variant: 'neutral' },
  failed: { label: 'Błąd', variant: 'danger' },
  starting: { label: 'Uruchamianie', variant: 'info' },
  stopping: { label: 'Zatrzymywanie', variant: 'warning' },
  other: { label: 'Inny', variant: 'neutral' },
};
const START: Record<string, string> = { auto: 'Automatyczny', manual: 'Ręczny', disabled: 'Wyłączony', static: 'Systemowy', '': '—' };
const DONE_LABEL: Record<ServiceAction, string> = { start: 'uruchomiono', stop: 'zatrzymano', restart: 'uruchomiono ponownie', enable: 'włączono autostart', disable: 'wyłączono autostart' };
const ACTION_LABEL: Record<ServiceAction, string> = { start: 'Uruchomić', stop: 'Zatrzymać', restart: 'Uruchomić ponownie', enable: 'Włączyć autostart', disable: 'Wyłączyć autostart' };

const PAGE = 150; // tyle wierszy naraz — na telefonie każdy wiersz to karta

export function ServicesView({ agent }: { agent: Agent }) {
  const [list, setList] = useState<ServiceInfo[] | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ svc: ServiceInfo; action: ServiceAction } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setList(await api.services(agent.id));
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [agent.id]);

  useEffect(() => {
    if (agent.online) void load();
  }, [agent.online, load]);

  const rows = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (list ?? [])
      .filter((s) => status === 'all' || s.status === status)
      .filter((s) => !n || s.name.toLowerCase().includes(n) || s.displayName.toLowerCase().includes(n));
  }, [list, q, status]);

  const counts = useMemo(() => {
    const c = { running: 0, failed: 0 };
    for (const s of list ?? []) if (s.status === 'running' || s.status === 'failed') c[s.status]++;
    return c;
  }, [list]);

  const run = async (svc: ServiceInfo, action: ServiceAction) => {
    setBusy(svc.name);
    try {
      await api.controlService(agent.id, svc.name, action);
      toast(`${svc.displayName}: ${DONE_LABEL[action]}`);
      await load();
    } catch (err) {
      toast(errorMessage(err), 'err');
    } finally {
      setBusy(null);
    }
  };

  if (!agent.online) return <EmptyState icon={Plug} title="Komputer jest offline" text="Usługi są dostępne, gdy komputer jest włączony." />;

  return (
    <>
      <div className="filters">
        <div className="search">
          <Search />
          <input className="pole" placeholder="Szukaj usługi…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="pole" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} aria-label="Stan">
          <option value="all">Każdy stan</option>
          <option value="running">Działające</option>
          <option value="stopped">Zatrzymane</option>
          <option value="failed">Z błędem</option>
        </select>
        <Button icon={RefreshCw} loading={loading} onClick={() => void load()}>
          Odśwież
        </Button>
        <span className="muted small" style={{ marginLeft: 'auto' }}>
          {list ? `${list.length} usług · ${counts.running} działa${counts.failed ? ` · ${counts.failed} z błędem` : ''}` : ''}
        </span>
      </div>
      {error && <div className="callout callout-warning">{error}</div>}

      <div className="glass-card table-card">
        <div className="table-scroll scroll" style={{ maxHeight: 'calc(100vh - 330px)', minHeight: 300 }}>
          <table className="table hover compact-rows stack">
            <thead className="sticky">
              <tr>
                <th>Usługa</th>
                <th>Stan</th>
                <th>Autostart</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list === null && (
                <tr>
                  <td colSpan={4} className="center-text">
                    Pobieranie listy usług…
                  </td>
                </tr>
              )}
              {rows.slice(0, limit).map((s) => {
                const st = STATUS[s.status];
                const isBusy = busy === s.name;
                const running = s.status === 'running';
                return (
                  <tr key={s.name}>
                    <td className="s-main" style={{ maxWidth: 480 }}>
                      <div className="strong ellipsis" title={s.description || s.displayName}>
                        {s.displayName}
                      </div>
                      {s.displayName !== s.name && <div className="muted mono ellipsis">{s.name}</div>}
                    </td>
                    <td className="s-meta">
                      <Badge variant={st.variant}>{st.label}</Badge>
                    </td>
                    <td className="s-meta" data-label="Autostart:">
                      {s.startType && s.startType !== 'static' && agent.os !== 'darwin' ? (
                        <select
                          className="pole"
                          style={{ width: 'auto', height: 30, fontSize: 12.5 }}
                          value={s.startType === 'auto' ? 'enable' : 'disable'}
                          disabled={isBusy}
                          onChange={(e) => setConfirm({ svc: s, action: e.target.value as ServiceAction })}
                          aria-label="Autostart"
                        >
                          <option value="enable">Automatyczny</option>
                          <option value="disable">{s.startType === 'manual' ? 'Ręczny' : 'Wyłączony'}</option>
                        </select>
                      ) : (
                        <span className="small ink-2">{START[s.startType]}</span>
                      )}
                    </td>
                    <td className="s-end">
                      <div className="menu-actions">
                        {isBusy ? (
                          <span className="spinner" style={{ margin: 8 }} />
                        ) : (
                          <>
                            {!running && <Button size="sm" variant="ghost" icon={Play} title="Uruchom" onClick={() => void run(s, 'start')} />}
                            {running && <Button size="sm" variant="ghost" icon={RotateCw} title="Uruchom ponownie" onClick={() => setConfirm({ svc: s, action: 'restart' })} />}
                            {running && <Button size="sm" variant="ghost" icon={Square} title="Zatrzymaj" onClick={() => setConfirm({ svc: s, action: 'stop' })} />}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {rows.length > limit && (
          <div className="show-more">
            <Button variant="ghost" onClick={() => setLimit((n) => n + PAGE)}>
              Pokaż więcej ({rows.length - limit} usług)
            </Button>
          </div>
        )}
      </div>

      <Modal open={!!confirm} onClose={() => setConfirm(null)}>
        {confirm && (
          <>
            <h3>
              {ACTION_LABEL[confirm.action]} „{confirm.svc.displayName}”?
            </h3>
            <p>
              {confirm.action === 'stop'
                ? 'Programy zależne od tej usługi mogą przestać działać.'
                : confirm.action === 'restart'
                  ? 'Usługa będzie przez chwilę niedostępna.'
                  : confirm.action === 'disable'
                    ? 'Usługa nie uruchomi się automatycznie po restarcie komputera.'
                    : 'Usługa będzie uruchamiana automatycznie razem z systemem.'}
            </p>
            <div className="okno-actions">
              <Button variant="ghost" onClick={() => setConfirm(null)}>
                Anuluj
              </Button>
              <Button
                variant={confirm.action === 'stop' || confirm.action === 'disable' ? 'danger' : 'primary'}
                onClick={() => {
                  const c = confirm;
                  setConfirm(null);
                  void run(c.svc, c.action);
                }}
              >
                {ACTION_LABEL[confirm.action]}
              </Button>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
