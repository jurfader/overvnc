import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  BellRing,
  Check,
  CheckCircle2,
  Cpu,
  HardDrive,
  History,
  KeyRound,
  MemoryStick,
  ShieldAlert,
  Pencil,
  Plus,
  Send,
  Settings2,
  Smartphone,
  Trash2,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import { api, errorMessage, type AlertItem, type AlertKind, type AlertRule, type AlertRuleInput, type NotificationSettings } from '../api.ts';
import { Badge, Button, CardHead, EmptyState, Field, Modal, StatTile, Tabs, toast } from '../components.tsx';
import { useAlerts, useMe, useOrg } from '../state.tsx';
import { ago, dateTime, duration } from '../format.ts';

type View = 'open' | 'history' | 'rules' | 'notify';

export const KIND_ICON: Record<AlertKind, LucideIcon> = {
  offline: WifiOff,
  cpu: Cpu,
  mem: MemoryStick,
  disk: HardDrive,
  license: KeyRound,
  security: ShieldAlert,
};
const KIND_LABEL: Record<AlertKind, string> = {
  offline: 'Komputer offline',
  cpu: 'Procesor',
  mem: 'Pamięć',
  disk: 'Dysk',
  license: 'Licencja Windows',
  security: 'Zabezpieczenia',
};

/** Krótki opis wartości alertu, np. „96% · D:\”. */
export function alertValue(a: Pick<AlertItem, 'kind' | 'value' | 'detail'>): string {
  if (a.kind === 'offline') return 'brak połączenia';
  if (a.kind === 'license') return [a.value === null ? '' : `zostało ${Math.round(a.value)} dni`, a.detail].filter(Boolean).join(' · ');
  if (a.kind === 'security') return a.detail;
  const v = a.value === null ? '' : `${Math.round(a.value)}%`;
  return [v, a.detail].filter(Boolean).join(' · ');
}

export const lasting = (a: Pick<AlertItem, 'startedAt' | 'resolvedAt'>) => duration(Math.max(60, ((a.resolvedAt ?? Date.now()) - a.startedAt) / 1000));

export function Alerts() {
  const { me, can } = useMe();
  const { open, unacked, byAgent } = useAlerts();
  const global = me.allClients && can('agents.manage');
  const [view, setView] = useState<View>('open');

  const items: { value: View; label: string }[] = [
    { value: 'open', label: `Otwarte (${open.length})` },
    { value: 'history', label: 'Historia' },
    ...(global
      ? [
          { value: 'rules' as View, label: 'Reguły' },
          { value: 'notify' as View, label: 'Powiadomienia' },
        ]
      : []),
  ];

  return (
    <>
      <header className="page-head anim-rise">
        <div>
          <h1>Alerty</h1>
          <div className="sub">Problemy wykryte na komputerach — wg reguł, z powiadomieniami na telefon</div>
        </div>
      </header>

      <section className="grid grid-stats">
        <StatTile icon={BellRing} label="Otwarte alerty" value={open.length} hint={open.length ? 'trwające problemy' : 'wszystko w porządku'} />
        <StatTile icon={CheckCircle2} label="Niepotwierdzone" value={unacked} hint="nikt jeszcze ich nie przejął" delay={40} />
        <StatTile icon={AlertTriangle} label="Komputery z alertem" value={byAgent.size} hint="wymagają uwagi" delay={80} />
        <StatTile icon={History} label="Ostatni alert" value={<span className="stat-value md">{open[0] ? ago(open[0].startedAt) : '—'}</span>} hint={open[0]?.title ?? 'brak otwartych'} delay={120} />
      </section>

      <div className="anim-rise" style={{ animationDelay: '140ms' }}>
        <Tabs value={view} onChange={setView} items={items} />
      </div>

      {view === 'open' && <AlertTable items={open} empty="Brak otwartych alertów — wszystkie komputery działają w normie." />}
      {view === 'history' && <HistoryView />}
      {view === 'rules' && global && <RulesView />}
      {view === 'notify' && global && <NotifyView />}
    </>
  );
}

function HistoryView() {
  const { version } = useAlerts();
  const [items, setItems] = useState<AlertItem[] | null>(null);
  useEffect(() => {
    api.alerts('all').then(setItems, (e) => toast(errorMessage(e), 'err'));
  }, [version]);
  if (!items) return <div className="center-page">Ładowanie…</div>;
  return <AlertTable items={items} history empty="Historia alertów jest pusta." />;
}

