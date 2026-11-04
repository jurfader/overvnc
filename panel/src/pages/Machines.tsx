import { useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, Monitor, PlusCircle, Power, Search, Wifi } from 'lucide-react';
import type { Agent } from '../api.ts';
import { Badge, EmptyState, Meter, OsBadge, osIcon, StatTile, Status } from '../components.tsx';
import { ago, bytes, platformLabel } from '../format.ts';

type Filter = 'all' | 'online' | 'offline' | 'alert';

/** Komputer wymaga uwagi, gdy CPU, RAM lub któryś dysk przekracza 90%. */
function alerts(a: Agent): string[] {
  const m = a.online ? a.metrics : null;
  if (!m) return [];
  const out: string[] = [];
  if (m.cpuPercent >= 90) out.push('CPU');
  if (m.memPercent >= 90) out.push('RAM');
  for (const d of m.disks ?? []) if (d.usedPercent >= 90) out.push(`dysk ${d.mountpoint}`);
  return out;
}

export function Machines({ agents }: { agents: Agent[] }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const online = agents.filter((a) => a.online).length;
  const alerting = agents.filter((a) => alerts(a).length > 0).length;

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return agents
      .filter((a) => filter === 'all' || (filter === 'alert' ? alerts(a).length > 0 : (filter === 'online') === a.online))
      .filter((a) => !needle || [a.hostname, a.label, a.platform, a.lastIp ?? ''].some((s) => s.toLowerCase().includes(needle)))
      .sort((a, b) => Number(b.online) - Number(a.online) || (a.label || a.hostname).localeCompare(b.label || b.hostname, 'pl'));
  }, [agents, q, filter]);

  if (agents.length === 0)
    return (
      <>
        <PageHead />
        <EmptyState icon={Monitor} title="Brak komputerów" text="Utwórz token rejestracji i zainstaluj agenta OVERVNC na pierwszym komputerze.">
          <a className="btn btn-primary" href="#/tokens">
            <PlusCircle /> Dodaj pierwszy komputer
          </a>
        </EmptyState>
      </>
    );

  return (
    <>
      <PageHead>
        <div className="search">
          <Search />
          <input className="pole" placeholder="Szukaj: nazwa, system, IP…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="pole" style={{ width: 'auto' }} value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
          <option value="all">Wszystkie</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
          <option value="alert">Wymagają uwagi</option>
        </select>
      </PageHead>

      <section className="grid grid-stats">
        <StatTile icon={Monitor} label="Wszystkie komputery" value={agents.length} hint="zarejestrowane w panelu" />
        <StatTile icon={Wifi} label="Online" value={online} hint={`${agents.length ? Math.round((online / agents.length) * 100) : 0}% floty`} delay={40} />
        <StatTile icon={Power} label="Offline" value={agents.length - online} hint="wyłączone lub bez sieci" delay={80} />
        <StatTile icon={AlertTriangle} label="Wymagają uwagi" value={alerting} hint="CPU, RAM lub dysk ≥ 90%" delay={120} />
      </section>

      <div className="glass-card table-card anim-rise" style={{ animationDelay: '160ms' }}>
        <div className="table-scroll">
          <table className="table hover clickable">
            <thead>
              <tr>
                <th>Komputer</th>
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
                return (
                  <tr key={a.id} onClick={() => (location.hash = `/m/${a.id}`)}>
                    <td>
                      <div className="host">
                        <span className={`host-icon ${a.online ? 'on' : ''}`}>
                          <Icon />
                        </span>
                        <div>
                          <div className="strong">{a.label || a.hostname}</div>
                          <div className="muted small">{a.label ? a.hostname : (a.lastIp ?? '—')}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <Status online={a.online} />
                        {warn.length > 0 && (
                          <Badge variant="danger">
                            <AlertTriangle /> {warn.join(', ')}
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td>
                      <OsBadge os={a.os} />
                      <div className="muted small" style={{ marginTop: 4 }}>
                        {platformLabel(a.os, a.platform)}
                      </div>
                    </td>
                    <td>
                      <Meter value={m?.cpuPercent} />
                    </td>
                    <td>
                      <Meter value={m?.memPercent} caption={m ? `${bytes(m.memUsed, 0)} / ${bytes(m.memTotal, 0)}` : undefined} />
                    </td>
                    <td>
                      <Meter value={disk?.usedPercent} caption={disk?.mountpoint} />
                    </td>
                    <td className="small ink-2 nowrap">{a.online ? 'teraz' : ago(a.lastSeen)}</td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="center-text">
                    Brak komputerów pasujących do filtrów.
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
