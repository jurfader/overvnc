import { useCallback, useEffect, useState } from 'react';
import { BellRing, Building2, ChevronRight, LayoutGrid, CloudDownload, LogOut, Menu, Monitor, Moon, PlusCircle, ScrollText, Sun, UserCog, Users, X, type LucideIcon } from 'lucide-react';
import { api, type Agent, type Me, type Permission } from './api.ts';
import { useLiveEvents, type LiveEvent } from './live.ts';
import { applyTheme, readTheme, Toasts, type Theme } from './components.tsx';
import { AlertsProvider, alertEvent, MeProvider, OrgProvider, orgChanged, useAlerts } from './state.tsx';
import { Login } from './pages/Login.tsx';
import { Setup } from './pages/Setup.tsx';
import { Machines } from './pages/Machines.tsx';
import { MachineDetail, type DetailTab } from './pages/MachineDetail.tsx';
import { Tokens } from './pages/Tokens.tsx';
import { Audit } from './pages/Audit.tsx';
import { Clients } from './pages/Clients.tsx';
import { Team } from './pages/Team.tsx';
import { Account } from './pages/Account.tsx';
import { Updates } from './pages/Updates.tsx';
import { Alerts } from './pages/Alerts.tsx';
import { Wall } from './pages/Wall.tsx';

/** Routing w hashu: "#/sciezka?param=wartosc". */
function useHashRoute(): { path: string; query: URLSearchParams } {
  const read = () => {
    const [path, qs] = (location.hash.slice(1) || '/').split('?');
    return { path: path || '/', query: new URLSearchParams(qs ?? '') };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [theme, setTheme] = useState<Theme>(readTheme);

  const reloadMe = useCallback(async () => {
    try {
      setMe(await api.me());
    } catch {
      setMe(null);
    }
  }, []);

  useEffect(() => {
    void reloadMe();
    const onUnauth = () => setMe(null);
    const onRestricted = () => void reloadMe();
    window.addEventListener('overvnc:unauthorized', onUnauth);
    window.addEventListener('overvnc:restricted', onRestricted);
    return () => {
      window.removeEventListener('overvnc:unauthorized', onUnauth);
      window.removeEventListener('overvnc:restricted', onRestricted);
    };
  }, [reloadMe]);

  const toggleTheme = () => {
    const t = theme === 'dark' ? 'light' : 'dark';
    applyTheme(t);
    setTheme(t);
  };
  const logout = async () => {
    await api.logout().catch(() => {});
    setMe(null);
  };

  let content;
  if (me === undefined) content = <div className="center-page">Ładowanie…</div>;
  else if (me === null) content = <Login onLogin={reloadMe} />;
  else if (me.restriction) content = <Setup me={me} onDone={reloadMe} onLogout={logout} />;
  else
    content = (
      <MeProvider me={me} reloadMe={reloadMe}>
        <OrgProvider>
          <AlertsProvider>
            <Shell me={me} theme={theme} onToggleTheme={toggleTheme} onLogout={logout} reloadMe={reloadMe} />
          </AlertsProvider>
        </OrgProvider>
      </MeProvider>
    );

  return (
    <>
      {content}
      <Toasts />
    </>
  );
}

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  perm: Permission;
  match: (path: string) => boolean;
  count?: number;
  /** licznik ostrzegawczy (czerwony) zamiast liczby online */
  countTone?: 'danger';
  countTitle?: string;
  /** dodatkowo wymaga dostępu do wszystkich klientów */
  global?: boolean;
}

