import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowLeft,
  Ban,
  BookMarked,
  CalendarClock,
  CheckCircle2,
  CircleDashed,
  Clock,
  Copy,
  FileDown,
  FileTerminal,
  Upload,
  ListChecks,
  Loader2,
  MessageSquareText,
  Play,
  Plus,
  Power,
  Save,
  RefreshCw,
  RotateCcw,
  Search,
  TriangleAlert,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { api, errorMessage, type Agent, type Job, type LibraryScript, type Package, type JobDetail, type JobInput, type JobKind, type JobTarget, type JobTargetStatus, type ScriptShell } from '../api.ts';
import { Badge, Button, Checkbox, ClientLabel, EmptyState, Field, Modal, toast } from '../components.tsx';
import { PackagesTab, ScriptsTab, SchedulesTab } from './Automation.tsx';
import { ago, bytes, dateTime, plural } from '../format.ts';
import { useOrg } from '../state.tsx';

// ---------- wspólne ----------

export const KIND_META: Record<JobKind, { label: string; icon: LucideIcon }> = {
  script: { label: 'Skrypt', icon: FileTerminal },
  message: { label: 'Komunikat', icon: MessageSquareText },
  power: { label: 'Zasilanie', icon: Power },
  inventory: { label: 'Inwentarz', icon: RefreshCw },
  deploy: { label: 'Plik', icon: FileDown },
};

const STATUS_META: Record<JobTargetStatus, { label: string; variant: 'success' | 'danger' | 'warning' | 'info' | 'neutral'; icon: LucideIcon }> = {
  queued: { label: 'czeka na komputer', variant: 'neutral', icon: Clock },
  running: { label: 'w trakcie', variant: 'info', icon: Loader2 },
  ok: { label: 'wykonano', variant: 'success', icon: CheckCircle2 },
  failed: { label: 'błąd', variant: 'danger', icon: XCircle },
  expired: { label: 'nie połączył się', variant: 'warning', icon: CircleDashed },
  canceled: { label: 'anulowano', variant: 'neutral', icon: Ban },
  lost: { label: 'wynik nieznany', variant: 'warning', icon: TriangleAlert },
};

/** Odświeżenie po zdarzeniu z serwera (z małym opóźnieniem — duże zadania zmieniają się seriami). */
function useJobsReload(reload: () => void, filter?: (ids: number[]) => boolean) {
  const cb = useRef(reload);
  const f = useRef(filter);
  cb.current = reload;
  f.current = filter;
  useEffect(() => {
    let t: number | undefined;
    const on = (e: Event) => {
      const ids = ((e as CustomEvent).detail ?? []) as number[];
      if (ids.length && f.current && !f.current(ids)) return;
      window.clearTimeout(t);
      t = window.setTimeout(() => cb.current(), 250);
    };
    window.addEventListener('overvnc:jobs', on);
    return () => {
      window.removeEventListener('overvnc:jobs', on);
      window.clearTimeout(t);
    };
  }, []);
}

function jobState(j: Job): { label: string; variant: 'success' | 'danger' | 'warning' | 'info' | 'neutral' } {
  const c = j.counts;
  const bad = c.failed + c.lost + c.expired;
  if (!j.finishedAt) return c.running > 0 ? { label: 'w trakcie', variant: 'info' } : { label: 'czeka na komputery', variant: 'neutral' };
  if (j.canceledAt && c.ok === 0) return { label: 'anulowane', variant: 'neutral' };
  if (bad === 0) return { label: 'zakończone', variant: 'success' };
  if (c.ok === 0) return { label: 'nie powiodło się', variant: 'danger' };
  return { label: `zakończone z błędami (${bad})`, variant: 'warning' };
}

/** Pasek postępu: zielone — wykonane, czerwone — błędy, żółte — nie połączyły się / nieznane, niebieskie — w trakcie. */
function Progress({ j }: { j: Job }) {
  const c = j.counts;
  const total = Math.max(1, j.total);
  const seg = (n: number, cls: string) => (n > 0 ? <span className={`jp-seg ${cls}`} style={{ width: `${(n / total) * 100}%` }} /> : null);
  const done = j.total - c.queued - c.running;
  return (
    <div className="job-progress" title={`${done} z ${j.total} zakończone`}>
      <div className="jp-track">
        {seg(c.ok, 'ok')}
        {seg(c.failed, 'bad')}
        {seg(c.expired + c.lost, 'warn')}
        {seg(c.canceled, 'off')}
        {seg(c.running, 'run')}
      </div>
      <span className="small muted mono nowrap">
        {done}/{j.total}
      </span>
    </div>
  );
}

/** Przycisk w nagłówku strony (wspólny dla zakładek): reaguje tylko na kliknięcia po wejściu na zakładkę. */
export function useHeaderAction(action: number, fn: () => void) {
  const seen = useRef(action);
  const cb = useRef(fn);
  cb.current = fn;
  useEffect(() => {
    if (action !== seen.current) {
      seen.current = action;
      cb.current();
    }
  }, [action]);
}

function PageHead({ title, sub, children, back }: { title: ReactNode; sub?: ReactNode; children?: ReactNode; back?: boolean }) {
  return (
    <header className="page-head anim-rise">
      <div style={{ minWidth: 0 }}>
        {back && (
          <a href="#/jobs" className="back">
            <ArrowLeft /> Zadania
          </a>
        )}
        <h1>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {children && <div className="toolbar">{children}</div>}
    </header>
  );
}

