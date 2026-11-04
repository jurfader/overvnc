import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Activity, ArrowLeft, Building2, CloudDownload, Cog, MonitorSmartphone, FolderOpen, LayoutDashboard, TerminalSquare, Clock, Cpu, HardDrive, Info, MemoryStick, Network, Package, Pencil, RefreshCw, Search, Trash2, Users } from 'lucide-react';
import { api, errorMessage, type Agent, type AgentDetail } from '../api.ts';
import { Button, CardHead, ClientLabel, EmptyState, Meter, Modal, OsBadge, StatTile, Status, TagChip, toast } from '../components.tsx';
import { useMe } from '../state.tsx';
import { OrganizeModal } from './organize.tsx';
import { ProcessesView } from './remote/ProcessesView.tsx';
import { ServicesView } from './remote/ServicesView.tsx';
import { FilesView } from './remote/FilesView.tsx';
import { PowerMenu, WakeButton } from './remote/PowerMenu.tsx';
import { ago, bytes, dateTime, duration, platformLabel, rate } from '../format.ts';

// xterm.js waży ~400 kB — ładujemy go dopiero przy otwarciu terminala
const DesktopView = lazy(() => import('./remote/DesktopView.tsx').then((m) => ({ default: m.DesktopView })));
const TerminalView = lazy(() => import('./remote/TerminalView.tsx').then((m) => ({ default: m.TerminalView })));

export type DetailTab = 'overview' | 'desktop' | 'terminal' | 'files' | 'processes' | 'services';

const TABS: { key: DetailTab; label: string; icon: typeof Info }[] = [
  { key: 'overview', label: 'Przegląd', icon: LayoutDashboard },
  { key: 'desktop', label: 'Pulpit', icon: MonitorSmartphone },
  { key: 'terminal', label: 'Terminal', icon: TerminalSquare },
  { key: 'files', label: 'Pliki', icon: FolderOpen },
  { key: 'processes', label: 'Procesy', icon: Activity },
  { key: 'services', label: 'Usługi', icon: Cog },
];

