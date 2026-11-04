import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Plug, RefreshCw, Search, XCircle } from 'lucide-react';
import { api, errorMessage, type Agent, type ProcInfo } from '../../api.ts';
import { Button, EmptyState, Modal, toast } from '../../components.tsx';
import { bytes, dateTime } from '../../format.ts';

type SortKey = 'cpu' | 'memRss' | 'name' | 'pid';

const PAGE = 150; // tyle wierszy naraz — na telefonie każdy wiersz to karta

export function ProcessesView({ agent }: { agent: Agent }) {
  const [list, setList] = useState<ProcInfo[] | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [auto, setAuto] = useState(true);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'cpu', desc: true });
  const [kill, setKill] = useState<ProcInfo | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setList(await api.processes(agent.id));
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [agent.id]);

  useEffect(() => {
    if (!agent.online) return;
    void load();
    if (!auto) return;
    const t = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(t);
  }, [agent.online, auto, load]);

  const rows = useMemo(() => {
    const n = q.trim().toLowerCase();
    const filtered = (list ?? []).filter((p) => !n || p.name.toLowerCase().includes(n) || String(p.pid) === n || p.user.toLowerCase().includes(n) || p.cmdline.toLowerCase().includes(n));
    const dir = sort.desc ? -1 : 1;
    return filtered.sort((a, b) => {
      const x = a[sort.key];
      const y = b[sort.key];
      return (typeof x === 'string' ? x.localeCompare(y as string, 'pl') : (x as number) - (y as number)) * dir;
    });
  }, [list, q, sort]);

  const totalCpu = (list ?? []).reduce((s, p) => s + p.cpu, 0);

  if (!agent.online) return <EmptyState icon={Plug} title="Komputer jest offline" text="Lista procesów jest dostępna, gdy komputer jest włączony." />;

  const th = (key: SortKey, label: string, right = false) => (
    <th className={right ? 'right' : ''}>
      <button className="th-sort" onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== 'name' }))}>
        {label}
        {sort.key === key && (sort.desc ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}
      </button>
    </th>
  );

  return (
    <>
      <div className="filters">
        <div className="search">
          <Search />
          <input className="pole" placeholder="Szukaj: nazwa, PID, użytkownik, polecenie…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <label className="check">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Odświeżaj co 5 s
        </label>
        <select
          className="pole only-mobile"
          aria-label="Sortowanie"
          value={`${sort.key}:${sort.desc ? 'd' : 'a'}`}
          onChange={(e) => {
            const [key, d] = e.target.value.split(':');
            setSort({ key: key as SortKey, desc: d === 'd' });
          }}
        >
          <option value="cpu:d">Sortuj: CPU (najwięcej)</option>
          <option value="memRss:d">Sortuj: pamięć (najwięcej)</option>
          <option value="name:a">Sortuj: nazwa A–Z</option>
          <option value="pid:a">Sortuj: PID</option>
        </select>
        <Button icon={RefreshCw} loading={loading} onClick={() => void load()}>
          Odśwież
        </Button>
        <span className="muted small" style={{ marginLeft: 'auto' }}>
          {list ? `${list.length} procesów · łącznie CPU ${Math.min(100, totalCpu).toFixed(0)}%` : ''}
        </span>
      </div>
      {error && <div className="callout callout-warning">{error}</div>}

      <div className="glass-card table-card">
        <div className="table-scroll scroll" style={{ maxHeight: 'calc(100vh - 330px)', minHeight: 300 }}>
          <table className="table hover compact-rows stack">
            <thead className="sticky">
              <tr>
                {th('name', 'Proces')}
                {th('pid', 'PID', true)}
                <th>Użytkownik</th>
                {th('cpu', 'CPU', true)}
                {th('memRss', 'Pamięć', true)}
                <th>Uruchomiony</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list === null && (
                <tr>
                  <td colSpan={7} className="center-text">
                    Pobieranie listy procesów…
                  </td>
                </tr>
              )}
              {rows.slice(0, limit).map((p) => (
                <tr key={p.pid}>
                  <td className="s-main" style={{ maxWidth: 420 }}>
                    <div className="strong">{p.name}</div>
                    {p.cmdline && (
                      <div className="muted mono ellipsis" title={p.cmdline}>
                        {p.cmdline}
                      </div>
                    )}
                  </td>
                  <td className="mono right s-meta" data-label="PID">{p.pid}</td>
                  <td className="small ink-2 s-meta" data-label="Użytkownik">{p.user || '—'}</td>
                  <td className="right s-meta" data-label="CPU">
                    <span className={`num ${p.cpu >= 50 ? 'hot' : p.cpu >= 15 ? 'warm' : ''}`}>{p.cpu.toFixed(1)}%</span>
                  </td>
                  <td className="right mono s-meta" data-label="RAM">{bytes(p.memRss)}</td>
                  <td className="small ink-2 nowrap s-hide">{p.started ? dateTime(p.started) : '—'}</td>
                  <td className="right s-end">
                    <Button size="sm" variant="ghost" icon={XCircle} title="Zakończ proces" onClick={() => setKill(p)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length > limit && (
          <div className="show-more">
            <Button variant="ghost" onClick={() => setLimit((n) => n + PAGE)}>
              Pokaż więcej ({rows.length - limit} procesów)
            </Button>
          </div>
        )}
      </div>
      <KillModal agentId={agent.id} proc={kill} onClose={() => setKill(null)} onDone={() => void load()} />
    </>
  );
}

function KillModal({ agentId, proc, onClose, onDone }: { agentId: string; proc: ProcInfo | null; onClose: () => void; onDone: () => void }) {
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setForce(false), [proc]);
  return (
    <Modal open={!!proc} onClose={onClose}>
      {proc && (
        <>
          <h3>
            Zakończyć „{proc.name}” <span className="muted">(PID {proc.pid})</span>?
          </h3>
          <p>Niezapisane dane w tym programie mogą zostać utracone.</p>
          <label className="check">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Wymuś natychmiastowe zakończenie (gdy program nie odpowiada)
          </label>
          <div className="okno-actions">
            <Button variant="ghost" onClick={onClose}>
              Anuluj
            </Button>
            <Button
              variant="danger"
              icon={XCircle}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.killProcess(agentId, proc.pid, force, proc.name);
                  toast(`Zakończono ${proc.name}`);
                  onDone();
                  onClose();
                } catch (err) {
                  toast(errorMessage(err), 'err');
                } finally {
                  setBusy(false);
                }
              }}
            >
              Zakończ proces
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