// ---------- lista ----------

export type JobsTab = 'history' | 'schedules' | 'scripts' | 'files';

const JOB_TABS: { key: JobsTab; label: string; icon: LucideIcon; href: string }[] = [
  { key: 'history', label: 'Historia', icon: ListChecks, href: '#/jobs' },
  { key: 'schedules', label: 'Harmonogram', icon: CalendarClock, href: '#/jobs/schedules' },
  { key: 'scripts', label: 'Skrypty', icon: BookMarked, href: '#/jobs/scripts' },
  { key: 'files', label: 'Pliki', icon: FileDown, href: '#/jobs/files' },
];

export function Jobs({ agents, tab }: { agents: Agent[]; tab: JobsTab }) {
  const [action, setAction] = useState(0); // przycisk w nagłówku otwiera okno w zakładce
  return (
    <>
      <PageHead
        title="Zadania"
        sub="Skrypty, komunikaty i restarty na wielu komputerach — wykonują się w tle, także po zamknięciu przeglądarki"
      >
        <Button variant="primary" icon={tab === 'history' ? Play : tab === 'files' ? Upload : Plus} onClick={() => setAction((n) => n + 1)}>
          {tab === 'history' ? 'Nowe zadanie' : tab === 'schedules' ? 'Nowy harmonogram' : tab === 'files' ? 'Wyślij plik' : 'Nowy skrypt'}
        </Button>
      </PageHead>
      <nav className="detail-tabs anim-rise" aria-label="Zadania">
        {JOB_TABS.map((t) => (
          <a key={t.key} href={t.href} className={`detail-tab ${tab === t.key ? 'on' : ''}`} aria-current={tab === t.key ? 'page' : undefined}>
            <t.icon /> <span className="tab-label">{t.label}</span>
          </a>
        ))}
      </nav>
      {tab === 'history' && <JobHistory agents={agents} action={action} />}
      {tab === 'schedules' && <SchedulesTab agents={agents} action={action} />}
      {tab === 'scripts' && <ScriptsTab agents={agents} action={action} />}
      {tab === 'files' && <PackagesTab agents={agents} action={action} />}
    </>
  );
}