export function MachineDetail({ id, live, tab = 'overview', filePath = null }: { id: string; live: Agent | undefined; tab?: DetailTab; filePath?: string | null }) {
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [swQuery, setSwQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [updating, setUpdating] = useState(false);
  const { can } = useMe();
  const remote = can('agents.remote');
  const [deleteOpen, setDeleteOpen] = useState(false);

  // pobierz szczegóły przy wejściu i za każdym razem, gdy serwer zgłosi nowy inwentarz
  useEffect(() => {
    api.agent(id).then(
      (d) => setDetail(d),
      () => setNotFound(true),
    );
  }, [id, live?.rev]);

  const software = useMemo(() => {
    const list = detail?.inventory?.software ?? [];
    const n = swQuery.trim().toLowerCase();
    return n ? list.filter((s) => `${s.name} ${s.publisher ?? ''}`.toLowerCase().includes(n)) : list;
  }, [detail, swQuery]);

  if (notFound)
    return (
      <EmptyState icon={Info} title="Nie znaleziono komputera" text="Mógł zostać usunięty z panelu.">
        <a className="btn btn-secondary" href="#/">
          <ArrowLeft /> Wróć do listy
        </a>
      </EmptyState>
    );
  if (!detail) return <div className="center-page">Ładowanie…</div>;

  const a = { ...detail, ...(live ?? {}) };
  const inv = detail.inventory;
  const m = a.online ? a.metrics : null;
  const name = a.label || a.hostname;

  const refresh = async () => {
    setRefreshing(true);
    try {
      await api.refreshInventory(id);
      toast('Inwentarz zaktualizowany');
    } catch (err) {
      toast(errorMessage(err), 'err');
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <>
      <header className="page-head anim-rise">
        <div>
          <a href="#/" className="back">
            <ArrowLeft /> Komputery
          </a>
          <h1>
            {name} <Status online={a.online} />
          </h1>
          <div className="sub">
            {a.label && (
              <>
                <span>{a.hostname}</span>
                <span className="sep" />
              </>
            )}
            <OsBadge os={a.os} />
            <span>{[platformLabel(a.os, a.platform), a.arch].filter(Boolean).join(' · ')}</span>
            <span className="sep" />
            <span className="mono">{a.lastIp ?? '—'}</span>
            <span className="sep" />
            <span>agent {a.agentVersion || '?'}</span>
            <span className="sep" />
            <span>{a.online ? `połączony ${ago(a.connectedAt)}` : `ostatnio ${ago(a.lastSeen)}`}</span>
          </div>
        </div>
        <div className="toolbar">
          {remote && a.online && <PowerMenu agent={a} />}
          {remote && !a.online && <WakeButton agent={a} />}
          {can('agents.manage') && (
            <Button icon={Pencil} onClick={() => setEditOpen(true)}>
              Edytuj
            </Button>
          )}
          {can('agents.manage') && a.online && a.capabilities.includes('update.check') && (
            <Button
              icon={CloudDownload}
              loading={updating}
              onClick={async () => {
                setUpdating(true);
                try {
                  const r = await api.upgradeAgent(id);
                  toast(r.status === 'restarting' ? 'Aktualizacja zainstalowana — agent uruchamia się ponownie' : r.status === 'up_to_date' ? `Agent jest aktualny (${r.version})` : `Stan: ${r.status}`);
                } catch (err) {
                  toast(errorMessage(err), 'err');
                } finally {
                  setUpdating(false);
                }
              }}
            >
              Aktualizuj agenta
            </Button>
          )}
          {can('agents.refresh') && (
            <Button icon={RefreshCw} onClick={refresh} disabled={!a.online} loading={refreshing} title={a.online ? undefined : 'Komputer jest offline'}>
              Odśwież inwentarz
            </Button>
          )}
          {can('agents.manage') && (
            <Button variant="danger" icon={Trash2} onClick={() => setDeleteOpen(true)}>
              Usuń
            </Button>
          )}
        </div>
      </header>

      {remote && (
        <nav className="detail-tabs anim-rise" aria-label="Widoki komputera">
          {TABS.map((t) => (
            <a key={t.key} href={`#/m/${id}${t.key === 'overview' ? '' : '/' + t.key}`} className={`detail-tab ${tab === t.key ? 'on' : ''}`} aria-current={tab === t.key ? 'page' : undefined}>
              <t.icon /> {t.label}
            </a>
          ))}
        </nav>
      )}

      {tab === 'desktop' && remote && (
        <Suspense fallback={<div className="center-page">Ładowanie…</div>}>
          <DesktopView agent={a} />
        </Suspense>
      )}
      {tab === 'terminal' && remote && (
        <Suspense fallback={<div className="center-page">Ładowanie terminala…</div>}>
          <TerminalView agent={a} />
        </Suspense>
      )}
      {tab === 'files' && remote && <FilesView agent={a} initialPath={filePath} />}
      {tab === 'processes' && remote && <ProcessesView agent={a} />}
      {tab === 'services' && remote && <ServicesView agent={a} />}
      {(tab === 'overview' || !remote) && (
        <>
        <section className="grid grid-stats">
          <StatTile icon={Cpu} label="Procesor" hint={m?.load ? `load ${m.load.join(' / ')}` : `${m?.processes ?? '—'} procesów`}>
            <Meter value={m?.cpuPercent} />
          </StatTile>
          <StatTile icon={MemoryStick} label="Pamięć" hint={`swap ${bytes(m?.swapUsed)}`} delay={40}>
            <Meter value={m?.memPercent} caption={m ? `${bytes(m.memUsed)} / ${bytes(m.memTotal)}` : undefined} />
          </StatTile>
          <StatTile icon={Network} label="Sieć" delay={80}>
            <div className="stat-value md">↓ {rate(m?.netRxBps)}</div>
            <div className="stat-value md ink-2">↑ {rate(m?.netTxBps)}</div>
          </StatTile>
          <StatTile icon={Clock} label="Czas pracy" value={<span className="md stat-value">{duration(m?.uptime)}</span>} delay={120}>
            <div className="stat-hint" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Users size={13} /> {m?.activeUsers?.join(', ') || 'nikt nie jest zalogowany'}
            </div>
          </StatTile>
        </section>

        <section className="glass-card card anim-rise" style={{ animationDelay: '140ms' }}>
          <CardHead icon={Building2} title="Organizacja">
            {can('agents.manage') && (
              <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditOpen(true)}>
                Zmień
              </Button>
            )}
          </CardHead>
          <dl className="props">
            <dt>Klient</dt>
            <dd>
              <ClientLabel name={a.clientName} color={a.clientColor} site={a.siteName} />
            </dd>
            <dt>Tagi</dt>
            <dd>
              {a.tags.length ? (
                <div className="chips">
                  {a.tags.map((t) => (
                    <TagChip key={t.id} name={t.name} color={t.color} />
                  ))}
                </div>
              ) : (
                <span className="muted small">brak</span>
              )}
            </dd>
            <dt>Notatki</dt>
            <dd className="pre">{a.notes || <span className="muted small">brak</span>}</dd>
            <dt>Zarejestrowany</dt>
            <dd>{dateTime(a.enrolledAt)}</dd>
          </dl>
        </section>

        {!inv ? (
          <EmptyState icon={Package} title="Brak inwentarza" text="Agent nie przesłał jeszcze danych o systemie." />
        ) : (
          <>
            <section className="grid grid-2 anim-rise" style={{ animationDelay: '160ms' }}>
              <div className="glass-card card">
                <CardHead icon={Info} title="System" />
                <dl className="props">
                  <dt>System</dt>
                  <dd>{platformLabel(a.os, `${inv.host.platform} ${inv.host.platformVersion}`)}</dd>
                  <dt>Jądro</dt>
                  <dd className="mono">{inv.host.kernelVersion}</dd>
                  <dt>Architektura</dt>
                  <dd>{inv.host.arch}</dd>
                  <dt>Uruchomiony</dt>
                  <dd>{dateTime(inv.host.bootTime * 1000)}</dd>
                  {inv.host.virtualization && (
                    <>
                      <dt>Wirtualizacja</dt>
                      <dd>{inv.host.virtualization}</dd>
                    </>
                  )}
                  <dt>Host ID</dt>
                  <dd className="mono">{inv.host.hostId}</dd>
                  <dt>Inwentarz z</dt>
                  <dd>{dateTime(inv.collectedAt)}</dd>
                </dl>
              </div>
              <div className="glass-card card">
                <CardHead icon={Cpu} title="Sprzęt" />
                <dl className="props">
                  <dt>Procesor</dt>
                  <dd>{inv.cpu.model || '—'}</dd>
                  <dt>Rdzenie</dt>
                  <dd>
                    {inv.cpu.cores} rdzeni · {inv.cpu.threads} wątków
                  </dd>
                  <dt>Pamięć RAM</dt>
                  <dd>{bytes(inv.memory.total)}</dd>
                  <dt>Swap</dt>
                  <dd>{bytes(inv.memory.swapTotal)}</dd>
                </dl>
              </div>
            </section>

            <section className="grid grid-2 anim-rise" style={{ animationDelay: '200ms' }}>
              <div className="glass-card card">
                <CardHead icon={HardDrive} title="Dyski" />
                <table className="table compact">
                  <tbody>
                    {(m?.disks ?? inv.disks ?? []).map((d) => (
                      <tr key={d.mountpoint}>
                        <td className="mono">{d.mountpoint}</td>
                        <td style={{ width: '60%' }}>
                          <Meter value={d.usedPercent} caption={`${bytes(d.used)} / ${bytes(d.total)}`} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="glass-card card">
                <CardHead icon={Network} title="Interfejsy sieciowe" />
                <table className="table compact">
                  <tbody>
                    {(inv.network ?? []).map((n) => (
                      <tr key={n.name}>
                        <td>
                          <div className="strong">{n.name}</div>
                          <div className="muted mono">{n.mac || '—'}</div>
                        </td>
                        <td className="mono pre">{(n.addrs ?? []).join('\n')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="glass-card card anim-rise" style={{ animationDelay: '240ms' }}>
              <CardHead icon={Package} title={`Oprogramowanie (${inv.software?.length ?? 0})`}>
                <div className="search" style={{ width: 260 }}>
                  <Search />
                  <input className="pole" placeholder="Szukaj programu…" value={swQuery} onChange={(e) => setSwQuery(e.target.value)} />
                </div>
              </CardHead>
              {inv.softwareError && <div className="form-error">{inv.softwareError}</div>}
              <div className="scroll">
                <table className="table compact">
                  <thead className="sticky">
                    <tr>
                      <th>Nazwa</th>
                      <th>Wersja</th>
                      <th>Wydawca</th>
                    </tr>
                  </thead>
                  <tbody>
                    {software.map((s, i) => (
                      <tr key={`${s.name}-${i}`}>
                        <td>{s.name}</td>
                        <td className="mono">{s.version}</td>
                        <td className="muted small">{s.publisher}</td>
                      </tr>
                    ))}
                    {software.length === 0 && (
                      <tr>
                        <td colSpan={3} className="center-text">
                          Brak wyników.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
        </>
      )}


      <OrganizeModal agent={a} open={editOpen} onClose={() => setEditOpen(false)} />
      <DeleteModal open={deleteOpen} onClose={() => setDeleteOpen(false)} id={id} name={name} />
    </>
  );
}

function DeleteModal({ open, onClose, id, name }: { open: boolean; onClose: () => void; id: string; name: string }) {
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteAgent(id);
      toast(`Usunięto ${name}`);
      location.hash = '/';
    } catch (err) {
      toast(errorMessage(err, 'Nie udało się usunąć'), 'err');
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose}>
      <h3>Usunąć „{name}”?</h3>
      <p>Agent na tym komputerze natychmiast straci dostęp. Aby znów nim zarządzać, trzeba będzie zarejestrować go ponownie nowym tokenem.</p>
      <div className="okno-actions">
        <Button variant="ghost" onClick={onClose}>
          Anuluj
        </Button>
        <Button variant="danger" icon={Trash2} loading={busy} onClick={remove}>
          Usuń komputer
        </Button>
      </div>
    </Modal>
  );
}