function Shell({ me, theme, onToggleTheme, onLogout, reloadMe }: { me: Me; theme: Theme; onToggleTheme: () => void; onLogout: () => void; reloadMe: () => Promise<void> }) {
  const [agents, setAgents] = useState<Map<string, Agent>>(new Map());
  const [menuOpen, setMenuOpen] = useState(false);
  const { path, query } = useHashRoute();
  const can = (p: Permission) => me.permissions.includes(p);
  const { unacked } = useAlerts();

  useEffect(() => setMenuOpen(false), [path]);

  const loadAgents = useCallback(() => {
    api.agents().then((list) => setAgents(new Map(list.map((a) => [a.id, a]))), () => {});
  }, []);
  useEffect(() => loadAgents(), [loadAgents]);

  const onEvent = useCallback((e: LiveEvent) => {
    if (e.type === 'org_changed') return orgChanged();
    if (e.type === 'alert_opened' || e.type === 'alert_resolved' || e.type === 'alert_updated') return alertEvent({ type: e.type, data: e.data });
    if (!e.id) return;
    const id = e.id;
    setAgents((prev) => {
      const next = new Map(prev);
      const cur = next.get(id);
      switch (e.type) {
        case 'agent_online':
        case 'agent_added':
        case 'agent_updated':
          if (e.data) next.set(id, { ...e.data, rev: Date.now() });
          break;
        case 'agent_offline':
          if (cur) next.set(id, { ...cur, online: false, connectedAt: null, capabilities: [], lastSeen: Date.now() });
          break;
        case 'agent_metrics':
          if (cur) next.set(id, { ...cur, online: true, metrics: e.data, lastSeen: Date.now() });
          break;
        case 'agent_removed':
          next.delete(id);
          break;
      }
      return next;
    });
  }, []);

  // po ponownym połączeniu (np. zmiana roli/zakresu przez właściciela) pobierz wszystko od nowa
  const onReconnect = useCallback(() => {
    loadAgents();
    orgChanged();
    window.dispatchEvent(new Event('overvnc:alerts-reload'));
    void reloadMe();
  }, [loadAgents, reloadMe]);
  useLiveEvents(true, onEvent, onReconnect);

  const list = [...agents.values()];
  const online = list.filter((a) => a.online).length;

  const allGroups: { title: string; items: NavItem[] }[] = [
    {
      title: 'Zarządzanie',
      items: [
        { href: '/', label: 'Komputery', icon: Monitor, perm: 'agents.view', match: (p) => p === '/' || p.startsWith('/m/'), count: online || undefined },
        {
          href: '/alerts',
          label: 'Alerty',
          icon: BellRing,
          perm: 'agents.view',
          match: (p) => p === '/alerts',
          count: unacked || undefined,
          countTone: 'danger',
          countTitle: 'niepotwierdzone alerty',
        },
        { href: '/wall', label: 'Ekrany', icon: LayoutGrid, perm: 'agents.remote', match: (p) => p === '/wall' },
        { href: '/clients', label: 'Klienci', icon: Building2, perm: 'agents.view', match: (p) => p === '/clients' },
        { href: '/tokens', label: 'Dodaj komputer', icon: PlusCircle, perm: 'tokens.manage', match: (p) => p === '/tokens' },
      ],
    },
    {
      title: 'System',
      items: [
        { href: '/team', label: 'Zespół', icon: Users, perm: 'team.manage', match: (p) => p === '/team' },
        { href: '/updates', label: 'Aktualizacje', icon: CloudDownload, perm: 'agents.manage', match: (p) => p === '/updates', global: true },
        { href: '/audit', label: 'Dziennik zdarzeń', icon: ScrollText, perm: 'audit.view', match: (p) => p === '/audit', global: true },
      ],
    },
  ];
  const groups = allGroups
    .map((g) => ({ ...g, items: g.items.filter((i) => can(i.perm) && (!i.global || me.allClients)) }))
    .filter((g) => g.items.length > 0);

  const detail = /^\/m\/([0-9a-f-]{36})(?:\/(monitoring|desktop|terminal|files|processes|services))?$/.exec(path);
  let page;
  if (detail) page = <MachineDetail key={detail[1]} id={detail[1]} live={agents.get(detail[1])} tab={(detail[2] as DetailTab) ?? 'overview'} filePath={query.get('path')} />;
  else if (path === '/clients') page = <Clients />;
  else if (path === '/alerts') page = <Alerts />;
  else if (path === '/wall' && can('agents.remote')) page = <Wall agents={list} />;
  else if (path === '/tokens' && can('tokens.manage')) page = <Tokens />;
  else if (path === '/team' && can('team.manage')) page = <Team />;
  else if (path === '/audit' && can('audit.view') && me.allClients) page = <Audit />;
  else if (path === '/account') page = <Account />;
  else if (path === '/updates' && can('agents.manage') && me.allClients) page = <Updates />;
  else page = <Machines agents={list} initialClient={query.get('client') ? Number(query.get('client')) : null} />;

  return (
    <div className="layout">
      {/* telefon: górny pasek z menu, nazwą i alertami */}
      <div className="mobile-bar">
        <button className="mobile-toggle" onClick={() => setMenuOpen(true)} aria-label="Menu">
          <Menu />
        </button>
        <a href="#/" className="mobile-brand">
          <img src="/logo.png" alt="" />
          <span className="gradient-text">OVERVNC</span>
        </a>
        <a href="#/alerts" className={`mobile-alerts ${unacked ? 'on' : ''}`} aria-label={unacked ? `Alerty: ${unacked} niepotwierdzonych` : 'Alerty'}>
          <BellRing />
          {unacked > 0 && <span className="count danger">{unacked}</span>}
        </a>
      </div>
      {menuOpen && <div className="sidebar-backdrop anim-fade" onClick={() => setMenuOpen(false)} />}

      <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
        <div className="sidebar-brand">
          <img src="/logo.png" alt="" />
          <div style={{ flex: 1 }}>
            <div className="name gradient-text">OVERVNC</div>
            <div className="sub">Remote Management</div>
          </div>
          {menuOpen && (
            <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setMenuOpen(false)} aria-label="Zamknij menu">
              <X />
            </button>
          )}
        </div>

        <nav>
          {groups.map((g) => (
            <div key={g.title}>
              <div className="nav-group-title">{g.title}</div>
              <div className="nav-list">
                {g.items.map(({ href, label, icon: Icon, match, count, countTone, countTitle }) => {
                  const active = match(path);
                  return (
                    <a key={href} href={`#${href}`} className={`nav-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined}>
                      <Icon />
                      <span className="label">{label}</span>
                      {count !== undefined && (
                        <span className={`count ${countTone ?? ''}`} title={countTitle ?? 'online'}>
                          {count}
                        </span>
                      )}
                      {active && <ChevronRight className="chev" style={{ color: 'rgb(var(--primary))' }} />}
                    </a>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          <button className="nav-item" onClick={onToggleTheme}>
            {theme === 'dark' ? <Sun /> : <Moon />}
            <span className="label">{theme === 'dark' ? 'Motyw jasny' : 'Motyw ciemny'}</span>
          </button>
          <a href="#/account" className={`nav-item ${path === '/account' ? 'active' : ''}`}>
            <span className="avatar">{(me.displayName || me.username).slice(0, 2).toUpperCase()}</span>
            <span className="label" style={{ minWidth: 0 }}>
              <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>{me.displayName || me.username}</span>
              <span className="muted" style={{ fontSize: 11 }}>
                {me.roleLabel}
              </span>
            </span>
            <UserCog style={{ width: 14, height: 14 }} />
          </a>
          <button className="nav-item logout" onClick={onLogout}>
            <LogOut />
            <span className="label">Wyloguj się</span>
          </button>
        </div>
      </aside>

      <main className="content">
        <div className="content-inner">{page}</div>
      </main>
    </div>
  );
}
