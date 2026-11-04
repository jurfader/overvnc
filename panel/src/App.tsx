import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, LogOut, Menu, Monitor, Moon, PlusCircle, ScrollText, Sun, X, type LucideIcon } from 'lucide-react';
import { api, type Agent } from './api.ts';
import { useLiveEvents, type LiveEvent } from './live.ts';
import { applyTheme, readTheme, Toasts, type Theme } from './components.tsx';
import { Login } from './pages/Login.tsx';
import { Machines } from './pages/Machines.tsx';
import { MachineDetail } from './pages/MachineDetail.tsx';
import { Tokens } from './pages/Tokens.tsx';
import { Audit } from './pages/Audit.tsx';

function useHashRoute(): string {
  const [hash, setHash] = useState(location.hash.slice(1) || '/');
  useEffect(() => {
    const on = () => setHash(location.hash.slice(1) || '/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  match: (route: string) => boolean;
  count?: number;
}

export function App() {
  const [user, setUser] = useState<string | null | undefined>(undefined);
  const [agents, setAgents] = useState<Map<string, Agent>>(new Map());
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [menuOpen, setMenuOpen] = useState(false);
  const route = useHashRoute();

  useEffect(() => setMenuOpen(false), [route]);

  useEffect(() => {
    api.me().then((u) => setUser(u.username), () => setUser(null));
    const onUnauth = () => setUser(null);
    window.addEventListener('overvnc:unauthorized', onUnauth);
    return () => window.removeEventListener('overvnc:unauthorized', onUnauth);
  }, []);

  const loadAgents = useCallback(() => {
    api.agents().then((list) => setAgents(new Map(list.map((a) => [a.id, a]))), () => {});
  }, []);

  useEffect(() => {
    if (user) loadAgents();
  }, [user, loadAgents]);

  const onEvent = useCallback((e: LiveEvent) => {
    setAgents((prev) => {
      const next = new Map(prev);
      const cur = next.get(e.id);
      switch (e.type) {
        case 'agent_online':
        case 'agent_added':
        case 'agent_updated':
          if (e.data) next.set(e.id, { ...e.data, rev: Date.now() });
          break;
        case 'agent_offline':
          if (cur) next.set(e.id, { ...cur, online: false, connectedAt: null, lastSeen: Date.now() });
          break;
        case 'agent_metrics':
          if (cur) next.set(e.id, { ...cur, online: true, metrics: e.data, lastSeen: Date.now() });
          break;
        case 'agent_removed':
          next.delete(e.id);
          break;
      }
      return next;
    });
  }, []);

  useLiveEvents(!!user, onEvent, loadAgents);

  const toggleTheme = () => {
    const t = theme === 'dark' ? 'light' : 'dark';
    applyTheme(t);
    setTheme(t);
  };

  if (user === undefined) return <div className="center-page">Ładowanie…</div>;
  if (user === null)
    return (
      <>
        <Login onLogin={setUser} />
        <Toasts />
      </>
    );

  const list = [...agents.values()];
  const online = list.filter((a) => a.online).length;

  const detail = /^\/m\/([0-9a-f-]{36})$/.exec(route);
  let page;
  if (detail) page = <MachineDetail key={detail[1]} id={detail[1]} live={agents.get(detail[1])} />;
  else if (route === '/tokens') page = <Tokens />;
  else if (route === '/audit') page = <Audit />;
  else page = <Machines agents={list} />;

  const groups: { title: string; items: NavItem[] }[] = [
    {
      title: 'Zarządzanie',
      items: [
        { href: '/', label: 'Komputery', icon: Monitor, match: (r) => r === '/' || r.startsWith('/m/'), count: online || undefined },
        { href: '/tokens', label: 'Dodaj komputer', icon: PlusCircle, match: (r) => r === '/tokens' },
      ],
    },
    {
      title: 'System',
      items: [{ href: '/audit', label: 'Dziennik zdarzeń', icon: ScrollText, match: (r) => r === '/audit' }],
    },
  ];

  return (
    <div className="layout">
      <button className="mobile-toggle" onClick={() => setMenuOpen(true)} aria-label="Menu">
        <Menu />
      </button>
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
                {g.items.map(({ href, label, icon: Icon, match, count }) => {
                  const active = match(route);
                  return (
                    <a key={href} href={`#${href}`} className={`nav-item ${active ? 'active' : ''}`}>
                      <Icon />
                      <span className="label">{label}</span>
                      {count !== undefined && (
                        <span className="count" title="online">
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
          <button className="nav-item" onClick={toggleTheme}>
            {theme === 'dark' ? <Sun /> : <Moon />}
            <span className="label">{theme === 'dark' ? 'Motyw jasny' : 'Motyw ciemny'}</span>
          </button>
          <div className="nav-item" style={{ cursor: 'default' }}>
            <span className="avatar">{user.slice(0, 2).toUpperCase()}</span>
            <span className="label">{user}</span>
          </div>
          <button
            className="nav-item logout"
            onClick={async () => {
              await api.logout().catch(() => {});
              setUser(null);
            }}
          >
            <LogOut />
            <span className="label">Wyloguj się</span>
          </button>
        </div>
      </aside>

      <main className="content">
        <div className="content-inner">{page}</div>
      </main>
      <Toasts />
    </div>
  );
}
