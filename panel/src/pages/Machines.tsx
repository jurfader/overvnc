import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, Building2, FileTerminal, FilterX, MessageSquareText, Monitor, PlusCircle, Power, RotateCw, Search, Tag as TagIcon, Wifi, X } from 'lucide-react';
import type { Agent } from '../api.ts';
import { Badge, Button, Checkbox, ClientLabel, EmptyState, Meter, OsBadge, osIcon, StatTile, Status, TagChip } from '../components.tsx';
import { ago, bytes, platformLabel, plural } from '../format.ts';
import { useAlerts, useMe, useOrg } from '../state.tsx';
import { BulkModal, type BulkMode } from './organize.tsx';
import { NewJobModal } from './Jobs.tsx';
import { SecurityShield } from './protection.tsx';
import type { JobKind } from '../api.ts';

type StatusFilter = 'all' | 'online' | 'offline' | 'alert';


const NONE = -1; // filtr „bez klienta”

export function Machines({ agents, initialClient }: { agents: Agent[]; initialClient: number | null }) {
  const { can, me } = useMe();
  const { clients, tags } = useOrg();
  const { byAgent } = useAlerts();
  /** Komputer wymaga uwagi, gdy ma otwarte alerty (wg reguł z zakładki Alerty). */
  const alerts = (a: Agent): string[] => (byAgent.get(a.id) ?? []).map((x) => x.title);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [clientF, setClientF] = useState<number | null>(initialClient);
  const [siteF, setSiteF] = useState<number | null>(null);
  const [tagF, setTagF] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<BulkMode | null>(null);
  const manage = can('agents.manage');
  const remote = can('agents.remote');
  /** zaznaczanie: porządkowanie (admin) albo akcje grupowe (technik) */
  const selectable = manage || remote;
  const [jobKind, setJobKind] = useState<JobKind | null>(null);

  useEffect(() => setClientF(initialClient), [initialClient]);
  useEffect(() => setSiteF(null), [clientF]);

  const online = agents.filter((a) => a.online).length;
  const alerting = agents.filter((a) => alerts(a).length > 0).length;
  const sites = clients.find((c) => c.id === clientF)?.sites ?? [];
  const filtersActive = !!q || status !== 'all' || clientF !== null || tagF !== null;

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return agents
      .filter((a) => status === 'all' || (status === 'alert' ? alerts(a).length > 0 : (status === 'online') === a.online))
      .filter((a) => clientF === null || (clientF === NONE ? a.clientId === null : a.clientId === clientF))
      .filter((a) => siteF === null || a.siteId === siteF)
      .filter((a) => tagF === null || a.tags.some((t) => t.id === tagF))
      .filter(
        (a) =>
          !needle ||
          [a.hostname, a.label, a.platform, a.lastIp ?? '', a.clientName ?? '', a.siteName ?? '', a.notes, ...a.tags.map((t) => t.name)].some((s) =>
            s.toLowerCase().includes(needle),
          ),
      )
      .sort((a, b) => Number(b.online) - Number(a.online) || (a.label || a.hostname).localeCompare(b.label || b.hostname, 'pl'));
  }, [agents, q, status, clientF, siteF, tagF, byAgent]); // eslint-disable-line react-hooks/exhaustive-deps

  // zaznaczenie obejmuje tylko widoczne wiersze — po zmianie filtrów czyścimy niewidoczne
  useEffect(() => {
    setSelected((prev) => {
      const visible = new Set(rows.map((r) => r.id));
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [rows]);

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = (v: boolean) => setSelected(v ? new Set(rows.map((r) => r.id)) : new Set());
  const toggle = (id: string, v: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (v) next.add(id);
      else next.delete(id);
      return next;
    });

  const clearFilters = () => {
    setQ('');
    setStatus('all');
    setClientF(null);
    setTagF(null);
  };

  if (agents.length === 0)
    return (
      <>
        <PageHead />
        <EmptyState
          icon={Monitor}
          title="Brak komputerów"
          text={me.allClients ? 'Utwórz token rejestracji i zainstaluj agenta OVERVNC na pierwszym komputerze.' : 'Twoi klienci nie mają jeszcze komputerów.'}
        >
          {can('tokens.manage') && (
            <a className="btn btn-primary" href="#/tokens">
              <PlusCircle /> Dodaj pierwszy komputer
            </a>
          )}
        </EmptyState>
      </>
    );

  return (
    <>
      <PageHead />

      <section className="grid grid-stats">
        <StatTile icon={Monitor} label="Wszystkie komputery" value={agents.length} hint={clients.length ? `u ${clients.length} ${plural(clients.length, 'klienta', 'klientów', 'klientów')}` : 'zarejestrowane w panelu'} />
        <StatTile icon={Wifi} label="Online" value={online} hint={`${agents.length ? Math.round((online / agents.length) * 100) : 0}% floty`} delay={40} />
        <StatTile icon={Power} label="Offline" value={agents.length - online} hint="wyłączone lub bez sieci" delay={80} />
        <StatTile icon={AlertTriangle} label="Wymagają uwagi" value={alerting} hint="mają otwarte alerty" delay={120} />
      </section>

      <div className="filters anim-rise" style={{ animationDelay: '140ms' }}>
        <div className="search">
          <Search />
          <input className="pole" placeholder="Szukaj: nazwa, IP, klient, tag…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="pole" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} aria-label="Status">
          <option value="all">Każdy status</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
          <option value="alert">Wymagają uwagi</option>
        </select>
        {clients.length > 0 && (
          <select className="pole" value={clientF ?? ''} onChange={(e) => setClientF(e.target.value === '' ? null : Number(e.target.value))} aria-label="Klient">
            <option value="">Wszyscy klienci</option>
            {me.allClients && <option value={NONE}>— bez klienta —</option>}
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        {sites.length > 0 && (
          <select className="pole" value={siteF ?? ''} onChange={(e) => setSiteF(e.target.value === '' ? null : Number(e.target.value))} aria-label="Lokalizacja">
            <option value="">Wszystkie lokalizacje</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        {tags.length > 0 && (
          <select className="pole" value={tagF ?? ''} onChange={(e) => setTagF(e.target.value === '' ? null : Number(e.target.value))} aria-label="Tag">
            <option value="">Wszystkie tagi</option>
            {tags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}
        {filtersActive && (
          <Button variant="ghost" icon={FilterX} onClick={clearFilters}>
            Wyczyść
          </Button>
        )}
      </div>

      {selectable && selected.size > 0 && (
        <div className="bulk-bar anim-pop">
          <span className="count">
            Zaznaczono: {selected.size} {plural(selected.size, 'komputer', 'komputery', 'komputerów')}
          </span>
          {remote && (
            <>
              <Button size="sm" variant="primary" icon={FileTerminal} onClick={() => setJobKind('script')}>
                Skrypt
              </Button>
              <Button size="sm" icon={MessageSquareText} onClick={() => setJobKind('message')}>
                Komunikat
              </Button>
              <Button size="sm" icon={RotateCw} onClick={() => setJobKind('power')}>
                Restart
              </Button>
            </>
          )}
          {manage && (
            <>
              <Button size="sm" icon={Building2} onClick={() => setBulk('place')}>
                Przypisz do klienta
              </Button>
              <Button size="sm" icon={TagIcon} onClick={() => setBulk('addTags')}>
                Dodaj tagi
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setBulk('removeTags')}>
                Usuń tagi
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" icon={X} title="Odznacz" onClick={() => setSelected(new Set())} />
        </div>
      )}

      <div className="glass-card table-card anim-rise" style={{ animationDelay: '160ms' }}>
        {selectable && rows.length > 0 && (
          <label className="only-mobile mobile-selectall">
            <Checkbox label="Zaznacz wszystkie" checked={allSelected} indeterminate={selected.size > 0 && !allSelected} onChange={toggleAll} /> Zaznacz wszystkie ({rows.length})
          </label>
        )}
        <div className="table-scroll">
          <table className="table hover clickable stack">
            <thead>
              <tr>
                {selectable && (
                  <th className="cb-cell">
                    <Checkbox label="Zaznacz wszystkie" checked={allSelected} indeterminate={selected.size > 0 && !allSelected} onChange={toggleAll} />
                  </th>
                )}
                <th>Komputer</th>
                <th>Klient</th>
                <th>Status</th>
                <th>System</th>
                <th className="w-bar">CPU</th>
                <th className="w-bar">Pamięć</th>
                <th className="w-bar">Dysk</th>
                <th>Aktywność</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const m = a.online ? a.metrics : null;
                const disk = m?.disks?.reduce((x, d) => (d.usedPercent > x.usedPercent ? d : x), m.disks[0]);
                const Icon = osIcon(a.os);
                const warn = alerts(a);
                const isSel = selected.has(a.id);
                return (
                  <tr key={a.id} className={isSel ? 'row-selected' : ''} onClick={() => (location.hash = `/m/${a.id}`)}>
                    {selectable && (
                      <td className="cb-cell" onClick={(e) => e.stopPropagation()}>
                        <Checkbox label={`Zaznacz ${a.label || a.hostname}`} checked={isSel} onChange={(v) => toggle(a.id, v)} />
                      </td>
                    )}
                    <td className="s-main">
                      <div className="host">
                        <span className={`host-icon ${a.online ? 'on' : ''}`}>
                          <Icon />
                        </span>
                        <div style={{ minWidth: 0 }}>
                          <div className="strong">{a.label || a.hostname}</div>
                          <div className="muted small">{a.label ? a.hostname : (a.lastIp ?? '—')}</div>
                          {a.tags.length > 0 && (
                            <div className="chips" style={{ marginTop: 4 }}>
                              {a.tags.map((t) => (
                                <TagChip key={t.id} name={t.name} color={t.color} />
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="s-full">
                      <ClientLabel name={a.clientName} color={a.clientColor} site={a.siteName} />
                    </td>
                    <td className="s-end">
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'inherit' }}>
                        <Status online={a.online} />
                        <SecurityShield security={a.security} />
                        {warn.length > 0 && (
                          <span className="only-desktop">
                            <Badge variant="danger">
                              <AlertTriangle /> {warn.join(', ')}
                            </Badge>
                          </span>
                        )}
                      </div>
                    </td>
                    {warn.length > 0 && (
                      <td className="s-full only-mobile">
                        <Badge variant="danger">
                          <AlertTriangle /> {warn.join(', ')}
                        </Badge>
                      </td>
                    )}
                    <td className="s-hide">
                      <OsBadge os={a.os} />
                      <div className="muted small" style={{ marginTop: 4 }}>
                        {platformLabel(a.os, a.platform)}
                      </div>
                    </td>
                    <td className={m ? 's-meta w-bar' : 's-hide'} data-label="CPU">
                      <Meter value={m?.cpuPercent} />
                    </td>
                    <td className={m ? 's-meta w-bar' : 's-hide'} data-label="RAM">
                      <Meter value={m?.memPercent} caption={m ? `${bytes(m.memUsed, 0)} / ${bytes(m.memTotal, 0)}` : undefined} />
                    </td>
                    <td className={m ? 's-meta w-bar' : 's-hide'} data-label="Dysk">
                      <Meter value={disk?.usedPercent} caption={disk?.mountpoint} />
                    </td>
                    <td className={`small ink-2 nowrap ${a.online ? 's-hide' : 's-meta'}`} data-label="Ostatnio">
                      {a.online ? 'teraz' : ago(a.lastSeen)}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={selectable ? 9 : 8} className="center-text">
                    Brak komputerów pasujących do filtrów.{' '}
                    <button className="link-btn" style={{ display: 'inline-flex' }} onClick={clearFilters}>
                      Wyczyść filtry
                    </button>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <NewJobModal open={jobKind !== null} onClose={() => setJobKind(null)} agents={agents} preselected={[...selected]} initialKind={jobKind ?? 'script'} />

      <BulkModal
        mode={bulk}
        ids={[...selected]}
        onClose={() => setBulk(null)}
        onDone={() => {
          setBulk(null);
          setSelected(new Set());
        }}
      />
    </>
  );
}

function PageHead({ children }: { children?: ReactNode }) {
  return (
    <header className="page-head anim-rise">
      <div>
        <h1>Komputery</h1>
        <div className="sub">Stan wszystkich zarządzanych komputerów na żywo</div>
      </div>
      {children && <div className="toolbar">{children}</div>}
    </header>
  );
}
