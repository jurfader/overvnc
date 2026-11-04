import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { BookMarked, CalendarClock, FileDown, Pencil, Play, Trash2, Upload } from 'lucide-react';
import {
  api,
  errorMessage,
  type Agent,
  type JobKind,
  type LibraryScript,
  type Package,
  type Schedule,
  type ScheduleInput,
  type ScheduleTarget,
  type ScriptInput,
  type ScriptShell,
} from '../api.ts';
import { Badge, Button, ClientLabel, EmptyState, Field, Modal, TagChip, toast } from '../components.tsx';
import { ago, bytes, plural } from '../format.ts';
import { useMe, useOrg } from '../state.tsx';
import { KIND_META, MESSAGE_TIMES, NewJobModal, SHELLS, TargetPicker, TIMEOUTS, timeoutLabel, useHeaderAction, WAITS } from './Jobs.tsx';

const DAY_LABELS = ['Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So', 'Nd'];
const WORKDAYS = 0b0011111;
const EVERYDAY = 0b1111111;

/** Najbliższe uruchomienie: „czw. 5.11, 03:15” (czas polski). */
function whenLabel(ms: number): string {
  return new Date(ms).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw', weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function daysLabel(mask: number): string {
  if (mask === EVERYDAY) return 'Codziennie';
  if (mask === WORKDAYS) return 'Pn–Pt';
  if (mask === 0b1100000) return 'So–Nd';
  return DAY_LABELS.filter((_, i) => mask & (1 << i)).join(', ');
}

function Confirm({ text, onYes, onClose, busy }: { text: string | null; onYes: () => void; onClose: () => void; busy: boolean }) {
  return (
    <Modal open={!!text} onClose={onClose}>
      <h3>Na pewno?</h3>
      <p>{text}</p>
      <div className="okno-actions">
        <Button variant="ghost" onClick={onClose}>
          Anuluj
        </Button>
        <Button variant="danger" icon={Trash2} loading={busy} onClick={onYes}>
          Usuń
        </Button>
      </div>
    </Modal>
  );
}

/** Wybór klienta wpisu: konto z dostępem do wszystkich może zostawić „wspólny”, konto klienta — tylko swoich. */
function ClientSelect({ value, onChange, sharedLabel }: { value: number | null; onChange: (v: number | null) => void; sharedLabel: string }) {
  const { me } = useMe();
  const { clients } = useOrg();
  return (
    <select className="pole" value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}>
      {me.allClients && <option value="">{sharedLabel}</option>}
      {clients.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );
}

function useDefaultClient(): number | null {
  const { me } = useMe();
  const { clients } = useOrg();
  return me.allClients ? null : (clients[0]?.id ?? null);
}

// ---------- skrypty ----------