export function AlertTable({ items, history = false, empty, compact = false }: { items: AlertItem[]; history?: boolean; empty: string; compact?: boolean }) {
  const { can } = useMe();
  const [busy, setBusy] = useState<number | null>(null);

  const ack = async (a: AlertItem) => {
    setBusy(a.id);
    try {
      await api.ackAlert(a.id);
      toast('Alert potwierdzony');
    } catch (e) {
      toast(errorMessage(e), 'err');
    } finally {
      setBusy(null);
    }
  };

  if (items.length === 0) return <EmptyState icon={CheckCircle2} title="Brak alertów" text={empty} />;

  return (
    <section className="glass-card table-card anim-rise">
      <div className="table-scroll">
        <table className="table alerts-table stack">
          <thead>
            <tr>
              <th>Stan</th>
              {!compact && <th>Komputer</th>}
              <th>Alert</th>
              <th>Początek</th>
              <th>Czas trwania</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((a) => {
              const Icon = KIND_ICON[a.kind] ?? BellRing;
              return (
                <tr key={a.id}>
                  <td className="s-end">
                    {a.resolvedAt ? (
                      <Badge variant="success">zakończony</Badge>
                    ) : a.ackAt ? (
                      <span title={`Potwierdzone przez: ${a.ackBy} · ${dateTime(a.ackAt)}`}>
                        <Badge variant="warning">potwierdzony</Badge>
                      </span>
                    ) : (
                      <Badge variant="danger">otwarty</Badge>
                    )}
                  </td>
                  {!compact && (
                    <td className="s-full">
                      <a href={`#/m/${a.agentId}`} className="strong link">
                        {a.label || a.hostname}
                      </a>
                      <div className="muted small">{a.clientName ?? 'bez klienta'}</div>
                    </td>
                  )}
                  <td className="s-main">
                    <div className="alert-title">
                      <Icon /> <span className="strong">{a.title}</span>
                    </div>
                    <div className="muted small mono">{alertValue(a)}</div>
                  </td>
                  <td className="small s-meta" title={dateTime(a.startedAt)} data-label="Początek:">
                    {ago(a.startedAt)}
                    <div className="muted only-desktop">{dateTime(a.startedAt)}</div>
                  </td>
                  <td className="small ink-2 s-meta" data-label="Trwa:">
                    {lasting(a)}
                  </td>
                  <td className="right s-full">
                    {!history && !a.resolvedAt && !a.ackAt && can('agents.refresh') && (
                      <Button size="sm" icon={Check} loading={busy === a.id} onClick={() => ack(a)}>
                        Potwierdź
                      </Button>
                    )}
                    {a.ackAt && !a.resolvedAt && <span className="muted small">{a.ackBy}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------- reguły ----------

function describeRule(r: AlertRule): string {
  const dur = r.durationMin ? ` przez ${r.durationMin} min` : ' (od razu)';
  if (r.kind === 'offline') return `Brak połączenia przez ${r.durationMin} min${r.threshold >= 1 ? ' (także wyłączone komputery)' : ' (pomija wyłączone komputery)'}`;
  if (r.kind === 'license') return `Wersja próbna Windows: ≤ ${r.threshold} dni do końca`;
  if (r.kind === 'security') return r.threshold >= 2 ? 'Krytyczne problemy (antywirus, zapora, SIP)' : 'Krytyczne problemy i ostrzeżenia (też poprawki, restart)';
  return `${KIND_LABEL[r.kind]} ≥ ${r.threshold}%${dur}`;
}

function RulesView() {
  const [rules, setRules] = useState<AlertRule[] | null>(null);
  const [editing, setEditing] = useState<AlertRule | null | undefined>(undefined); // undefined = zamknięte, null = nowa
  const [deleting, setDeleting] = useState<AlertRule | null>(null);

  const load = useCallback(() => api.alertRules().then(setRules, (e) => toast(errorMessage(e), 'err')), []);
  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (r: AlertRule, patch: Partial<AlertRuleInput>) => {
    const { id, clientName: _c, ...input } = r;
    try {
      await api.updateAlertRule(id, { ...input, ...patch });
      await load();
    } catch (e) {
      toast(errorMessage(e), 'err');
    }
  };

  if (!rules) return <div className="center-page">Ładowanie…</div>;

  return (
    <section className="glass-card table-card anim-rise">
      <div className="card" style={{ paddingBottom: 0 }}>
        <CardHead icon={Settings2} title="Reguły alertów">
          <Button size="sm" variant="primary" icon={Plus} onClick={() => setEditing(null)}>
            Nowa reguła
          </Button>
        </CardHead>
      </div>
      <div className="table-scroll">
        <table className="table compact alerts-table stack">
          <thead>
            <tr>
              <th>Nazwa</th>
              <th>Warunek</th>
              <th>Komputery</th>
              <th className="center-text">Push</th>
              <th className="center-text">Aktywna</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => {
              const Icon = KIND_ICON[r.kind];
              return (
                <tr key={r.id} className={r.enabled ? '' : 'row-muted'}>
                  <td className="s-main">
                    <div className="alert-title">
                      <Icon /> <span className="strong">{r.name}</span>
                    </div>
                  </td>
                  <td className="small s-full">{describeRule(r)}</td>
                  <td className="small ink-2 s-meta" data-label="Komputery:">
                    {r.clientName ?? 'wszystkie'}
                  </td>
                  <td className="center-text s-meta" data-label="Push">
                    <input type="checkbox" className="cb" aria-label="Powiadomienie push" checked={r.notify} onChange={(e) => toggle(r, { notify: e.target.checked })} />
                  </td>
                  <td className="center-text s-meta" data-label="Aktywna">
                    <input type="checkbox" className="cb" aria-label="Reguła aktywna" checked={r.enabled} onChange={(e) => toggle(r, { enabled: e.target.checked })} />
                  </td>
                  <td className="right nowrap s-end">
                    <Button size="sm" variant="ghost" icon={Pencil} title="Edytuj" onClick={() => setEditing(r)} />
                    <Button size="sm" variant="ghost" icon={Trash2} title="Usuń" onClick={() => setDeleting(r)} />
                  </td>
                </tr>
              );
            })}
            {rules.length === 0 && (
              <tr>
                <td colSpan={6} className="center-text">
                  Brak reguł — alerty nie będą tworzone.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <RuleModal rule={editing} onClose={() => setEditing(undefined)} onSaved={load} />
      <Modal open={!!deleting} onClose={() => setDeleting(null)}>
        <h3>Usunąć regułę „{deleting?.name}”?</h3>
        <p>Otwarte alerty tej reguły zostaną zamknięte. Historia alertów zostaje.</p>
        <div className="okno-actions">
          <Button variant="ghost" onClick={() => setDeleting(null)}>
            Anuluj
          </Button>
          <Button
            variant="danger"
            icon={Trash2}
            onClick={async () => {
              try {
                await api.deleteAlertRule(deleting!.id);
                toast('Reguła usunięta');
                setDeleting(null);
                await load();
              } catch (e) {
                toast(errorMessage(e), 'err');
              }
            }}
          >
            Usuń regułę
          </Button>
        </div>
      </Modal>
    </section>
  );
}

const KIND_OPTIONS: { value: AlertKind; label: string; hint: string }[] = [
  {
    value: 'security',
    label: 'Problemy z zabezpieczeniami',
    hint: 'Antywirus lub zapora wyłączone, nieaktualne definicje, brakujące poprawki bezpieczeństwa, wymagany restart.',
  },
  {
    value: 'license',
    label: 'Kończy się wersja próbna Windows',
    hint: 'Ewaluacyjny Windows (90 dni) kończy się za podaną liczbę dni lub mniej.',
  },
  {
    value: 'offline',
    label: 'Komputer offline',
    hint: 'Agent nie łączy się z serwerem dłużej niż podany czas.',
  },
  {
    value: 'disk',
    label: 'Zajętość dysku',
    hint: 'Najbardziej zapełniony dysk przekracza próg.',
  },
  {
    value: 'cpu',
    label: 'Obciążenie procesora',
    hint: 'Średnie użycie procesora przekracza próg.',
  },
  {
    value: 'mem',
    label: 'Zajętość pamięci',
    hint: 'Użycie pamięci RAM przekracza próg.',
  },
];

function RuleModal({ rule, onClose, onSaved }: { rule: AlertRule | null | undefined; onClose: () => void; onSaved: () => void }) {
  const open = rule !== undefined;
  const { clients } = useOrg();
  const [f, setF] = useState<AlertRuleInput>({
    name: '',
    kind: 'disk',
    threshold: 90,
    durationMin: 5,
    clientId: null,
    enabled: true,
    notify: true,
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (rule) {
      const { id: _i, clientName: _c, ...input } = rule;
      setF(input);
    } else
      setF({
        name: '',
        kind: 'disk',
        threshold: 90,
        durationMin: 5,
        clientId: null,
        enabled: true,
        notify: true,
      });
  }, [open, rule]);

  const set = (patch: Partial<AlertRuleInput>) => setF((cur) => ({ ...cur, ...patch }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body = {
        ...f,
        name: f.name.trim() || KIND_OPTIONS.find((k) => k.value === f.kind)!.label,
      };
      if (rule) await api.updateAlertRule(rule.id, body);
      else await api.createAlertRule(body);
      toast(rule ? 'Reguła zapisana' : 'Reguła dodana');
      onSaved();
      onClose();
    } catch (err) {
      toast(errorMessage(err), 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} wide>
      <form onSubmit={submit}>
        <h3>{rule ? 'Edycja reguły' : 'Nowa reguła alertu'}</h3>
        <Field label="Rodzaj" group>
          <div className="choice-list">
            {KIND_OPTIONS.map((o) => (
              <label key={o.value} className={`choice ${f.kind === o.value ? 'on' : ''}`}>
                <input
                  type="radio"
                  name="kind"
                  checked={f.kind === o.value}
                  onChange={() =>
                    set({
                      kind: o.value,
                      durationMin: o.value === 'offline' ? Math.max(1, f.durationMin || 10) : o.value === 'license' || o.value === 'security' ? 0 : f.durationMin,
                      threshold:
                        o.value === f.kind
                          ? f.threshold
                          : o.value === 'license'
                            ? 14
                            : o.value === 'security'
                              ? 2
                              : o.value === 'offline'
                                ? 0
                                : f.kind === 'license' || f.kind === 'security' || f.kind === 'offline'
                                  ? 90
                                  : f.threshold,
                    })
                  }
                />
                <span>
                  {o.label}
                  <small>{o.hint}</small>
                </span>
              </label>
            ))}
          </div>
        </Field>
        <Field label="Nazwa (widoczna w alertach i powiadomieniach)">
          <input className="pole" value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder={KIND_OPTIONS.find((k) => k.value === f.kind)!.label} maxLength={100} />
        </Field>
        <div className="form-2">
          {f.kind === 'security' && (
            <Field label="Które problemy">
              <select className="pole" value={f.threshold >= 2 ? 2 : 1} onChange={(e) => set({ threshold: Number(e.target.value) })}>
                <option value={2}>tylko krytyczne — antywirus, zapora, SIP wyłączone</option>
                <option value={1}>krytyczne i ostrzeżenia — także poprawki, restart, definicje</option>
              </select>
            </Field>
          )}
          {f.kind !== 'offline' && f.kind !== 'security' && (
            <Field label={f.kind === 'license' ? 'Alert, gdy do końca zostało dni (≤)' : 'Próg (%)'}>
              <input className="pole" type="number" min={1} max={f.kind === 'license' ? 90 : 100} value={f.threshold} onChange={(e) => set({ threshold: Number(e.target.value) })} required />
            </Field>
          )}
          {f.kind === 'offline' && (
            <Field label="Wyłączone komputery" group>
              <label className={`choice ${f.threshold >= 1 ? 'on' : ''}`}>
                <input type="checkbox" checked={f.threshold >= 1} onChange={(e) => set({ threshold: e.target.checked ? 1 : 0 })} />
                <span>
                  Zgłaszaj także normalnie wyłączone
                  <small>Domyślnie alert jest tylko przy zerwanym połączeniu (sieć, zawieszenie, odcięty prąd) — komputer wyłączony przez Start nie alarmuje.</small>
                </span>
              </label>
            </Field>
          )}
          {f.kind !== 'license' && f.kind !== 'security' && (
            <Field
              label={f.kind === 'offline' ? 'Offline dłużej niż (min)' : 'Musi trwać (min, 0 = od razu)'}
              hint={f.kind === 'offline' ? 'Kioski wyłączane na noc? Ustaw dłuższy czas albo wyłącz push.' : undefined}
            >
              <input className="pole" type="number" min={f.kind === 'offline' ? 1 : 0} max={1440} value={f.durationMin} onChange={(e) => set({ durationMin: Number(e.target.value) })} required />
            </Field>
          )}
        </div>
        <Field label="Komputery">
          <select className="pole" value={f.clientId ?? ''} onChange={(e) => set({ clientId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">wszystkie komputery</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                tylko klient: {c.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="choice-list">
          <label className={`choice ${f.notify ? 'on' : ''}`}>
            <input type="checkbox" checked={f.notify} onChange={(e) => set({ notify: e.target.checked })} />
            <span>
              Powiadomienie push
              <small>Wiadomość Pushover przy otwarciu i zakończeniu alertu.</small>
            </span>
          </label>
          <label className={`choice ${f.enabled ? 'on' : ''}`}>
            <input type="checkbox" checked={f.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
            <span>
              Reguła aktywna
              <small>Wyłączona reguła nie tworzy alertów; jej otwarte alerty zostaną zamknięte.</small>
            </span>
          </label>
        </div>
        <div className="okno-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            Anuluj
          </Button>
          <Button variant="primary" loading={busy}>
            {rule ? 'Zapisz' : 'Dodaj regułę'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- powiadomienia ----------

function NotifyView() {
  const [st, setSt] = useState<NotificationSettings | null>(null);
  const [token, setToken] = useState('');
  const [user, setUser] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api.notificationSettings().then(setSt, (e) => toast(errorMessage(e), 'err'));
  }, []);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast(errorMessage(e), 'err');
    } finally {
      setBusy(null);
    }
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    void run('save', async () => {
      setSt(
        await api.saveNotificationSettings({
          token: token.trim(),
          user: user.trim(),
        }),
      );
      setToken('');
      setUser('');
      toast('Zapisano — wyślij powiadomienie testowe');
    });
  };

  if (!st) return <div className="center-page">Ładowanie…</div>;
  const configured = st.pushover.configured;

  return (
    <section className="grid grid-2 anim-rise">
      <div className="glass-card card">
        <CardHead icon={Smartphone} title="Pushover">
          {configured ? <Badge variant="success">skonfigurowany ({st.pushover.userHint})</Badge> : <Badge variant="neutral">nieskonfigurowany</Badge>}
        </CardHead>
        <form className="form-grid" onSubmit={save}>
          <Field label="Klucz użytkownika (User Key)" hint={configured ? 'Pozostaw puste, aby nie zmieniać.' : 'Na stronie głównej pushover.net po zalogowaniu.'}>
            <input
              className="pole mono"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder={configured ? '••••••••••••••••' : 'u…'}
              autoComplete="off"
              spellCheck={false}
              maxLength={30}
            />
          </Field>
          <Field label="Token aplikacji (API Token)" hint={configured ? 'Pozostaw puste, aby nie zmieniać.' : 'Utwórz aplikację „OVERVNC” w pushover.net → Your Applications.'}>
            <input
              className="pole mono"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={configured ? '••••••••••••••••' : 'a…'}
              autoComplete="off"
              spellCheck={false}
              maxLength={30}
            />
          </Field>
          <div className="okno-actions" style={{ marginTop: 0 }}>
            {configured && (
              <Button
                type="button"
                variant="ghost"
                icon={Trash2}
                loading={busy === 'clear'}
                onClick={() => run('clear', async () => (setSt(await api.saveNotificationSettings({ clear: true })), toast('Powiadomienia wyłączone')))}
              >
                Usuń
              </Button>
            )}
            {configured && (
              <Button type="button" icon={Send} loading={busy === 'test'} onClick={() => run('test', async () => (await api.testNotification(), toast('Wysłano — sprawdź telefon')))}>
                Wyślij test
              </Button>
            )}
            <Button variant="primary" loading={busy === 'save'} disabled={!configured && (!token.trim() || !user.trim())}>
              Zapisz
            </Button>
          </div>
        </form>
      </div>
      <div className="glass-card card">
        <CardHead icon={BellRing} title="Jak to działa" />
        <ul className="plain-list small">
          <li>Powiadomienie przychodzi przy otwarciu alertu i (ciche) przy jego zakończeniu — dla reguł z włączonym „Push”.</li>
          <li>Alerty „offline” i „dysk” mają wysoki priorytet — przechodzą przez godziny ciszy w aplikacji Pushover.</li>
          <li>Kilka alertów w ciągu kilku sekund (np. awaria łącza w biurze) łączy się w jedną wiadomość.</li>
          <li>
            Wiadomość zawiera link prosto do komputera w panelu
            {st.panelUrl ? ` (${st.panelUrl})` : ''}.
          </li>
          <li>Klucze są przechowywane na serwerze w postaci zaszyfrowanej i nie są nigdy odsyłane do przeglądarki.</li>
        </ul>
      </div>
    </section>
  );
}
