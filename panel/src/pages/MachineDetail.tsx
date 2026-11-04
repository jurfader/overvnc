import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ArrowLeft, Clock, Cpu, HardDrive, Info, MemoryStick, Network, Package, Pencil, RefreshCw, Search, Trash2, Users } from 'lucide-react';
import { api, errorMessage, type Agent, type AgentDetail } from '../api.ts';
import { Button, CardHead, EmptyState, Meter, Modal, OsBadge, StatTile, Status, toast } from '../components.tsx';
import { ago, bytes, dateTime, duration, platformLabel, rate } from '../format.ts';

export function MachineDetail({ id, live }: { id: string; live: Agent | undefined }) {
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [swQuery, setSwQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
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
            <span>
              {platformLabel(a.os, a.platform)} · {a.arch}
            </span>
            <span className="sep" />
            <span className="mono">{a.lastIp ?? '—'}</span>
            <span className="sep" />
            <span>agent {a.agentVersion || '?'}</span>
            <span className="sep" />
            <span>{a.online ? `połączony ${ago(a.connectedAt)}` : `ostatnio ${ago(a.lastSeen)}`}</span>
          </div>
        </div>
        <div className="toolbar">
          <Button icon={Pencil} onClick={() => setRenameOpen(true)}>
            Zmień nazwę
          </Button>
          <Button icon={RefreshCw} onClick={refresh} disabled={!a.online} loading={refreshing}>
            Odśwież inwentarz
          </Button>
          <Button variant="danger" icon={Trash2} onClick={() => setDeleteOpen(true)}>
            Usuń
          </Button>
        </div>
      </header>

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

      <RenameModal open={renameOpen} onClose={() => setRenameOpen(false)} id={id} current={a.label} hostname={a.hostname} />
      <DeleteModal open={deleteOpen} onClose={() => setDeleteOpen(false)} id={id} name={name} />
    </>
  );
}

function RenameModal({ open, onClose, id, current, hostname }: { open: boolean; onClose: () => void; id: string; current: string; hostname: string }) {
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setValue(current);
  }, [open, current]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.setLabel(id, value.trim());
      toast('Zapisano nazwę');
      onClose();
    } catch (err) {
      toast(errorMessage(err, 'Nie udało się zapisać'), 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose}>
      <form onSubmit={save} style={{ display: 'grid', gap: 16 }}>
        <h3>Zmień nazwę komputera</h3>
        <label className="field">
          Własna nazwa
          <input className="pole" value={value} onChange={(e) => setValue(e.target.value)} placeholder={hostname} maxLength={100} autoFocus />
        </label>
        <p className="small">Pozostaw puste, aby używać nazwy hosta ({hostname}).</p>
        <div className="okno-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            Anuluj
          </Button>
          <Button variant="primary" loading={busy}>
            Zapisz
          </Button>
        </div>
      </form>
    </Modal>
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