export function ScriptsTab({ agents, action }: { agents: Agent[]; action: number }) {
  const { clients } = useOrg();
  const [list, setList] = useState<LibraryScript[] | null>(null);
  const [edit, setEdit] = useState<LibraryScript | 'new' | null>(null);
  const [run, setRun] = useState<LibraryScript | null>(null);
  const [del, setDel] = useState<LibraryScript | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.scripts().then(setList, (e) => toast(errorMessage(e), 'err'));
  }, []);
  useEffect(load, [load]);
  useHeaderAction(action, () => setEdit('new'));

  const remove = async () => {
    if (!del) return;
    setBusy(true);
    try {
      await api.deleteScript(del.id);
      toast('Usunięto skrypt');
      setDel(null);
      load();
    } catch (e) {
      toast(errorMessage(e), 'err');
      setDel(null);
    } finally {
      setBusy(false);
    }
  };

  const client = (id: number | null) => clients.find((c) => c.id === id);

  return (
    <>
      {list && list.length === 0 ? (
        <EmptyState icon={BookMarked} title="Biblioteka jest pusta" text="Zapisuj skrypty, których używasz regularnie — uruchomisz je jednym kliknięciem albo zaplanujesz w harmonogramie.">
          <Button variant="primary" icon={BookMarked} onClick={() => setEdit('new')}>
            Nowy skrypt
          </Button>
        </EmptyState>
      ) : (
        <div className="glass-card table-card anim-rise">
          <div className="table-scroll">
            <table className="table stack">
              <thead>
                <tr>
                  <th>Skrypt</th>
                  <th>Klient</th>
                  <th>Zmieniony</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(list ?? []).map((sc) => {
                  const c = client(sc.clientId);
                  return (
                    <tr key={sc.id}>
                      <td className="s-main">
                        <div className="strong">{sc.name}</div>
                        <div className="small muted script-desc">
                          {SHELLS.find((x) => x.id === sc.shell)?.label ?? sc.shell} · limit {timeoutLabel(sc.timeoutSec)}
                          {sc.asUser ? ' · jako użytkownik' : ''}
                          {sc.description ? ` · ${sc.description}` : ''}
                        </div>
                        {sc.usedBy.length > 0 && (
                          <div className="small muted">
                            <CalendarClock className="inline-icon" /> w harmonogramie: {sc.usedBy.join(', ')}
                          </div>
                        )}
                      </td>
                      <td className="s-full">{c ? <ClientLabel name={c.name} color={c.color} /> : <span className="small muted">wspólny</span>}</td>
                      <td className="s-meta small ink-2 nowrap" data-label="Zmieniony">
                        {ago(sc.updatedAt)} · {sc.updatedBy}
                      </td>
                      <td className="s-full">
                        <div className="cell-actions">
                          <Button size="sm" variant="primary" icon={Play} onClick={() => setRun(sc)}>
                            Uruchom
                          </Button>
                          <Button size="sm" variant="ghost" icon={Pencil} title="Edytuj" onClick={() => setEdit(sc)} />
                          <Button size="sm" variant="ghost" icon={Trash2} title="Usuń" onClick={() => setDel(sc)} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {!list && (
                  <tr>
                    <td colSpan={4} className="center-text">
                      Wczytywanie…
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <ScriptModal
        script={edit}
        onClose={() => setEdit(null)}
        onSaved={() => {
          setEdit(null);
          load();
        }}
      />
      <NewJobModal
        open={!!run}
        onClose={() => setRun(null)}
        // skrypt klienta — do wyboru tylko jego komputery
        agents={run?.clientId ? agents.filter((a) => a.clientId === run.clientId) : agents}
        preselected={[]}
        initialScript={run ?? undefined}
      />
      <Confirm text={del ? `Skrypt „${del.name}” zostanie usunięty z biblioteki. Historia wykonanych zadań zostaje.` : null} onYes={remove} onClose={() => setDel(null)} busy={busy} />
    </>
  );
}

function ScriptModal({ script, onClose, onSaved }: { script: LibraryScript | 'new' | null; onClose: () => void; onSaved: () => void }) {
  const defClient = useDefaultClient();
  const [f, setF] = useState<ScriptInput>({ name: '', description: '', shell: 'powershell', body: '', timeoutSec: 600, asUser: false, clientId: null });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const existing = script && script !== 'new' ? script : null;

  useEffect(() => {
    if (!script) return;
    setError('');
    setF(
      existing
        ? { name: existing.name, description: existing.description, shell: existing.shell, body: existing.body, timeoutSec: existing.timeoutSec, asUser: existing.asUser, clientId: existing.clientId }
        : { name: '', description: '', shell: 'powershell', body: '', timeoutSec: 600, asUser: false, clientId: defClient },
    );
  }, [script]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof ScriptInput>(k: K, v: ScriptInput[K]) => setF((x) => ({ ...x, [k]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (existing) await api.updateScript(existing.id, f);
      else await api.createScript(f);
      toast('Zapisano skrypt');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={!!script} onClose={onClose} wide>
      <form onSubmit={submit}>
        <h3>{existing ? `Edycja: ${existing.name}` : 'Nowy skrypt'}</h3>
        <div className="form-2">
          <Field label="Nazwa">
            <input className="pole" value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={100} required autoFocus placeholder="Np. Czyszczenie kolejki wydruku" />
          </Field>
          <Field label="Klient" hint="Skrypt klienta widzą konta tego klienta.">
            <ClientSelect value={f.clientId} onChange={(v) => set('clientId', v)} sharedLabel="Wspólny (wszyscy klienci)" />
          </Field>
        </div>
        <Field label="Opis">
          <input className="pole" value={f.description} onChange={(e) => set('description', e.target.value)} maxLength={500} placeholder="Opcjonalnie — co robi i kiedy go używać" />
        </Field>
        <div className="form-2">
          <Field label="Powłoka">
            <select className="pole" value={f.shell} onChange={(e) => set('shell', e.target.value as ScriptShell)}>
              {SHELLS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Limit czasu">
            <select className="pole" value={f.timeoutSec} onChange={(e) => set('timeoutSec', Number(e.target.value))}>
              {TIMEOUTS.map((s) => (
                <option key={s} value={s}>
                  {timeoutLabel(s)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Skrypt">
          <textarea className="pole mono script-input" value={f.body} onChange={(e) => set('body', e.target.value)} rows={10} spellCheck={false} autoCapitalize="off" autoCorrect="off" />
        </Field>
        <label className={`choice ${f.asUser ? 'on' : ''}`}>
          <input type="checkbox" className="cb" checked={f.asUser} onChange={(e) => set('asUser', e.target.checked)} />
          <span>
            Jako zalogowany użytkownik
            <small>Domyślnie skrypt działa jako usługa z pełnymi uprawnieniami.</small>
          </span>
        </label>
        {existing && existing.usedBy.length > 0 && (
          <div className="callout callout-brand">
            <CalendarClock />
            <div className="small">Zmiany obowiązują od najbliższego uruchomienia w harmonogramie: {existing.usedBy.join(', ')}.</div>
          </div>
        )}
        {error && <div className="form-error">{error}</div>}
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

// ---------- harmonogram ----------

function targetLabel(s: Schedule, clientName: string | undefined): string {
  switch (s.target.type) {
    case 'all':
      return 'wszystkie komputery';
    case 'client':
      return `wszystkie komputery: ${clientName ?? 'klient'}`;
    case 'tag':
      return `z tagiem ${s.target.tagName ?? '?'}`;
    case 'agents':
      return `wybrane komputery`;
  }
}

export function SchedulesTab({ agents, action }: { agents: Agent[]; action: number }) {
  const { clients } = useOrg();
  const [list, setList] = useState<Schedule[] | null>(null);
  const [edit, setEdit] = useState<Schedule | 'new' | null>(null);
  const [del, setDel] = useState<Schedule | null>(null);
  const [busy, setBusy] = useState<number | 'del' | null>(null);

  const load = useCallback(() => {
    api.schedules().then(setList, (e) => toast(errorMessage(e), 'err'));
  }, []);
  useEffect(load, [load]);
  useHeaderAction(action, () => setEdit('new'));
  // po uruchomieniu (także o czasie) odśwież „ostatnie”
  useEffect(() => {
    const on = () => load();
    window.addEventListener('overvnc:jobs', on);
    return () => window.removeEventListener('overvnc:jobs', on);
  }, [load]);

  const runNow = async (s: Schedule) => {
    setBusy(s.id);
    try {
      const r = await api.runSchedule(s.id);
      location.hash = `/jobs/${r.jobId}`;
    } catch (e) {
      toast(errorMessage(e), 'err');
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    if (!del) return;
    setBusy('del');
    try {
      await api.deleteSchedule(del.id);
      toast('Usunięto harmonogram');
      setDel(null);
      load();
    } catch (e) {
      toast(errorMessage(e), 'err');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {list && list.length === 0 ? (
        <EmptyState icon={CalendarClock} title="Brak harmonogramów" text="Np. codziennie o 3:00 wyczyść kolejkę wydruku na wszystkich kioskach klienta albo w piątek o 19:45 wyświetl komunikat o zamknięciu.">
          <Button variant="primary" icon={CalendarClock} onClick={() => setEdit('new')}>
            Nowy harmonogram
          </Button>
        </EmptyState>
      ) : (
        <div className="glass-card table-card anim-rise">
          <div className="table-scroll">
            <table className="table stack">
              <thead>
                <tr>
                  <th>Harmonogram</th>
                  <th>Kiedy</th>
                  <th>Następne</th>
                  <th>Ostatnie</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(list ?? []).map((s) => {
                  const K = KIND_META[s.kind];
                  const c = clients.find((x) => x.id === s.clientId);
                  return (
                    <tr key={s.id} className={s.enabled ? '' : 'paused'}>
                      <td className="s-main">
                        <div className="strong">
                          {s.name} {!s.enabled && <Badge>wstrzymany</Badge>}
                        </div>
                        <div className="small muted">
                          <K.icon className="inline-icon" /> {s.kind === 'script' ? (s.scriptName ?? 'skrypt usunięty') : K.label} · {targetLabel(s, c?.name)} ({s.targetCount}{' '}
                          {plural(s.targetCount, 'komputer', 'komputery', 'komputerów')})
                        </div>
                        {c && s.target.type !== 'client' && (
                          <div className="small">
                            <ClientLabel name={c.name} color={c.color} />
                          </div>
                        )}
                      </td>
                      <td className="s-end nowrap">
                        <span className="strong">{s.time}</span> <span className="small muted">{daysLabel(s.days)}</span>
                      </td>
                      <td className={s.nextRunAt ? 's-meta small ink-2 nowrap' : 's-hide'} data-label="Następne">
                        {s.nextRunAt ? whenLabel(s.nextRunAt) : '—'}
                      </td>
                      <td className={s.lastJob ? 's-meta small nowrap' : 's-hide'} data-label="Ostatnie">
                        {s.lastJob ? (
                          <a href={`#/jobs/${s.lastJob.id}`}>
                            {ago(s.lastRunAt)} ·{' '}
                            <span style={{ color: s.lastJob.finished ? (s.lastJob.ok === s.lastJob.total ? 'rgb(var(--success))' : 'rgb(var(--warning))') : undefined }}>
                              {s.lastJob.ok}/{s.lastJob.total}
                            </span>
                          </a>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="s-full">
                        <div className="cell-actions">
                          <Button size="sm" icon={Play} loading={busy === s.id} onClick={() => void runNow(s)} title="Uruchom teraz (poza harmonogramem)">
                            Teraz
                          </Button>
                          <Button size="sm" variant="ghost" icon={Pencil} title="Edytuj" onClick={() => setEdit(s)} />
                          <Button size="sm" variant="ghost" icon={Trash2} title="Usuń" onClick={() => setDel(s)} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {!list && (
                  <tr>
                    <td colSpan={5} className="center-text">
                      Wczytywanie…
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <ScheduleModal
        schedule={edit}
        agents={agents}
        onClose={() => setEdit(null)}
        onSaved={() => {
          setEdit(null);
          load();
        }}
      />
      <Confirm text={del ? `Harmonogram „${del.name}” zostanie usunięty. Wykonane zadania zostają w historii.` : null} onYes={remove} onClose={() => setDel(null)} busy={busy === 'del'} />
    </>
  );
}

type TargetType = ScheduleTarget['type'];
/** harmonogram: bez wdrożeń plików (te uruchamia się ręcznie) */
type ScheduleKind = Exclude<JobKind, 'deploy'>;
const SCHEDULE_KINDS: ScheduleKind[] = ['script', 'message', 'power', 'inventory'];

function ScheduleModal({ schedule, agents, onClose, onSaved }: { schedule: Schedule | 'new' | null; agents: Agent[]; onClose: () => void; onSaved: () => void }) {
  const { tags } = useOrg();
  const defClient = useDefaultClient();
  const existing = schedule && schedule !== 'new' ? schedule : null;
  const [name, setName] = useState('');
  const [clientId, setClientId] = useState<number | null>(null);
  const [kind, setKind] = useState<ScheduleKind>('script');
  const [scriptId, setScriptId] = useState<number | null>(null);
  const [msgText, setMsgText] = useState('');
  const [msgTitle, setMsgTitle] = useState('');
  const [msgSeconds, setMsgSeconds] = useState(300);
  const [powerAction, setPowerAction] = useState<'reboot' | 'shutdown'>('reboot');
  const [delay, setDelay] = useState(0);
  const [targetType, setTargetType] = useState<TargetType>('client');
  const [tagId, setTagId] = useState<number | null>(null);
  const [ids, setIds] = useState<string[]>([]);
  const [days, setDays] = useState(EVERYDAY);
  const [time, setTime] = useState('03:00');
  const [waitHours, setWaitHours] = useState(1);
  const [enabled, setEnabled] = useState(true);
  const [scripts, setScripts] = useState<LibraryScript[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!schedule) return;
    setError('');
    api.scripts().then(setScripts, () => setScripts([]));
    const s = existing;
    setName(s?.name ?? '');
    setClientId(s ? s.clientId : defClient);
    setKind((s?.kind as ScheduleKind | undefined) ?? 'script');
    setScriptId(s?.kind === 'script' ? s.params.scriptId : null);
    setMsgText(s?.kind === 'message' ? s.params.text : '');
    setMsgTitle(s?.kind === 'message' ? (s.params.title ?? '') : '');
    setMsgSeconds(s?.kind === 'message' ? (s.params.seconds ?? 300) : 300);
    setPowerAction(s?.kind === 'power' ? s.params.action : 'reboot');
    setDelay(s?.kind === 'power' ? (s.params.delayMinutes ?? 0) : 0);
    setTargetType(s?.target.type ?? (defClient === null ? 'all' : 'client'));
    setTagId(s?.target.tagId ?? null);
    setIds(s?.target.agentIds ?? []);
    setDays(s?.days ?? EVERYDAY);
    setTime(s?.time ?? '03:00');
    setWaitHours(s?.waitHours ?? 1);
    setEnabled(s?.enabled ?? true);
  }, [schedule]); // eslint-disable-line react-hooks/exhaustive-deps

  // „wszystkie komputery” ↔ „wszystkie komputery klienta” zależnie od wybranego klienta
  useEffect(() => {
    if (clientId === null && targetType === 'client') setTargetType('all');
    if (clientId !== null && targetType === 'all') setTargetType('client');
  }, [clientId, targetType]);

  const scopedAgents = useMemo(() => (clientId === null ? agents : agents.filter((a) => a.clientId === clientId)), [agents, clientId]);
  const usableScripts = scripts.filter((s) => s.clientId === null || s.clientId === clientId);
  const count =
    targetType === 'agents'
      ? ids.length
      : targetType === 'tag'
        ? scopedAgents.filter((a) => a.tags.some((t) => t.id === tagId)).length
        : scopedAgents.length;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    let target: ScheduleTarget;
    if (targetType === 'agents') {
      const keep = ids.filter((id) => scopedAgents.some((a) => a.id === id));
      if (!keep.length) return setError('Wybierz co najmniej jeden komputer.');
      target = { type: 'agents', agentIds: keep };
    } else if (targetType === 'tag') {
      if (!tagId) return setError('Wybierz tag.');
      target = { type: 'tag', tagId };
    } else target = { type: targetType };
    const common = { name: name.trim(), clientId, target, days, time, waitHours, enabled };
    let body: ScheduleInput;
    if (kind === 'script') {
      if (!scriptId) return setError('Wybierz skrypt z biblioteki.');
      body = { ...common, kind, params: { scriptId } };
    } else if (kind === 'message') {
      if (!msgText.trim()) return setError('Wpisz treść komunikatu.');
      body = { ...common, kind, params: { text: msgText, title: msgTitle, seconds: msgSeconds } };
    } else if (kind === 'power') body = { ...common, kind, params: { action: powerAction, delayMinutes: delay } };
    else body = { ...common, kind, params: {} };
    if (!days) return setError('Wybierz co najmniej jeden dzień.');
    setBusy(true);
    setError('');
    try {
      if (existing) await api.updateSchedule(existing.id, body);
      else await api.createSchedule(body);
      toast('Zapisano harmonogram');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={!!schedule} onClose={onClose} wide>
      <form onSubmit={submit}>
        <h3>{existing ? `Edycja: ${existing.name}` : 'Nowy harmonogram'}</h3>
        <div className="form-2">
          <Field label="Nazwa">
            <input className="pole" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required autoFocus placeholder="Np. Nocne czyszczenie kolejki wydruku" />
          </Field>
          <Field label="Klient">
            <ClientSelect value={clientId} onChange={setClientId} sharedLabel="Wszyscy klienci" />
          </Field>
        </div>

        <Field label="Co zrobić" group>
          <div className="seg seg-wrap" role="tablist" aria-label="Rodzaj zadania">
            {SCHEDULE_KINDS.map((k) => {
              const M = KIND_META[k];
              return (
                <button type="button" key={k} role="tab" aria-selected={kind === k} className={`seg-btn ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>
                  <M.icon className="inline-icon" /> {M.label}
                </button>
              );
            })}
          </div>
        </Field>

        {kind === 'script' &&
          (usableScripts.length === 0 ? (
            <div className="callout callout-warning">
              <BookMarked />
              <div className="small">
                Harmonogram uruchamia skrypty z biblioteki — najpierw dodaj skrypt w zakładce{' '}
                <a href="#/jobs/scripts" onClick={onClose}>
                  Skrypty
                </a>
                .
              </div>
            </div>
          ) : (
            <Field label="Skrypt z biblioteki" hint="Zmiany skryptu w bibliotece obowiązują od najbliższego uruchomienia.">
              <select className="pole" value={scriptId ?? ''} onChange={(e) => setScriptId(e.target.value ? Number(e.target.value) : null)}>
                <option value="">Wybierz…</option>
                {usableScripts.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
          ))}
        {kind === 'message' && (
          <>
            <div className="form-2">
              <Field label="Tytuł">
                <input className="pole" value={msgTitle} onChange={(e) => setMsgTitle(e.target.value)} maxLength={80} placeholder="Komunikat" />
              </Field>
              <Field label="Czas wyświetlania">
                <select className="pole" value={msgSeconds} onChange={(e) => setMsgSeconds(Number(e.target.value))}>
                  {MESSAGE_TIMES.map((s) => (
                    <option key={s} value={s}>
                      {s < 60 ? `${s} s` : s < 3600 ? `${s / 60} min` : '1 godz.'}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Treść">
              <textarea className="pole" value={msgText} onChange={(e) => setMsgText(e.target.value)} rows={3} maxLength={500} />
            </Field>
          </>
        )}
        {kind === 'power' && (
          <div className="form-2">
            <Field label="Akcja">
              <select className="pole" value={powerAction} onChange={(e) => setPowerAction(e.target.value as 'reboot' | 'shutdown')}>
                <option value="reboot">Restart</option>
                <option value="shutdown">Wyłączenie</option>
              </select>
            </Field>
            <Field label="Z opóźnieniem">
              <select className="pole" value={delay} onChange={(e) => setDelay(Number(e.target.value))}>
                <option value={0}>Bez opóźnienia</option>
                <option value={1}>1 min</option>
                <option value={5}>5 min</option>
                <option value={15}>15 min</option>
              </select>
            </Field>
          </div>
        )}

        <Field label="Na których komputerach" group>
          <div className="seg seg-wrap" role="tablist" aria-label="Cel">
            {(
              [
                [clientId === null ? 'all' : 'client', clientId === null ? 'Wszystkie' : 'Wszystkie klienta'],
                ['tag', 'Z tagiem'],
                ['agents', 'Wybrane'],
              ] as [TargetType, string][]
            ).map(([k, label]) => (
              <button type="button" key={k} role="tab" aria-selected={targetType === k} className={`seg-btn ${targetType === k ? 'on' : ''}`} onClick={() => setTargetType(k)}>
                {label}
              </button>
            ))}
          </div>
        </Field>
        {targetType === 'tag' &&
          (tags.length === 0 ? (
            <div className="small muted">Brak tagów — dodaj je w zakładce Klienci.</div>
          ) : (
            <div className="chips">
              {tags.map((t) => (
                <button type="button" key={t.id} className={`tag-pick ${tagId === t.id ? 'on' : ''}`} onClick={() => setTagId(t.id)}>
                  <TagChip name={t.name} color={t.color} />
                </button>
              ))}
            </div>
          ))}
        {targetType === 'agents' && <TargetPicker agents={scopedAgents} ids={ids} onChange={setIds} />}
        <div className="small muted">
          {targetType === 'agents'
            ? `Wybrano: ${count}.`
            : `Teraz: ${count} ${plural(count, 'komputer', 'komputery', 'komputerów')} — nowe komputery ${targetType === 'tag' ? 'z tym tagiem' : 'klienta'} dołączą automatycznie.`}
        </div>

        <Field label="Kiedy (czas polski)" group>
          <div className="when-row">
            <div className="day-chips">
              {DAY_LABELS.map((d, i) => (
                <button type="button" key={d} className={`day-chip ${days & (1 << i) ? 'on' : ''}`} aria-pressed={!!(days & (1 << i))} onClick={() => setDays(days ^ (1 << i))}>
                  {d}
                </button>
              ))}
            </div>
            <input className="pole" type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
          </div>
          <div className="when-row small">
            <button type="button" className="link-btn" onClick={() => setDays(EVERYDAY)}>
              codziennie
            </button>
            <button type="button" className="link-btn" onClick={() => setDays(WORKDAYS)}>
              dni robocze
            </button>
            <button type="button" className="link-btn" onClick={() => setDays(0b1100000)}>
              weekend
            </button>
          </div>
        </Field>

        <Field label="Komputery offline">
          <select className="pole" value={waitHours} onChange={(e) => setWaitHours(Number(e.target.value))}>
            {WAITS.map((w) => (
              <option key={w.h} value={w.h}>
                {w.label}
              </option>
            ))}
          </select>
        </Field>

        <label className={`choice ${enabled ? 'on' : ''}`}>
          <input type="checkbox" className="cb" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>
            Włączony
            <small>Wstrzymany harmonogram nie uruchamia się, ale można go uruchomić ręcznie.</small>
          </span>
        </label>

        {error && <div className="form-error">{error}</div>}
        <div className="okno-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            Anuluj
          </Button>
          <Button variant="primary" icon={CalendarClock} loading={busy}>
            Zapisz
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- pliki do wdrażania ----------

export function PackagesTab({ agents, action }: { agents: Agent[]; action: number }) {
  const { clients } = useOrg();
  const [list, setList] = useState<Package[] | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [deploy, setDeploy] = useState<Package | null>(null);
  const [del, setDel] = useState<Package | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.packages().then(setList, (e) => toast(errorMessage(e), 'err'));
  }, []);
  useEffect(load, [load]);
  useHeaderAction(action, () => setUploadOpen(true));

  const remove = async () => {
    if (!del) return;
    setBusy(true);
    try {
      await api.deletePackage(del.id);
      toast('Usunięto plik');
      setDel(null);
      load();
    } catch (e) {
      toast(errorMessage(e), 'err');
      setDel(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {list && list.length === 0 ? (
        <EmptyState icon={FileDown} title="Brak plików" text="Wyślij instalator (MSI, EXE), archiwum ZIP albo plik konfiguracyjny — potem wdrożysz go na wiele komputerów naraz, także na te, które włączą się później.">
          <Button variant="primary" icon={Upload} onClick={() => setUploadOpen(true)}>
            Wyślij plik
          </Button>
        </EmptyState>
      ) : (
        <div className="glass-card table-card anim-rise">
          <div className="table-scroll">
            <table className="table stack">
              <thead>
                <tr>
                  <th>Plik</th>
                  <th>Klient</th>
                  <th>Wysłany</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(list ?? []).map((p) => {
                  const c = clients.find((x) => x.id === p.clientId);
                  return (
                    <tr key={p.id} className={p.ready ? '' : 'paused'}>
                      <td className="s-main">
                        <div className="strong ellipsis">{p.name}</div>
                        <div className="small muted">
                          {bytes(p.size)}
                          {!p.ready && ` · wysyłanie przerwane (${Math.round((p.received / p.size) * 100)}%)`}
                          {p.sha256 && <span className="mono"> · SHA-256 {p.sha256.slice(0, 12)}…</span>}
                        </div>
                      </td>
                      <td className="s-full">{c ? <ClientLabel name={c.name} color={c.color} /> : <span className="small muted">wspólny</span>}</td>
                      <td className="s-meta small ink-2 nowrap" data-label="Wysłany">
                        {ago(p.createdAt)} · {p.createdBy}
                      </td>
                      <td className="s-full">
                        <div className="cell-actions">
                          {p.ready && (
                            <Button size="sm" variant="primary" icon={FileDown} onClick={() => setDeploy(p)}>
                              Wdróż
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" icon={Trash2} title="Usuń" onClick={() => setDel(p)} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {!list && (
                  <tr>
                    <td colSpan={4} className="center-text">
                      Wczytywanie…
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <UploadModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onDone={() => {
          setUploadOpen(false);
          load();
        }}
      />
      <NewJobModal
        open={!!deploy}
        onClose={() => setDeploy(null)}
        agents={deploy?.clientId ? agents.filter((a) => a.clientId === deploy.clientId) : agents}
        preselected={[]}
        initialKind="deploy"
        initialPackage={deploy ?? undefined}
      />
      <Confirm text={del ? `Plik „${del.name}” zostanie usunięty z serwera. Komputery, na które już trafił, zachowają go.` : null} onYes={remove} onClose={() => setDel(null)} busy={busy} />
    </>
  );
}

function UploadModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const defClient = useDefaultClient();
  const [clientId, setClientId] = useState<number | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [sent, setSent] = useState<number | null>(null);
  const [error, setError] = useState('');
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (open) {
      setClientId(defClient);
      setFile(null);
      setSent(null);
      setError('');
    } else abort.current?.abort();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return setError('Wybierz plik.');
    const ac = new AbortController();
    abort.current = ac;
    setError('');
    setSent(0);
    try {
      await api.uploadPackage(file, clientId, setSent, ac.signal);
      toast('Wysłano plik');
      onDone();
    } catch (err) {
      if (!ac.signal.aborted) setError(errorMessage(err));
      setSent(null);
    }
  };

  return (
    <Modal open={open} onClose={onClose}>
      <form onSubmit={submit}>
        <h3>Wyślij plik</h3>
        <Field label="Plik" hint="Do 4 GB. Duże pliki idą kawałkami — chwilowa przerwa w połączeniu nie przerywa wysyłania.">
          <input className="pole" type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} disabled={sent !== null} />
        </Field>
        <Field label="Klient" hint="Plik klienta widzą i wdrażają tylko konta tego klienta.">
          <ClientSelect value={clientId} onChange={setClientId} sharedLabel="Wspólny (wszyscy klienci)" />
        </Field>
        {sent !== null && file && (
          <div className="upload-row">
            <div className="small">
              {bytes(sent)} z {bytes(file.size)}
            </div>
            <div className="jp-track">
              <span className="jp-seg run" style={{ width: `${(sent / Math.max(1, file.size)) * 100}%` }} />
            </div>
          </div>
        )}
        {error && <div className="form-error">{error}</div>}
        <div className="okno-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            {sent !== null ? 'Przerwij' : 'Anuluj'}
          </Button>
          <Button variant="primary" icon={Upload} loading={sent !== null} disabled={!file}>
            Wyślij
          </Button>
        </div>
      </form>
    </Modal>
  );
}
