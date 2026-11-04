import { useEffect, useMemo, useRef, useState } from 'react';
import { Cpu, HardDrive, MemoryStick, Network, LineChart } from 'lucide-react';
import { api, errorMessage, type Agent, type MetricRange, type MetricSample } from '../../api.ts';
import { EmptyState } from '../../components.tsx';
import { bytes, rate } from '../../format.ts';

const RANGES: { key: MetricRange; label: string; ms: number }[] = [
  { key: '1h', label: '1 godz.', ms: 3600_000 },
  { key: '6h', label: '6 godz.', ms: 6 * 3600_000 },
  { key: '24h', label: '24 godz.', ms: 24 * 3600_000 },
  { key: '7d', label: '7 dni', ms: 7 * 24 * 3600_000 },
];

export function MonitoringView({ agent }: { agent: Agent }) {
  const [range, setRange] = useState<MetricRange>('24h');
  const [samples, setSamples] = useState<MetricSample[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const span = RANGES.find((r) => r.key === range)!.ms;

  // historia z serwera przy wejściu, zmianie zakresu i komputera
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api.metricsHistory(agent.id, range).then(
      (d) => alive && (setSamples(d.samples), setLoading(false)),
      (err) => alive && (setError(errorMessage(err)), setLoading(false)),
    );
    return () => {
      alive = false;
    };
  }, [agent.id, range]);

  // żywa krawędź wykresu: każda nowa próbka metryk z WebSocketu dokładana lokalnie (serwer zapisuje rzadziej)
  const m = agent.online ? agent.metrics : null;
  useEffect(() => {
    if (!m) return;
    setSamples((prev) => {
      const last = prev[prev.length - 1];
      if (last && m.ts <= last.ts) return prev;
      const disk = (m.disks ?? []).reduce((mx, d) => Math.max(mx, d.usedPercent), 0);
      const next = [...prev, { ts: m.ts, cpu: m.cpuPercent, mem: m.memPercent, memUsed: m.memUsed, disk, rx: m.netRxBps, tx: m.netTxBps }];
      const cutoff = Date.now() - span;
      return next.filter((s) => s.ts >= cutoff);
    });
  }, [m?.ts, span]);

  const t1 = Date.now();
  const t0 = t1 - span;
  const view = useMemo(() => samples.filter((s) => s.ts >= t0), [samples, t0]);

  const hasData = view.length > 0;

  return (
    <section className="mon anim-rise">
      <div className="mon-bar">
        <div className="mon-title">
          <LineChart size={16} /> Obciążenie w czasie
        </div>
        <div className="seg" role="tablist" aria-label="Zakres czasu">
          {RANGES.map((r) => (
            <button key={r.key} role="tab" aria-selected={range === r.key} className={`seg-btn ${range === r.key ? 'on' : ''}`} onClick={() => setRange(r.key)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {hasData && view[0].ts - t0 > span * 0.1 && (
        <div className="mon-note">
          Historia jest zbierana od {new Date(view[0].ts).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} — wcześniejszych danych nie ma
          {range !== '1h' ? ', krótszy zakres pokaże więcej szczegółów' : ''}.
        </div>
      )}

      {error ? (
        <EmptyState icon={LineChart} title="Nie udało się wczytać historii" text={error} />
      ) : loading && !hasData ? (
        <div className="center-page">Ładowanie…</div>
      ) : !hasData ? (
        <EmptyState
          icon={LineChart}
          title="Brak danych do wykresu"
          text={agent.online ? 'Historia zbiera się na bieżąco — pierwsze punkty pojawią się w ciągu kilku minut.' : 'Komputer jest offline. Wykres pokaże zebraną wcześniej historię, gdy będzie dostępna.'}
        />
      ) : (
        <div className="grid grid-2">
          <Chart title="Procesor" icon={Cpu} t0={t0} t1={t1} percent series={[{ data: view, value: (s) => s.cpu, color: 'rgb(var(--info))' }]} nowText={m ? `${m.cpuPercent.toFixed(0)}%` : undefined} fmt={(v) => `${v.toFixed(0)}%`} />
          <Chart
            title="Pamięć"
            icon={MemoryStick}
            t0={t0}
            t1={t1}
            percent
            series={[{ data: view, value: (s) => s.mem, color: 'rgb(var(--secondary))' }]}
            nowText={m ? `${m.memPercent.toFixed(0)}% · ${bytes(m.memUsed)}` : undefined}
            fmt={(v) => `${v.toFixed(0)}%`}
          />
          <Chart title="Dysk (najbardziej zapełniony)" icon={HardDrive} t0={t0} t1={t1} percent series={[{ data: view, value: (s) => s.disk, color: 'rgb(var(--warning))' }]} nowText={hasData ? `${view[view.length - 1].disk.toFixed(0)}%` : undefined} fmt={(v) => `${v.toFixed(0)}%`} />
          <Chart
            title="Sieć"
            icon={Network}
            t0={t0}
            t1={t1}
            series={[
              { data: view, value: (s) => s.rx, color: 'rgb(var(--success))', label: '↓ pobieranie' },
              { data: view, value: (s) => s.tx, color: 'rgb(var(--primary))', label: '↑ wysyłanie' },
            ]}
            nowText={m ? `↓ ${rate(m.netRxBps)} · ↑ ${rate(m.netTxBps)}` : undefined}
            fmt={(v) => rate(v)}
          />
        </div>
      )}
    </section>
  );
}

interface Series {
  data: MetricSample[];
  value: (s: MetricSample) => number;
  color: string;
  label?: string;
}

const W = 600;
const H = 150;
const PAD = { l: 6, r: 6, t: 12, b: 20 };
const IW = W - PAD.l - PAD.r;
const IH = H - PAD.t - PAD.b;

function Chart({ title, icon: Icon, series, t0, t1, percent = false, fmt, nowText }: { title: string; icon: typeof Cpu; series: Series[]; t0: number; t1: number; percent?: boolean; fmt: (v: number) => string; nowText?: string }) {
  const [hover, setHover] = useState<number | null>(null); // indeks próbki
  const wrapRef = useRef<HTMLDivElement>(null);

  const base = series[0].data;
  const yMax = useMemo(() => {
    if (percent) return 100;
    let mx = 0;
    for (const s of series) for (const p of s.data) mx = Math.max(mx, s.value(p));
    return mx <= 0 ? 1 : mx * 1.15; // zapas nad szczytem
  }, [series, percent]);

  const x = (ts: number) => PAD.l + (IW * (ts - t0)) / Math.max(1, t1 - t0);
  const y = (v: number) => PAD.t + IH * (1 - Math.min(1, Math.max(0, v / yMax)));
  // pozycje w % — punkty rysujemy w HTML, bo SVG z preserveAspectRatio="none" zamienia kółka w elipsy
  const px = (ts: number) => `${(x(ts) / W) * 100}%`;
  const py = (v: number) => `${(y(v) / H) * 100}%`;

  const paths = series.map((s) => {
    const pts = s.data.map((p) => ({ x: x(p.ts), y: y(s.value(p)) }));
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    const area = pts.length ? `M${pts[0].x.toFixed(1)} ${(PAD.t + IH).toFixed(1)} ${pts.map((p) => `L${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')} L${pts[pts.length - 1].x.toFixed(1)} ${(PAD.t + IH).toFixed(1)} Z` : '';
    return { line, area, color: s.color };
  });

  // mysz: najechanie; palec: przeciąganie po wykresie (pionowe przewijanie strony nadal działa)
  const onPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const ts = t0 + frac * (t1 - t0);
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < base.length; i++) {
      const d = Math.abs(base[i].ts - ts);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    setHover(best >= 0 ? best : null);
  };

  const hv = hover != null && base[hover] ? base[hover] : null;
  const last = base.length ? base[base.length - 1] : null;
  const gridY = percent ? [0, 25, 50, 75, 100] : [0, yMax / 2, yMax];
  const hvFrac = hv ? Math.min(1, Math.max(0, (hv.ts - t0) / (t1 - t0))) : 0;
  // podpowiedź przy krawędziach nie może wyjść poza wykres (na telefonie — poza ekran)
  const tipShift = hvFrac < 0.25 ? '0%' : hvFrac > 0.75 ? '-100%' : '-50%';
  const axis = [t0, (t0 + t1) / 2, t1];

  return (
    <div className="glass-card card chart-card">
      <div className="chart-head">
        <div className="chart-title">
          <Icon size={14} /> {title}
        </div>
        {nowText && <div className="chart-now mono">{nowText}</div>}
      </div>
      <div
        ref={wrapRef}
        className="chart-wrap"
        onPointerMove={onPointer}
        onPointerDown={onPointer}
        onPointerLeave={(e) => e.pointerType === 'mouse' && setHover(null)}
        onPointerUp={(e) => e.pointerType !== 'mouse' && setTimeout(() => setHover(null), 1800)}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="chart-svg" role="img" aria-label={title}>
          {gridY.map((g) => (
            <line key={g} x1={PAD.l} x2={W - PAD.r} y1={y(g)} y2={y(g)} className="chart-grid" />
          ))}
          {paths.map((p, i) => (
            <g key={i}>
              {series.length === 1 && <path d={p.area} fill={p.color} opacity={0.12} />}
              <path d={p.line} fill="none" stroke={p.color} strokeWidth={1.75} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
            </g>
          ))}
          {hv && <line x1={x(hv.ts)} x2={x(hv.ts)} y1={PAD.t} y2={PAD.t + IH} className="chart-cross" vectorEffect="non-scaling-stroke" />}
        </svg>
        {/* ostatnia próbka — widoczna nawet wtedy, gdy historia jest jeszcze krótka */}
        {last &&
          !hv &&
          series.map((s, i) => <span key={i} className="chart-point live" style={{ left: px(last.ts), top: py(s.value(last)), background: s.color }} />)}
        {hv && series.map((s, i) => <span key={i} className="chart-point" style={{ left: px(hv.ts), top: py(s.value(hv)), background: s.color }} />)}
        {hv && (
          <div className="chart-tip" style={{ left: `${hvFrac * 100}%`, transform: `translateX(${tipShift})` }}>
            <div className="chart-tip-time">{new Date(hv.ts).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
            {series.map((s, i) => (
              <div key={i} className="chart-tip-row">
                <span className="chart-dot" style={{ background: s.color }} />
                {s.label ? `${s.label}: ` : ''}
                {fmt(s.value(hv))}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="chart-axis" aria-hidden>
        {axis.map((t, i) => (
          <span key={i}>{i === 2 ? 'teraz' : axisLabel(t, t1 - t0)}</span>
        ))}
      </div>
      {series.length > 1 && (
        <div className="chart-legend">
          {series.map((s, i) => (
            <span key={i}>
              <span className="chart-dot" style={{ background: s.color }} /> {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Podpis osi czasu: godzina dla zakresów do doby, data dla dłuższych. */
function axisLabel(ts: number, span: number): string {
  const d = new Date(ts);
  return span > 24 * 3600_000 ? d.toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit' }) : d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
}