function JobHistory({ agents, action }: { agents: Agent[]; action: number }) {
  const agentFilter = new URLSearchParams(location.hash.split('?')[1] ?? '').get('agent');
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const filtered = agentFilter ? agents.find((a) => a.id === agentFilter) : undefined;

  const load = useCallback(() => {
    api.jobs(agentFilter ?? undefined).then(
      (j) => (setJobs(j), setError('')),
      (e) => setError(errorMessage(e)),
    );
  }, [agentFilter]);
  useEffect(load, [load]);
  useJobsReload(load);

  useHeaderAction(action, () => setCreating(true));

  return (
    <>
      {filtered && (
        <div className="callout callout-brand anim-rise">
          <ListChecks />
          <div>
            Zadania komputera <strong>{filtered.label || filtered.hostname}</strong> ·{' '}
            <a href="#/jobs" className="link-btn" style={{ display: 'inline' }}>
              pokaż wszystkie
            </a>
          </div>
        </div>
      )}
      {error && <div className="form-error">{error}</div>}
      {jobs && jobs.length === 0 ? (
        <EmptyState icon={ListChecks} title="Brak zadań" text="Uruchom skrypt albo wyślij komunikat na wybrane komputery. Możesz też zaznaczyć komputery na liście i wybrać akcję na dole.">
          <Button variant="primary" icon={Play} onClick={() => setCreating(true)}>
            Nowe zadanie
          </Button>
        </EmptyState>
      ) : (
        <div className="glass-card table-card anim-rise" style={{ animationDelay: '60ms' }}>
          <div className="table-scroll">
            <table className="table hover clickable stack">
              <thead>
                <tr>
                  <th>Zadanie</th>
                  <th>Stan</th>
                  <th className="w-bar">Postęp</th>
                  <th>Utworzone</th>
                </tr>
              </thead>
              <tbody>
                {(jobs ?? []).map((j) => {
                  const K = KIND_META[j.kind];
                  const st = jobState(j);
                  return (
                    <tr key={j.id} onClick={() => (location.hash = `/jobs/${j.id}`)}>
                      <td className="s-main">
                        <div className="host">
                          <span className="host-icon on">
                            <K.icon />
                          </span>
                          <div style={{ minWidth: 0 }}>
                            <div className="strong ellipsis">{j.title}</div>
                            <div className="muted small">
                              {K.label} · {j.total} {plural(j.total, 'komputer', 'komputery', 'komputerów')}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="s-end">
                        <Badge variant={st.variant}>{st.label}</Badge>
                      </td>
                      <td className="s-full w-bar">
                        <Progress j={j} />
                      </td>
                      <td className="s-meta small ink-2 nowrap" data-label="Utworzone">
                        {ago(j.createdAt)} · {j.scheduleId ? 'harmonogram' : j.createdBy}
                      </td>
                    </tr>
                  );
                })}
                {!jobs && (
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

      <NewJobModal open={creating} onClose={() => setCreating(false)} agents={agents} preselected={filtered ? [filtered.id] : []} />
    </>
  );
}

// ---------- szczegóły ----------

export function JobPage({ id, agents }: { id: number; agents: Map<string, Agent> }) {
  const [job, setJob] = useState<JobDetail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'cancel' | 'retry' | null>(null);
  const [output, setOutput] = useState<JobTarget | null>(null);
  const [statusF, setStatusF] = useState<JobTargetStatus | 'all'>('all');

  const load = useCallback(() => {
    api.job(id).then(
      (j) => (setJob(j), setError('')),
      (e) => setError(errorMessage(e)),
    );
  }, [id]);
  useEffect(load, [load]);
  useJobsReload(load, (ids) => ids.includes(id));

  if (error && !job) return <EmptyState icon={ListChecks} title="Nie znaleziono zadania" text={error} />;
  if (!job) return <div className="muted">Wczytywanie…</div>;

  const K = KIND_META[job.kind];
  const st = jobState(job);
  const retryable = job.counts.failed + job.counts.expired + job.counts.lost + job.counts.canceled;
  const targets = job.targets.filter((t) => statusF === 'all' || t.status === statusF);
  const present = (Object.keys(STATUS_META) as JobTargetStatus[]).filter((s) => job.counts[s] > 0);

  const cancel = async () => {
    setBusy('cancel');
    try {
      await api.cancelJob(id);
      toast('Anulowano oczekujące komputery');
      load();
    } catch (e) {
      toast(errorMessage(e), 'err');
    } finally {
      setBusy(null);
    }
  };
  const retry = async () => {
    setBusy('retry');
    try {
      const r = await api.retryJob(id);
      location.hash = `/jobs/${r.id}`;
    } catch (e) {
      toast(errorMessage(e), 'err');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHead
        back
        title={
          <>
            <span className="ellipsis" style={{ minWidth: 0 }}>
              {job.title}
            </span>
            <Badge variant={st.variant}>{st.label}</Badge>
          </>
        }
        sub={
          <>
            <span>
              <K.icon className="inline-icon" /> {K.label}
            </span>
            <span>
              {dateTime(job.createdAt)} · {job.createdBy}
            </span>
            {!job.finishedAt && job.counts.queued > 0 && <span>komputery offline czekają do {dateTime(job.expiresAt)}</span>}
          </>
        }
      >
        {!job.finishedAt && job.counts.queued > 0 && (
          <Button icon={Ban} loading={busy === 'cancel'} onClick={cancel}>
            Anuluj oczekujące
          </Button>
        )}
        {job.finishedAt !== null && retryable > 0 && (
          <Button variant="primary" icon={RotateCcw} loading={busy === 'retry'} onClick={retry}>
            Ponów nieudane ({retryable})
          </Button>
        )}
      </PageHead>

      <section className="glass-card card anim-rise job-summary">
        <Progress j={job} />
        <JobParamsView job={job} />
      </section>

      {present.length > 1 && (
        <div className="seg anim-rise" role="tablist" aria-label="Filtr wyników" style={{ alignSelf: 'flex-start', maxWidth: '100%', overflowX: 'auto' }}>
          <button role="tab" aria-selected={statusF === 'all'} className={`seg-btn ${statusF === 'all' ? 'on' : ''}`} onClick={() => setStatusF('all')}>
            Wszystkie ({job.total})
          </button>
          {present.map((s) => (
            <button key={s} role="tab" aria-selected={statusF === s} className={`seg-btn ${statusF === s ? 'on' : ''}`} onClick={() => setStatusF(s)}>
              {STATUS_META[s].label} ({job.counts[s]})
            </button>
          ))}
        </div>
      )}

      <div className="glass-card table-card anim-rise" style={{ animationDelay: '60ms' }}>
        <div className="table-scroll">
          <table className="table stack">
            <thead>
              <tr>
                <th>Komputer</th>
                <th>Stan</th>
                <th>Wynik</th>
                <th>Czas</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {targets.map((t) => {
                const S = STATUS_META[t.status];
                const live = agents.get(t.agentId);
                const online = live?.online ?? t.online;
                const secs = t.startedAt && t.finishedAt ? Math.max(0, Math.round((t.finishedAt - t.startedAt) / 1000)) : null;
                return (
                  <tr key={t.agentId}>
                    <td className="s-main">
                      <a className="strong" href={`#/m/${t.agentId}`}>
                        {t.name}
                      </a>
                      <div className="small muted">
                        <ClientLabel name={t.clientName} color={t.clientColor} />
                        {t.status === 'queued' && <span> · {online ? 'online' : 'offline'}</span>}
                      </div>
                    </td>
                    <td className="s-end">
                      <Badge variant={S.variant}>
                        <S.icon className={t.status === 'running' ? 'spin' : undefined} /> {S.label}
                      </Badge>
                    </td>
                    <td className="s-full job-result">
                      <div className="job-line">
                        {t.exitCode !== null && t.exitCode !== 0 && <span className="mono small danger-ink nowrap">kod {t.exitCode}</span>}
                        {t.error ? <span className="small">{t.error}</span> : t.preview ? <span className="mono small ellipsis">{t.preview}</span> : t.status === 'ok' && job.kind === 'script' ? <span className="small muted">brak wyjścia</span> : null}
                      </div>
                      {t.runAs && <div className="small muted">jako {t.runAs}</div>}
                    </td>
                    <td className={secs !== null ? 's-meta small ink-2 nowrap' : 's-hide'} data-label="Czas">
                      {secs !== null ? (secs < 60 ? `${secs} s` : `${Math.floor(secs / 60)} min ${secs % 60} s`) : ''}
                    </td>
                    <td className="s-full" style={{ textAlign: 'right' }}>
                      {t.outputBytes > 0 && (
                        <Button size="sm" variant="ghost" icon={FileTerminal} onClick={() => setOutput(t)}>
                          Wyjście
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <OutputModal jobId={id} target={output} onClose={() => setOutput(null)} />
    </>
  );
}

function JobParamsView({ job }: { job: Job }) {
  const p = job.params;
  if (job.kind === 'script')
    return (
      <div className="job-params">
        <div className="small muted">
          {SHELLS.find((s) => s.id === p.shell)?.label ?? p.shell} · limit {timeoutLabel(p.timeoutSec)}
          {p.asUser ? ' · jako zalogowany użytkownik' : ' · jako usługa (SYSTEM / root)'}
        </div>
        <pre className="job-script">{p.script}</pre>
      </div>
    );
  if (job.kind === 'message')
    return (
      <div className="job-params small">
        {p.title && <strong>{p.title}: </strong>}
        {p.text} <span className="muted">· {p.seconds} s</span>
      </div>
    );
  if (job.kind === 'power')
    return (
      <div className="job-params small">
        {p.action === 'reboot' ? 'Restart' : 'Wyłączenie'}
        {p.delayMinutes ? ` za ${p.delayMinutes} min` : ' od razu'}
        {p.message ? ` · „${p.message}”` : ''}
      </div>
    );
  return null;
}

function OutputModal({ jobId, target, onClose }: { jobId: number; target: JobTarget | null; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    setText(null);
    if (!target) return;
    api.jobOutput(jobId, target.agentId).then(
      (r) => setText(r.output),
      (e) => setText(`(${errorMessage(e)})`),
    );
  }, [jobId, target]);
  const copy = () => {
    if (text === null) return;
    navigator.clipboard?.writeText(text).then(
      () => toast('Skopiowano'),
      () => toast('Nie udało się skopiować', 'err'),
    );
  };
  return (
    <Modal open={!!target} onClose={onClose} wide>
      <h3>Wyjście: {target?.name}</h3>
      {target?.exitCode !== null && target?.exitCode !== undefined && <div className="small muted">kod wyjścia {target.exitCode}</div>}
      <pre className="job-output">{text ?? 'Wczytywanie…'}</pre>
      <div className="okno-actions">
        <Button variant="ghost" icon={Copy} onClick={copy} disabled={text === null}>
          Kopiuj
        </Button>
        <Button variant="primary" onClick={onClose}>
          Zamknij
        </Button>
      </div>
    </Modal>
  );
}

// ---------- nowe zadanie ----------

export const SHELLS: { id: ScriptShell; label: string; family: 'windows' | 'unix' }[] = [
  { id: 'powershell', label: 'PowerShell', family: 'windows' },
  { id: 'cmd', label: 'Wiersz poleceń (cmd)', family: 'windows' },
  { id: 'pwsh', label: 'PowerShell 7 (pwsh)', family: 'windows' },
  { id: 'sh', label: 'sh (macOS, Linux)', family: 'unix' },
  { id: 'bash', label: 'bash (macOS, Linux)', family: 'unix' },
  { id: 'zsh', label: 'zsh (macOS)', family: 'unix' },
];
type AfterDeploy = 'none' | 'msi' | 'exe' | 'zip' | 'custom';
const AFTER_DEPLOY: { id: AfterDeploy; label: string; shell?: ScriptShell; script?: string }[] = [
  { id: 'none', label: 'Nic — tylko skopiuj' },
  {
    id: 'msi',
    label: 'Zainstaluj MSI (po cichu)',
    shell: 'powershell',
    script: "$p = Start-Process msiexec.exe -ArgumentList '/i', ('\"' + $env:OVERVNC_FILE + '\"'), '/qn', '/norestart' -Wait -PassThru\n# 3010 = zainstalowano, wymagany restart\nif ($p.ExitCode -eq 3010) { 'Wymagany restart'; exit 0 }\nexit $p.ExitCode",
  },
  {
    id: 'exe',
    label: 'Uruchom instalator EXE (po cichu)',
    shell: 'powershell',
    script: "# parametry cichej instalacji zależą od programu: /S (NSIS), /VERYSILENT (Inno Setup), /quiet\n$p = Start-Process $env:OVERVNC_FILE -ArgumentList '/S' -Wait -PassThru\nexit $p.ExitCode",
  },
  { id: 'zip', label: 'Rozpakuj ZIP obok pliku', shell: 'powershell', script: 'Expand-Archive -Path $env:OVERVNC_FILE -DestinationPath (Split-Path $env:OVERVNC_FILE) -Force' },
  { id: 'custom', label: 'Własne polecenie', script: '' },
];

export const TIMEOUTS = [60, 300, 600, 1800, 3600, 7200, 14400];
export const WAITS: { h: number; label: string }[] = [
  { h: 0, label: 'Tylko komputery online — pozostałe pominąć' },
  { h: 1, label: 'Czekać na komputery offline do 1 godz.' },
  { h: 24, label: 'Czekać na komputery offline do 24 godz.' },
  { h: 72, label: 'Czekać na komputery offline do 3 dni' },
  { h: 168, label: 'Czekać na komputery offline do 7 dni' },
];
export const MESSAGE_TIMES = [30, 60, 300, 900, 3600];

export function timeoutLabel(s: number): string {
  return s < 3600 ? `${Math.round(s / 60)} min` : `${s / 3600} godz.`;
}

export function NewJobModal({
  open,
  onClose,
  agents,
  preselected,
  initialKind = 'script',
  initialScript,
  initialPackage,
}: {
  open: boolean;
  onClose: () => void;
  agents: Agent[];
  preselected: string[];
  initialKind?: JobKind;
  /** wczytany skrypt z biblioteki („Uruchom” w zakładce Skrypty) */
  initialScript?: LibraryScript;
  /** plik do wdrożenia („Wdróż” w zakładce Pliki) */
  initialPackage?: Package;
}) {
  const [kind, setKind] = useState<JobKind>(initialKind);
  const [ids, setIds] = useState<string[]>(preselected);
  const [shell, setShell] = useState<ScriptShell>('powershell');
  const [script, setScript] = useState('');
  const [timeoutSec, setTimeoutSec] = useState(600);
  const [asUser, setAsUser] = useState(false);
  const [msgTitle, setMsgTitle] = useState('');
  const [msgText, setMsgText] = useState('');
  const [msgSeconds, setMsgSeconds] = useState(60);
  const [powerAction, setPowerAction] = useState<'reboot' | 'shutdown'>('reboot');
  const [delay, setDelay] = useState(0);
  const [powerMsg, setPowerMsg] = useState('');
  const [waitHours, setWaitHours] = useState(24);
  const [waitTouched, setWaitTouched] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [library, setLibrary] = useState<LibraryScript[] | null>(null);
  const [saveName, setSaveName] = useState<string | null>(null);
  const [packages, setPackages] = useState<Package[] | null>(null);
  const [pkgId, setPkgId] = useState<number | null>(null);
  const [deployDir, setDeployDir] = useState('');
  const [overwrite, setOverwrite] = useState(true);
  const [after, setAfter] = useState<AfterDeploy>('none');
  const [uploading, setUploading] = useState<{ name: string; sent: number; size: number } | null>(null);
  const uploadAbort = useRef<AbortController | null>(null);
  const fixedTargets = preselected.length > 0;

  const loadScript = (sc: LibraryScript) => {
    setShell(sc.shell);
    setScript(sc.body);
    setTimeoutSec(sc.timeoutSec);
    setAsUser(sc.asUser);
  };
  const saveToLibrary = async () => {
    if (!saveName?.trim() || !script.trim()) return;
    try {
      const sel = agents.filter((a) => ids.includes(a.id));
      const clientIds = [...new Set(sel.map((a) => a.clientId))];
      const sc = await api.createScript({
        name: saveName.trim(),
        description: '',
        shell,
        body: script,
        timeoutSec,
        asUser,
        // jeden klient wśród wybranych komputerów — skrypt trafia do jego biblioteki; inaczej wspólny
        clientId: clientIds.length === 1 ? clientIds[0] : null,
      });
      setLibrary((l) => [...(l ?? []), sc]);
      setSaveName(null);
      toast('Zapisano w bibliotece');
    } catch (e) {
      toast(errorMessage(e), 'err');
    }
  };

  useEffect(() => {
    if (!open) return;
    setKind(initialKind);
    setIds(preselected);
    setError('');
    setWaitTouched(false);
    // domyślna powłoka wg systemów zaznaczonych komputerów
    const sel = agents.filter((a) => preselected.includes(a.id));
    setShell(sel.length > 0 && sel.every((a) => a.os !== 'windows') ? 'bash' : 'powershell');
    setSaveName(null);
    if (initialScript) loadScript(initialScript);
    api.scripts().then(setLibrary, () => setLibrary([]));
    const unix = sel.length > 0 && sel.every((a) => a.os !== 'windows');
    setDeployDir(unix ? '/tmp' : 'C:\\Users\\Public\\Downloads');
    setOverwrite(true);
    setAfter('none');
    setPkgId(initialPackage?.id ?? null);
    setUploading(null);
    api.packages().then(setPackages, () => setPackages([]));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // restart komputera, który włączy się za dwa dni, rzadko ma sens — domyślnie tylko online
  useEffect(() => {
    if (!waitTouched) setWaitHours(kind === 'power' ? 0 : 24);
  }, [kind, waitTouched]);

  const uploadFile = async (file: File) => {
    const sel = agents.filter((a) => ids.includes(a.id));
    const clientIds = [...new Set(sel.map((a) => a.clientId))];
    const ac = new AbortController();
    uploadAbort.current = ac;
    setUploading({ name: file.name, sent: 0, size: file.size });
    try {
      // plik wybranego klienta trafia do jego plików; przy komputerach kilku klientów — wspólny
      const p = await api.uploadPackage(file, clientIds.length === 1 ? clientIds[0] : null, (sent) => setUploading({ name: file.name, sent, size: file.size }), ac.signal);
      setPackages((list) => [p, ...(list ?? [])]);
      setPkgId(p.id);
      toast('Wysłano plik');
    } catch (e) {
      if (!ac.signal.aborted) toast(errorMessage(e), 'err');
    } finally {
      setUploading(null);
      uploadAbort.current = null;
    }
  };
  // zamknięcie okna przerywa wysyłanie
  useEffect(() => {
    if (!open) uploadAbort.current?.abort();
  }, [open]);

  const selected = useMemo(() => agents.filter((a) => ids.includes(a.id)), [agents, ids]);
  const onlineCount = selected.filter((a) => a.online).length;
  const family = SHELLS.find((s) => s.id === shell)!.family;
  const mismatched = kind === 'script' ? selected.filter((a) => (a.os === 'windows') !== (family === 'windows')).length : 0;
  const n = selected.length;
  const comp = (k: number) => `${k} ${plural(k, 'komputer', 'komputery', 'komputerów')}`;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (n === 0) return setError('Wybierz co najmniej jeden komputer.');
    let body: JobInput;
    if (kind === 'script') {
      if (!script.trim()) return setError('Wpisz treść skryptu.');
      body = { kind, agentIds: ids, waitHours, params: { shell, script, timeoutSec, asUser } };
    } else if (kind === 'message') {
      if (!msgText.trim()) return setError('Wpisz treść komunikatu.');
      body = { kind, agentIds: ids, waitHours, params: { text: msgText, title: msgTitle, seconds: msgSeconds } };
    } else if (kind === 'power') {
      body = { kind, agentIds: ids, waitHours, params: { action: powerAction, delayMinutes: delay, message: powerMsg } };
    } else if (kind === 'deploy') {
      if (!pkgId) return setError('Wybierz albo wyślij plik.');
      if (!deployDir.trim()) return setError('Podaj folder docelowy.');
      const run = after !== 'none';
      if (run && !script.trim()) return setError('Wpisz polecenie instalacji albo wybierz „tylko skopiuj”.');
      body = {
        kind,
        agentIds: ids,
        waitHours,
        params: { packageId: pkgId, dir: deployDir.trim(), overwrite, shell, script: run ? script : '', asUser, timeoutSec: Math.max(timeoutSec, 60) },
      };
    } else {
      body = { kind, agentIds: ids, waitHours };
    }
    setBusy(true);
    setError('');
    try {
      const r = await api.createJob(body);
      onClose();
      location.hash = `/jobs/${r.id}`;
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submitLabel =
    kind === 'script'
      ? `Uruchom na: ${comp(n)}`
      : kind === 'message'
        ? `Wyślij na: ${comp(n)}`
        : kind === 'power'
          ? `${powerAction === 'reboot' ? 'Uruchom ponownie' : 'Wyłącz'}: ${comp(n)}`
          : kind === 'deploy'
            ? `Wdróż na: ${comp(n)}`
            : `Odśwież: ${comp(n)}`;

  return (
    <Modal open={open} onClose={onClose} wide>
      <form onSubmit={submit}>
        <h3>Nowe zadanie</h3>
        <div className="seg seg-wrap" role="tablist" aria-label="Rodzaj zadania">
          {(Object.keys(KIND_META) as JobKind[]).map((k) => {
            const M = KIND_META[k];
            return (
              <button type="button" key={k} role="tab" aria-selected={kind === k} className={`seg-btn ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>
                <M.icon className="inline-icon" /> {M.label}
              </button>
            );
          })}
        </div>

        {kind === 'script' && (
          <>
            {library && library.length > 0 && (
              <Field label="Z biblioteki">
                <select
                  className="pole"
                  value=""
                  onChange={(e) => {
                    const sc = library.find((x) => x.id === Number(e.target.value));
                    if (sc) loadScript(sc);
                  }}
                >
                  <option value="">Wczytaj zapisany skrypt…</option>
                  {library.map((sc) => (
                    <option key={sc.id} value={sc.id}>
                      {sc.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <div className="form-2">
              <Field label="Powłoka">
                <select className="pole" value={shell} onChange={(e) => setShell(e.target.value as ScriptShell)}>
                  {SHELLS.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Limit czasu">
                <select className="pole" value={timeoutSec} onChange={(e) => setTimeoutSec(Number(e.target.value))}>
                  {TIMEOUTS.map((s) => (
                    <option key={s} value={s}>
                      {timeoutLabel(s)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Skrypt" hint="Wynik (wyjście i kod zakończenia) z każdego komputera zobaczysz na stronie zadania.">
              <textarea
                className="pole mono script-input"
                value={script}
                onChange={(e) => setScript(e.target.value)}
                rows={8}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                placeholder={family === 'windows' ? 'Get-Process chrome | Stop-Process -Force' : 'uptime'}
              />
            </Field>
            {saveName === null ? (
              <button type="button" className="link-btn" style={{ justifySelf: 'start' }} onClick={() => setSaveName('')} disabled={!script.trim()}>
                <Save className="inline-icon" /> Zapisz w bibliotece
              </button>
            ) : (
              <div className="inline-form">
                <input
                  className="pole"
                  autoFocus
                  placeholder="Nazwa skryptu w bibliotece"
                  value={saveName}
                  maxLength={100}
                  onChange={(e) => setSaveName(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter zapisuje do biblioteki — nie wysyła całego zadania
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void saveToLibrary();
                    }
                  }}
                />
                <Button type="button" size="sm" icon={Save} onClick={() => void saveToLibrary()} disabled={!saveName.trim()}>
                  Zapisz
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setSaveName(null)}>
                  Anuluj
                </Button>
              </div>
            )}
            <label className={`choice ${asUser ? 'on' : ''}`}>
              <input type="checkbox" className="cb" checked={asUser} onChange={(e) => setAsUser(e.target.checked)} />
              <span>
                Jako zalogowany użytkownik
                <small>Z jego uprawnieniami, w jego sesji (np. uruchomienie programu na jego ekranie, ustawienia HKCU). Domyślnie skrypt działa jako usługa z pełnymi uprawnieniami.</small>
              </span>
            </label>
            {mismatched > 0 && (
              <div className="callout callout-warning">
                <TriangleAlert />
                <div>
                  {comp(mismatched)} spośród wybranych {family === 'windows' ? 'nie ma Windows' : 'ma Windows'} — tam ta powłoka nie zadziała. Utwórz osobne zadanie dla
                  tych komputerów.
                </div>
              </div>
            )}
          </>
        )}

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
              <textarea className="pole" value={msgText} onChange={(e) => setMsgText(e.target.value)} rows={3} maxLength={500} placeholder="Np. Przerwa techniczna do 14:00" />
            </Field>
          </>
        )}

        {kind === 'power' && (
          <>
            <div className="form-2">
              <Field label="Akcja">
                <select className="pole" value={powerAction} onChange={(e) => setPowerAction(e.target.value as 'reboot' | 'shutdown')}>
                  <option value="reboot">Restart</option>
                  <option value="shutdown">Wyłączenie</option>
                </select>
              </Field>
              <Field label="Kiedy">
                <select className="pole" value={delay} onChange={(e) => setDelay(Number(e.target.value))}>
                  <option value={0}>Od razu</option>
                  <option value={1}>Za 1 min</option>
                  <option value={5}>Za 5 min</option>
                  <option value={15}>Za 15 min</option>
                  <option value={60}>Za 1 godz.</option>
                </select>
              </Field>
            </div>
            <Field label="Komunikat dla użytkownika" hint="Opcjonalnie — pokaże się przed restartem (Windows).">
              <input className="pole" value={powerMsg} onChange={(e) => setPowerMsg(e.target.value)} maxLength={200} />
            </Field>
          </>
        )}

        {kind === 'deploy' && (
          <>
            <Field label="Plik" group hint="Plik trafia na serwer raz, komputery pobierają go same (także te, które włączą się później).">
              {uploading ? (
                <div className="upload-row">
                  <div className="small ellipsis">
                    Wysyłanie: <strong>{uploading.name}</strong> — {bytes(uploading.sent)} z {bytes(uploading.size)}
                  </div>
                  <div className="jp-track">
                    <span className="jp-seg run" style={{ width: `${(uploading.sent / Math.max(1, uploading.size)) * 100}%` }} />
                  </div>
                  <Button type="button" size="sm" variant="ghost" onClick={() => uploadAbort.current?.abort()}>
                    Anuluj
                  </Button>
                </div>
              ) : (
                <div className="inline-form">
                  <select className="pole" value={pkgId ?? ''} onChange={(e) => setPkgId(e.target.value ? Number(e.target.value) : null)}>
                    <option value="">{packages && packages.some((p) => p.ready) ? 'Wybierz wysłany plik…' : 'Brak plików — wyślij nowy'}</option>
                    {(packages ?? [])
                      .filter((p) => p.ready)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} ({bytes(p.size)})
                        </option>
                      ))}
                  </select>
                  <label className="btn btn-secondary btn-sm">
                    <Upload /> Wyślij plik
                    <input
                      type="file"
                      hidden
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = '';
                        if (f) void uploadFile(f);
                      }}
                    />
                  </label>
                </div>
              )}
            </Field>
            <div className="form-2">
              <Field label="Folder docelowy" hint="Pełna ścieżka; brakujące foldery zostaną utworzone.">
                <input className="pole mono" value={deployDir} onChange={(e) => setDeployDir(e.target.value)} spellCheck={false} autoCapitalize="off" />
              </Field>
              <Field label="Po zapisaniu pliku">
                <select
                  className="pole"
                  value={after}
                  onChange={(e) => {
                    const a = e.target.value as AfterDeploy;
                    setAfter(a);
                    const tpl = AFTER_DEPLOY.find((x) => x.id === a);
                    if (tpl?.script !== undefined) {
                      setScript(tpl.script);
                      setShell(tpl.shell ?? shell);
                    }
                  }}
                >
                  {AFTER_DEPLOY.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {after !== 'none' && (
              <>
                <div className="form-2">
                  <Field label="Powłoka">
                    <select className="pole" value={shell} onChange={(e) => setShell(e.target.value as ScriptShell)}>
                      {SHELLS.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Limit czasu instalacji">
                    <select className="pole" value={timeoutSec} onChange={(e) => setTimeoutSec(Number(e.target.value))}>
                      {TIMEOUTS.map((s) => (
                        <option key={s} value={s}>
                          {timeoutLabel(s)}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <Field label="Polecenie" hint={<>Ścieżka zapisanego pliku jest w zmiennej <code>OVERVNC_FILE</code>. Kod zakończenia inny niż 0 oznacza błąd.</>}>
                  <textarea className="pole mono script-input" value={script} onChange={(e) => setScript(e.target.value)} rows={5} spellCheck={false} autoCapitalize="off" autoCorrect="off" />
                </Field>
                <label className={`choice ${asUser ? 'on' : ''}`}>
                  <input type="checkbox" className="cb" checked={asUser} onChange={(e) => setAsUser(e.target.checked)} />
                  <span>
                    Jako zalogowany użytkownik
                    <small>Domyślnie instalacja działa jako usługa z pełnymi uprawnieniami (bez okna UAC).</small>
                  </span>
                </label>
              </>
            )}
            <label className={`choice ${overwrite ? 'on' : ''}`}>
              <input type="checkbox" className="cb" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
              <span>
                Nadpisz, jeśli plik już istnieje
                <small>Identyczny plik nie jest pobierany drugi raz.</small>
              </span>
            </label>
            <div className="callout callout-warning">
              <TriangleAlert />
              <div className="small">Na kioskach z ochroną przed zapisem (UWF) plik i instalacja znikną po restarcie — wdrażaj w trybie serwisowym albo do folderu wykluczonego z ochrony.</div>
            </div>
          </>
        )}

        {kind === 'inventory' && <p className="small">Komputery zbiorą na nowo dane o systemie, sprzęcie, oprogramowaniu i licencji Windows.</p>}

        <Field label={fixedTargets ? 'Komputery' : `Komputery (zaznaczono ${n})`} group>
          {fixedTargets ? (
            <div className="chips">
              {selected.map((a) => (
                <span key={a.id} className={`target-chip ${a.online ? 'on' : ''}`}>
                  {a.label || a.hostname}
                </span>
              ))}
            </div>
          ) : (
            <TargetPicker agents={agents} ids={ids} onChange={setIds} />
          )}
        </Field>

        <Field label="Komputery offline" hint={n > 0 ? `Teraz online: ${onlineCount} z ${n}.` : undefined}>
          <select
            className="pole"
            value={waitHours}
            onChange={(e) => {
              setWaitTouched(true);
              setWaitHours(Number(e.target.value));
            }}
          >
            {WAITS.map((w) => (
              <option key={w.h} value={w.h}>
                {w.label}
              </option>
            ))}
          </select>
        </Field>

        {error && <div className="form-error">{error}</div>}
        <div className="okno-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            Anuluj
          </Button>
          <Button variant={kind === 'power' ? 'danger' : 'primary'} icon={kind === 'power' ? Power : Play} loading={busy} disabled={n === 0}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Wybór komputerów: wyszukiwanie, klient, „zaznacz widoczne”. */
export function TargetPicker({ agents, ids, onChange }: { agents: Agent[]; ids: string[]; onChange: (ids: string[]) => void }) {
  const { clients } = useOrg();
  const [q, setQ] = useState('');
  const [client, setClient] = useState<number | null>(null);
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return agents
      .filter((a) => client === null || a.clientId === client)
      .filter((a) => !needle || [a.hostname, a.label, a.clientName ?? '', ...a.tags.map((t) => t.name)].some((s) => s.toLowerCase().includes(needle)))
      .sort((a, b) => Number(b.online) - Number(a.online) || (a.label || a.hostname).localeCompare(b.label || b.hostname, 'pl'));
  }, [agents, q, client]);
  const set = new Set(ids);
  const allVisible = visible.length > 0 && visible.every((a) => set.has(a.id));
  const toggleVisible = (v: boolean) => {
    const next = new Set(ids);
    for (const a of visible) v ? next.add(a.id) : next.delete(a.id);
    onChange([...next]);
  };
  return (
    <div className="target-picker">
      <div className="target-filters">
        <div className="search">
          <Search />
          <input className="pole" placeholder="Szukaj: nazwa, klient, tag…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {clients.length > 1 && (
          <select className="pole" value={client ?? ''} onChange={(e) => setClient(e.target.value === '' ? null : Number(e.target.value))} aria-label="Klient">
            <option value="">Wszyscy klienci</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="check-list">
        {visible.length > 0 && (
          <label className="strong">
            <Checkbox checked={allVisible} indeterminate={!allVisible && visible.some((a) => set.has(a.id))} onChange={toggleVisible} /> Zaznacz widoczne ({visible.length})
          </label>
        )}
        {visible.map((a) => (
          <label key={a.id}>
            <Checkbox
              checked={set.has(a.id)}
              onChange={(v) => {
                const next = new Set(ids);
                if (v) next.add(a.id);
                else next.delete(a.id);
                onChange([...next]);
              }}
            />
            <span className={`dot ${a.online ? 'dot-live' : ''}`} style={{ color: a.online ? 'rgb(var(--success))' : 'rgb(var(--faint))' }} />
            <span className="ellipsis" style={{ flex: 1, minWidth: 0 }}>
              {a.label || a.hostname}
            </span>
            {a.clientName && <span className="small muted ellipsis">{a.clientName}</span>}
          </label>
        ))}
        {visible.length === 0 && <span className="muted small" style={{ padding: 8 }}>Brak komputerów.</span>}
      </div>
    </div>
  );
}
