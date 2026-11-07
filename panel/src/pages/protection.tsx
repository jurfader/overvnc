import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Download,
  Flame,
  History,
  Info,
  Lock,
  MonitorCog,
  Package,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { api, errorMessage, type Agent, type ChangeItem, type ChangeKind, type SecurityFacts, type SecurityIssue, type SecuritySummary, type Severity } from '../api.ts';
import { Button, CardHead, EmptyState, toast } from '../components.tsx';
import { ago, dateTime, plural } from '../format.ts';

// ---------- ocena: wspólne dla listy komputerów i strony komputera ----------

export const LEVEL_LABEL: Record<SecuritySummary['level'], string> = {
  ok: 'Zabezpieczenia w porządku',
  info: 'Drobne uwagi',
  warning: 'Wymaga uwagi',
  critical: 'Krytyczne problemy z zabezpieczeniami',
};

const SEVERITY_ICON: Record<Severity, LucideIcon> = { critical: XCircle, warning: AlertTriangle, info: Info };

/** Tarcza na liście komputerów — tylko gdy jest coś do zrobienia (ostrzeżenia i krytyczne). */
export function SecurityShield({ security }: { security: SecuritySummary | null }) {
  if (!security || (security.level !== 'critical' && security.level !== 'warning')) return null;
  const hits = security.issues.filter((i) => i.severity !== 'info');
  return (
    <span className={`sec-shield sev-${security.level}`} title={`${LEVEL_LABEL[security.level]}:\n${hits.map((i) => `• ${i.title}`).join('\n')}`} aria-label={LEVEL_LABEL[security.level]}>
      {security.level === 'critical' ? <ShieldX /> : <ShieldAlert />}
    </span>
  );
}

