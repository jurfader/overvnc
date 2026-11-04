import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, LayoutGrid, MessageSquareText, Search } from 'lucide-react';
import type { Agent } from '../api.ts';
import { Button, EmptyState, Status } from '../components.tsx';
import { useAlerts, useOrg } from '../state.tsx';
import { ago, plural } from '../format.ts';
import { useScreenshot } from '../hooks/useScreenshot.ts';
import { MessageModal, ShotPlaceholder } from './remote/KioskCard.tsx';

const INTERVALS = [
  { value: 5000, label: 'co 5 s' },
  { value: 10_000, label: 'co 10 s' },
  { value: 30_000, label: 'co 30 s' },
  { value: 0, label: 'wstrzymane' },
];

/** Ściana ekranów: miniatury kiosków (klienci w trybie zgody „Bez komunikatu”), odświeżane na żywo. */
export function Wall({ agents }: { agents: Agent[] }) {
  const { clients } = useOrg();
  const [clientF, setClientF] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const [interval, setIntervalMs] = useState(10_000);
  const [msgOpen, setMsgOpen] = useState(false);

  const silentClients = useMemo(() => clients.filter((c) => c.consentMode === 'none'), [clients]);
  const silentIds = useMemo(() => new Set(silentClients.map((c) => c.id)), [silentClients]);

  const kiosks = useMemo(() => {
    const n = q.trim().toLowerCase();
    return agents
      .filter((a) => a.clientId !== null && silentIds.has(a.clientId))
      .filter((a) => clientF === null || a.clientId === clientF)
      .filter((a) => !n || `${a.label} ${a.hostname} ${a.siteName ?? ''}`.toLowerCase().includes(n))
      .sort((a, b) => Number(b.online) - Number(a.online) || (a.label || a.hostname).localeCompare(b.label || b.hostname, 'pl'));
  }, [agents, silentIds, clientF, q]);
  const online = kiosks.filter((a) => a.online).length;

  return (
    <>
      <header className="page-head anim-rise">
        <div>
          <h1>Ekrany</h1>
          <div className="sub">
            {kiosks.length} {plural(kiosks.length, 'kiosk', 'kioski', 'kiosków')} · {online} online — podgląd na żywo, kliknij, aby przejąć sterowanie
          </div>
        </div>
        <div className="toolbar">
          <Button icon={MessageSquareText} disabled={online === 0} onClick={() => setMsgOpen(true)}>
            Komunikat do wszystkich
          </Button>
        </div>
      </header>

      <div className="filters anim-rise">
        <div className="search">
          <Search />
          <input className="pole" placeholder="Szukaj kiosku…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {silentClients.length > 1 && (
          <select className="pole" value={clientF ?? ''} onChange={(e) => setClientF(e.target.value ? Number(e.target.value) : null)} aria-label="Klient">
            <option value="">Wszyscy klienci</option>
            {silentClients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        <select className="pole" value={interval} onChange={(e) => setIntervalMs(Number(e.target.value))} aria-label="Odświeżanie">
          {INTERVALS.map((i) => (
            <option key={i.value} value={i.value}>
              Odświeżanie: {i.label}
            </option>
          ))}
        </select>
      </div>

      {silentClients.length === 0 ? (
        <EmptyState
          icon={LayoutGrid}
          title="Brak kiosków do podglądu"
          text="Podgląd ekranów działa dla klientów z trybem zgody „Bez komunikatu” (kioski). Ustawisz go w Klienci → edycja klienta."
        />
      ) : kiosks.length === 0 ? (
        <EmptyState icon={LayoutGrid} title="Brak kiosków" text="Żaden komputer nie pasuje do filtrów." />
      ) : (
        <div className="wall-grid anim-rise">
          {kiosks.map((a) => (
            <WallTile key={a.id} agent={a} intervalMs={interval} />
          ))}
        </div>
      )}
      <MessageModal open={msgOpen} agents={kiosks} onClose={() => setMsgOpen(false)} />
    </>
  );
}

function WallTile({ agent, intervalMs }: { agent: Agent; intervalMs: number }) {
  const ref = useRef<HTMLAnchorElement>(null);
  const [visible, setVisible] = useState(false);
  const { byAgent } = useAlerts();
  const alerts = byAgent.get(agent.id) ?? [];
  const canShot = agent.online && agent.capabilities.includes('screen.capture');
  // odświeżamy tylko miniatury widoczne na ekranie
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const shot = useScreenshot(agent.id, 480, { enabled: canShot, active: visible, intervalMs });

  return (
    <a ref={ref} href={`#/m/${agent.id}/desktop`} className={`wall-tile glass-card ${agent.online ? '' : 'off'} ${alerts.length ? 'alerting' : ''}`}>
      <div className="wall-shot">
        {shot.url && canShot ? (
          <img src={shot.url} alt={`Ekran: ${agent.label || agent.hostname}`} loading="lazy" />
        ) : (
          <ShotPlaceholder
            error={agent.online ? shot.error : null}
            loading={canShot && shot.loading}
            text={!agent.online ? `offline ${ago(agent.lastSeen)}` : !agent.capabilities.includes('screen.capture') ? 'stara wersja agenta — zaktualizuj' : undefined}
          />
        )}
      </div>
      <div className="wall-meta">
        <div style={{ minWidth: 0 }}>
          <div className="strong ellipsis">{agent.label || agent.hostname}</div>
          <div className="muted small ellipsis">{[agent.clientName, agent.siteName].filter(Boolean).join(' · ')}</div>
        </div>
        <div className="wall-badges">
          {alerts.length > 0 && (
            <span className="alert-mark" title={alerts.map((x) => x.title).join(', ')}>
              <AlertTriangle /> {alerts.length}
            </span>
          )}
          <Status online={agent.online} />
        </div>
      </div>
    </a>
  );
}
