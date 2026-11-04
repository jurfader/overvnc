import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, CloudDownload, GitBranch, Package, RefreshCw, Rocket, ShieldCheck } from 'lucide-react';
import { api, errorMessage, type UpdatesStatus } from '../api.ts';
import { Badge, Button, CardHead, StatTile, toast } from '../components.tsx';
import { ago, dateTime, plural } from '../format.ts';

export function Updates() {
  const [st, setSt] = useState<UpdatesStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => api.updates().then(setSt, (e) => toast(errorMessage(e), 'err')), []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    try {
      toast(await fn());
      await load();
    } catch (e) {
      toast(errorMessage(e), 'err');
    } finally {
      setBusy(null);
    }
  };

  if (!st) return <div className="center-page">Ładowanie…</div>;
  const total = st.agents.reduce((n, a) => n + a.count, 0);
  const upToDate = st.target ? st.agents.filter((a) => a.version === st.target).reduce((n, a) => n + a.count, 0) : 0;

  return (
    <>
      <header className="page-head anim-rise">
        <div>
          <h1>Aktualizacje</h1>
          <div className="sub">Wersje agenta OVERVNC na komputerach i wdrażanie nowych wydań</div>
        </div>
        <div className="toolbar">
          <Button
            icon={RefreshCw}
            loading={busy === 'check'}
            disabled={!st.source.configured}
            onClick={() =>
              run('check', async () => {
                const r = await api.updatesCheck();
                return r.added ? `Pobrano wydanie ${r.added}${r.queued ? ` — wysyłanie do ${r.queued} ${plural(r.queued, 'komputera', 'komputerów', 'komputerów')}` : ''}` : 'Brak nowych wydań';
              })
            }
          >
            Sprawdź teraz
          </Button>
          {st.outdated > 0 && st.target && (
            <Button
              variant="primary"
              icon={Rocket}
              loading={busy === 'rollout'}
              onClick={() =>
                run('rollout', async () => {
                  const r = await api.updatesRollout();
                  return r.queued ? `Aktualizacja wysłana do ${r.queued} ${plural(r.queued, 'komputera', 'komputerów', 'komputerów')} (wyłączone zaktualizują się po włączeniu)` : 'Wszystkie włączone komputery są aktualne';
                })
              }
            >
              Wdróż {st.target} teraz
            </Button>
          )}
        </div>
      </header>

      <section className="grid grid-stats">
        <StatTile icon={Package} label="Wersja docelowa" value={st.target ?? '—'} hint={st.policy === 'auto' ? 'najnowsze wydanie (automatycznie)' : 'zatwierdzona ręcznie'} />
        <StatTile icon={CheckCircle2} label="Aktualne komputery" value={`${upToDate} / ${total}`} hint={st.outdated ? `${st.outdated} do aktualizacji` : 'wszystkie aktualne'} delay={40} />
        <StatTile icon={CloudDownload} label="Najnowsze wydanie" value={st.latest ?? '—'} hint={st.source.repo ?? 'źródło nieskonfigurowane'} delay={80} />
        <StatTile icon={ShieldCheck} label="Podpis wydań" value={<span className="stat-value md">Ed25519</span>} hint="agent przyjmuje tylko podpisane binarki" delay={120} />
      </section>

      <section className="grid grid-2 anim-rise" style={{ animationDelay: '140ms' }}>
        <div className="glass-card card">
          <CardHead icon={Rocket} title="Sposób wdrażania" />
          <div className="choice-list">
            {(['auto', 'manual'] as const).map((p) => (
              <label key={p} className={`choice ${st.policy === p ? 'on' : ''}`}>
                <input
                  type="radio"
                  name="policy"
                  checked={st.policy === p}
                  disabled={busy !== null}
                  onChange={() => run('policy', async () => (await api.updatesPolicy(p), p === 'auto' ? 'Aktualizacje automatyczne' : 'Aktualizacje ręczne'))}
                />
                <span>
                  {p === 'auto' ? 'Automatycznie' : 'Ręcznie'}
                  <small>
                    {p === 'auto'
                      ? 'Nowe wydanie z GitHuba trafia na komputery samo (rozłożone w czasie; wyłączone — po włączeniu).'
                      : 'Nowe wydanie czeka, aż je zatwierdzisz poniżej — dobre, gdy chcesz najpierw sprawdzić je na jednym komputerze.'}
                  </small>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="glass-card card">
          <CardHead icon={GitBranch} title="Źródło wydań" />
          {st.source.configured ? (
            <dl className="props">
              <dt>Repozytorium</dt>
              <dd className="mono">{st.source.repo}</dd>
              <dt>Ostatnie sprawdzenie</dt>
              <dd>{st.source.lastCheck ? ago(st.source.lastCheck) : 'jeszcze nie sprawdzano'}</dd>
              <dt>Stan</dt>
              <dd>{st.source.lastError ? <span style={{ color: 'rgb(var(--danger))' }}>{st.source.lastError}</span> : <Badge variant="success">OK — sprawdzane co 15 min</Badge>}</dd>
            </dl>
          ) : (
            <div className="callout callout-warning">
              Serwer nie ma skonfigurowanego GitHuba (zmienne GITHUB_REPO i GITHUB_TOKEN). Wydania można importować ręcznie: npm run cli -- import-release &lt;katalog&gt;.
            </div>
          )}
        </div>
      </section>

      <section className="grid grid-2 anim-rise" style={{ animationDelay: '180ms' }}>
        <div className="glass-card table-card">
          <div className="card" style={{ paddingBottom: 0 }}>
            <CardHead icon={Package} title="Wydania na serwerze" />
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Wersja</th>
                <th>Opublikowano</th>
                <th>Platformy</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {st.releases.map((r) => (
                <tr key={r.version}>
                  <td className="strong">
                    {r.version} {r.version === st.target && <Badge variant="brand">docelowa</Badge>}
                  </td>
                  <td className="small ink-2">{r.created ? dateTime(Date.parse(r.created)) : '—'}</td>
                  <td className="small ink-2">{r.platforms.length}</td>
                  <td className="right">
                    {st.policy === 'manual' && r.version !== st.target && (
                      <Button
                        size="sm"
                        loading={busy === r.version}
                        onClick={() => run(r.version, async () => `Zatwierdzono ${r.version} — wysłano do ${(await api.updatesApprove(r.version)).queued} komputerów`)}
                      >
                        Zatwierdź
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {st.releases.length === 0 && (
                <tr>
                  <td colSpan={4} className="center-text">
                    Brak wydań na serwerze.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="glass-card table-card">
          <div className="card" style={{ paddingBottom: 0 }}>
            <CardHead icon={CheckCircle2} title="Wersje na komputerach" />
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Wersja agenta</th>
                <th className="right">Komputery</th>
                <th className="right">Online</th>
              </tr>
            </thead>
            <tbody>
              {st.agents.map((a) => (
                <tr key={a.version}>
                  <td className="mono">
                    {a.version} {a.version === st.target && <Badge variant="success">aktualna</Badge>}
                  </td>
                  <td className="right">{a.count}</td>
                  <td className="right ink-2">{a.online}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