function IssueList({ issues }: { issues: SecurityIssue[] }) {
  return (
    <ul className="sec-issues">
      {issues.map((i) => {
        const Icon = SEVERITY_ICON[i.severity];
        return (
          <li key={i.code} className={`sev-${i.severity}`}>
            <Icon />
            <div>
              <strong>{i.title}</strong>
              {i.detail && <div className="small muted">{i.detail}</div>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function State({ ok, children }: { ok: boolean | null; children: ReactNode }) {
  return <span className={`sec-state ${ok === null ? '' : ok ? 'ok' : 'bad'}`}>{children}</span>;
}

// ---------- karta „Zabezpieczenia” na stronie komputera ----------

export function SecurityView({ agent, facts, canRefresh }: { agent: Agent; facts: SecurityFacts | null | undefined; canRefresh: boolean }) {
  const [busy, setBusy] = useState(false);
  const sec = agent.security;
  const refresh = async () => {
    setBusy(true);
    try {
      await api.refreshInventory(agent.id);
      toast('Stan zabezpieczeń sprawdzony');
    } catch (err) {
      toast(errorMessage(err), 'err');
    } finally {
      setBusy(false);
    }
  };

  if (!sec || !facts)
    return (
      <EmptyState
        icon={ShieldCheck}
        title="Brak danych o zabezpieczeniach"
        text={agent.os === 'linux' ? 'Na Linuksie stan zabezpieczeń nie jest jeszcze sprawdzany.' : 'Agent w wersji 0.19.0 lub nowszej sprawdza antywirus, zaporę, szyfrowanie dysku i aktualizacje.'}
      />
    );

  const mac = agent.os === 'darwin';
  const av = facts.antivirus;
  const others = av?.products?.filter((p) => !/defender/i.test(p.name)) ?? [];
  const up = facts.updates;
  const LevelIcon = sec.level === 'critical' ? ShieldX : sec.level === 'ok' || sec.level === 'info' ? ShieldCheck : ShieldAlert;

  return (
    <>
      <section className={`glass-card card sec-head sev-${sec.level} anim-rise`}>
        <div className="sec-head-main">
          <span className="sec-head-icon">
            <LevelIcon />
          </span>
          <div>
            <h3>{LEVEL_LABEL[sec.level]}</h3>
            <div className="small muted">
              {sec.issues.length
                ? `${sec.issues.length} ${plural(sec.issues.length, 'uwaga', 'uwagi', 'uwag')} · sprawdzono ${ago(sec.checkedAt)}`
                : `Sprawdzono ${ago(sec.checkedAt)}`}
            </div>
          </div>
          {canRefresh && (
            <Button size="sm" icon={RefreshCw} loading={busy} disabled={!agent.online} onClick={refresh} title={agent.online ? 'Sprawdź ponownie' : 'Komputer jest offline'}>
              <span className="btn-label">Sprawdź teraz</span>
            </Button>
          )}
        </div>
        {sec.issues.length > 0 && <IssueList issues={sec.issues} />}
      </section>

      <section className="grid grid-2 anim-rise" style={{ animationDelay: '60ms' }}>
        {av && (
          <div className="glass-card card">
            <CardHead icon={ShieldCheck} title="Antywirus" />
            <dl className="props">
              {av.defender && (
                <>
                  <dt>Microsoft Defender</dt>
                  <dd>
                    <State ok={av.enabled && av.realTime}>{av.enabled ? (av.realTime ? 'włączony, ochrona w czasie rzeczywistym' : 'włączony, bez ochrony w czasie rzeczywistym') : 'wyłączony'}</State>
                  </dd>
                  <dt>Definicje</dt>
                  <dd>
                    {av.signatureAgeDays < 0 ? (
                      <span className="muted">nieznane</span>
                    ) : (
                      <State ok={av.signatureAgeDays <= 7}>
                        {av.signatureAgeDays === 0 ? 'aktualne (dzisiejsze)' : `sprzed ${av.signatureAgeDays} ${plural(av.signatureAgeDays, 'dnia', 'dni', 'dni')}`}
                      </State>
                    )}
                    {av.signatureUpdated ? <span className="muted small"> · {dateTime(av.signatureUpdated)}</span> : null}
                  </dd>
                  {av.tamperProtected !== undefined && (
                    <>
                      <dt>Ochrona przed naruszeniem</dt>
                      <dd>{av.tamperProtected ? 'włączona' : <span className="muted">wyłączona</span>}</dd>
                    </>
                  )}
                </>
              )}
              {others.map((p) => (
                <span key={p.name} style={{ display: 'contents' }}>
                  <dt>{p.name}</dt>
                  <dd>
                    <State ok={p.enabled && p.upToDate}>{p.enabled ? (p.upToDate ? 'włączony, definicje aktualne' : 'włączony, definicje nieaktualne') : 'wyłączony'}</State>
                  </dd>
                </span>
              ))}
            </dl>
          </div>
        )}

        {facts.firewall && (
          <div className="glass-card card">
            <CardHead icon={Flame} title="Zapora" />
            <dl className="props">
              <dt>Stan</dt>
              <dd>
                <State ok={facts.firewall.enabled ? true : mac ? null : false}>{facts.firewall.enabled ? 'włączona' : 'wyłączona'}</State>
                {mac && !facts.firewall.enabled && <div className="small muted">Domyślne ustawienie macOS — włączysz ją w Ustawieniach → Sieć → Zapora.</div>}
              </dd>
              {facts.firewall.profiles?.map((p) => (
                <span key={p.name} style={{ display: 'contents' }}>
                  <dt>Profil {p.name}</dt>
                  <dd>
                    <State ok={p.enabled}>{p.enabled ? 'włączona' : 'wyłączona'}</State>
                  </dd>
                </span>
              ))}
            </dl>
          </div>
        )}

        {facts.encryption && (
          <div className="glass-card card">
            <CardHead icon={Lock} title="Szyfrowanie dysku" />
            <dl className="props">
              <dt>{facts.encryption.name}</dt>
              <dd>
                <State ok={facts.encryption.enabled ? true : null}>{facts.encryption.enabled ? 'włączone' : 'wyłączone'}</State>
                {facts.encryption.status && <div className="small muted">{facts.encryption.status}</div>}
              </dd>
            </dl>
          </div>
        )}

        {up && (
          <div className="glass-card card">
            <CardHead icon={Download} title="Aktualizacje systemu" />
            <dl className="props">
              <dt>Do zainstalowania</dt>
              <dd>
                {up.checkedAt ? (
                  up.pending === 0 ? (
                    <State ok>brak — system aktualny</State>
                  ) : (
                    <State ok={up.security === 0 ? null : false}>
                      {up.pending} {plural(up.pending, 'aktualizacja', 'aktualizacje', 'aktualizacji')}
                      {up.security ? `, w tym ${up.security} bezpieczeństwa` : ''}
                    </State>
                  )
                ) : (
                  <span className="muted">{up.error ? 'nie udało się sprawdzić' : 'jeszcze nie sprawdzono (agent szuka raz na 12 godzin)'}</span>
                )}
                {up.error && <div className="small muted">{up.error}</div>}
                {up.titles && up.titles.length > 0 && (
                  <ul className="sec-updates small">
                    {up.titles.map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ul>
                )}
              </dd>
              <dt>Restart</dt>
              <dd>{up.rebootRequired ? <State ok={false}>wymagany po aktualizacjach</State> : <span className="muted">niewymagany</span>}</dd>
              {up.lastInstalled ? (
                <>
                  <dt>Ostatnia poprawka</dt>
                  <dd>
                    {dateTime(up.lastInstalled)} <span className="muted small">({ago(up.lastInstalled)})</span>
                  </dd>
                </>
              ) : null}
              {up.checkedAt ? (
                <>
                  <dt>Sprawdzono</dt>
                  <dd className="muted">{ago(up.checkedAt)}</dd>
                </>
              ) : null}
            </dl>
          </div>
        )}

        {(facts.gatekeeper !== undefined || facts.sip !== undefined) && (
          <div className="glass-card card">
            <CardHead icon={MonitorCog} title="Ochrona systemu macOS" />
            <dl className="props">
              {facts.sip !== undefined && (
                <>
                  <dt>SIP (integralność systemu)</dt>
                  <dd>
                    <State ok={facts.sip}>{facts.sip ? 'włączona' : 'wyłączona'}</State>
                  </dd>
                </>
              )}
              {facts.gatekeeper !== undefined && (
                <>
                  <dt>Gatekeeper</dt>
                  <dd>
                    <State ok={facts.gatekeeper}>{facts.gatekeeper ? 'włączony' : 'wyłączony'}</State>
                  </dd>
                </>
              )}
            </dl>
          </div>
        )}
      </section>
    </>
  );
}

// ---------- historia zmian ----------

const KIND_META: Record<ChangeKind, { label: string; icon: LucideIcon }> = {
  software: { label: 'Programy', icon: Package },
  os: { label: 'System', icon: MonitorCog },
  hardware: { label: 'Sprzęt', icon: Cpu },
  security: { label: 'Zabezpieczenia', icon: ShieldCheck },
  system: { label: 'Inne', icon: Info },
};
const KINDS: (ChangeKind | 'all')[] = ['all', 'software', 'os', 'hardware', 'security'];

function changeIcon(c: ChangeItem): LucideIcon {
  if (c.kind === 'security') return c.title.startsWith('Rozwiązano') ? CheckCircle2 : ShieldAlert;
  return KIND_META[c.kind]?.icon ?? Info;
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Dzisiaj';
  if (d.toDateString() === y.toDateString()) return 'Wczoraj';
  return d.toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

function ChangeList({ items, showMachine }: { items: ChangeItem[]; showMachine?: boolean }) {
  const groups: { day: string; items: ChangeItem[] }[] = [];
  for (const c of items) {
    const day = dayLabel(c.ts);
    if (groups.at(-1)?.day !== day) groups.push({ day, items: [] });
    groups.at(-1)!.items.push(c);
  }
  return (
    <div className="changes">
      {groups.map((g) => (
        <section key={g.day} className="changes-day">
          <h4>{g.day}</h4>
          <ul>
            {g.items.map((c) => {
              const Icon = changeIcon(c);
              const bad = c.kind === 'security' && !c.title.startsWith('Rozwiązano');
              return (
                <li key={c.id} className={`change kind-${c.kind} ${bad ? 'bad' : ''}`}>
                  <span className="change-icon">
                    <Icon />
                  </span>
                  <div className="change-body">
                    <div className="change-title">
                      {showMachine && (
                        <a className="change-machine" href={`#/m/${c.agentId}/changes`}>
                          {c.label || c.hostname}
                        </a>
                      )}
                      {c.title}
                    </div>
                    {c.detail && <div className="small muted change-detail">{c.detail}</div>}
                  </div>
                  <time className="small muted mono" dateTime={new Date(c.ts).toISOString()} title={dateTime(c.ts)}>
                    {new Date(c.ts).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}
                  </time>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

function KindFilter({ kind, onChange }: { kind: ChangeKind | 'all'; onChange: (k: ChangeKind | 'all') => void }) {
  return (
    <div className="seg changes-kinds" role="tablist" aria-label="Rodzaj zmian">
      {KINDS.map((k) => (
        <button key={k} type="button" role="tab" aria-selected={kind === k} className={`seg-btn ${kind === k ? 'on' : ''}`} onClick={() => onChange(k)}>
          {k === 'all' ? 'Wszystko' : KIND_META[k].label}
        </button>
      ))}
    </div>
  );
}

const PAGE = 100;

/** Wspólne ładowanie historii: pierwsza strona, „Pokaż starsze”, przeładowanie po zmianie filtrów. */
function usePaged(load: (before?: number) => Promise<{ items: ChangeItem[] }>, deps: unknown[]) {
  const [items, setItems] = useState<ChangeItem[] | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const gen = useRef(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const first = useCallback(load, deps);
  useEffect(() => {
    const g = ++gen.current;
    setItems(null);
    first().then(
      (r) => g === gen.current && (setItems(r.items), setMore(r.items.length === PAGE)),
      (e) => g === gen.current && (setItems([]), toast(errorMessage(e), 'err')),
    );
  }, [first]);
  const loadMore = async () => {
    if (!items?.length) return;
    setBusy(true);
    try {
      const r = await first(items[items.length - 1].id);
      setItems([...items, ...r.items]);
      setMore(r.items.length === PAGE);
    } catch (e) {
      toast(errorMessage(e), 'err');
    } finally {
      setBusy(false);
    }
  };
  return { items, more, busy, loadMore };
}

export function ChangesView({ agent }: { agent: Agent }) {
  const [kind, setKind] = useState<ChangeKind | 'all'>('all');
  const { items, more, busy, loadMore } = usePaged((before) => api.agentChanges(agent.id, { kind: kind === 'all' ? undefined : kind, before }), [agent.id, kind, agent.rev]);
  return (
    <section className="glass-card card anim-rise">
      <CardHead icon={History} title="Historia zmian">
        <KindFilter kind={kind} onChange={setKind} />
      </CardHead>
      {items === null ? (
        <div className="muted small">Ładowanie…</div>
      ) : items.length === 0 ? (
        <p className="muted small">
          Brak zmian{kind === 'all' ? '' : ' tego rodzaju'}. Agent porównuje każdy nowy inwentarz z poprzednim — zainstalowane i usunięte programy, aktualizacje systemu,
          zmiany sprzętu i stanu zabezpieczeń pojawią się tutaj.
        </p>
      ) : (
        <>
          <ChangeList items={items} />
          {more && (
            <Button size="sm" loading={busy} onClick={loadMore}>
              Pokaż starsze
            </Button>
          )}
        </>
      )}
    </section>
  );
}

/** Zmiany na wszystkich komputerach (dziennik) — np. „gdzie zainstalowano TeamViewer”. */
export function AllChanges() {
  const [kind, setKind] = useState<ChangeKind | 'all'>('all');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(q.trim()), 300);
    return () => window.clearTimeout(t);
  }, [q]);
  const { items, more, busy, loadMore } = usePaged((before) => api.changes({ kind: kind === 'all' ? undefined : kind, q: query || undefined, before }), [kind, query]);
  return (
    <section className="glass-card card anim-rise" style={{ animationDelay: '40ms' }}>
      <div className="changes-filters">
        <KindFilter kind={kind} onChange={setKind} />
        <label className="search changes-search">
          <Search />
          <input className="pole" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Szukaj, np. TeamViewer, Chrome, RAM…" aria-label="Szukaj w zmianach" />
        </label>
      </div>
      {items === null ? (
        <div className="muted small">Ładowanie…</div>
      ) : items.length === 0 ? (
        <p className="muted small">Brak zmian{query ? ` pasujących do „${query}”` : ''}.</p>
      ) : (
        <>
          <ChangeList items={items} showMachine />
          {more && (
            <Button size="sm" loading={busy} onClick={loadMore}>
              Pokaż starsze
            </Button>
          )}
        </>
      )}
    </section>
  );
}
