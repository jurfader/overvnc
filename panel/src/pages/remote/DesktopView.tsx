import { useCallback, useEffect, useRef, useState } from 'react';
import { Eye, Lock, Maximize2, Minimize2, MonitorSmartphone, MousePointer2, Plug, RotateCcw, ShieldAlert } from 'lucide-react';
import type { Agent } from '../../api.ts';
import { Badge, Button, EmptyState } from '../../components.tsx';
import { bytes } from '../../format.ts';

type Quality = 'low' | 'medium' | 'high';
type State = 'connecting' | 'consent' | 'ready' | 'closed';

interface MonitorInfo {
  index: number;
  w: number;
  h: number;
  primary?: boolean;
  name?: string;
}
interface DesktopInfo {
  monitors: MonitorInfo[];
  current: number;
  desktop?: string;
}

const QUALITY_LABELS: Record<Quality, string> = { low: 'Niska (szybka)', medium: 'Średnia', high: 'Wysoka' };

/** Klatka: seq u32, szer u16, wys u16, n u16, potem kafelki: x,y,w,h (u16), długość u32, JPEG. */
function parseFrame(buf: ArrayBuffer) {
  const v = new DataView(buf, 1); // pomijamy bajt typu 'F'
  const w = v.getUint16(4);
  const h = v.getUint16(6);
  const n = v.getUint16(8);
  let off = 10;
  const tiles: { x: number; y: number; blob: Blob }[] = [];
  for (let i = 0; i < n; i++) {
    const x = v.getUint16(off);
    const y = v.getUint16(off + 2);
    const len = v.getUint32(off + 8);
    const start = 1 + off + 12;
    tiles.push({ x, y, blob: new Blob([buf.slice(start, start + len)], { type: 'image/jpeg' }) });
    off += 12 + len;
  }
  return { w, h, tiles };
}

export function DesktopView({ agent }: { agent: Agent }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [state, setState] = useState<State>('connecting');
  const [message, setMessage] = useState('');
  const [quality, setQuality] = useState<Quality>('medium');
  const [viewOnly, setViewOnly] = useState(false);
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  const [session, setSession] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [stats, setStats] = useState({ fps: 0, bps: 0 });

  const supported = agent.online && agent.capabilities.includes('desktop.open');
  const send = (ev: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(ev));
  };

  // ---------- połączenie i rysowanie klatek ----------
  useEffect(() => {
    if (!supported) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/desktop/${agent.id}?quality=${quality}&viewOnly=${viewOnly ? 1 : 0}`);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    setState('connecting');
    setMessage('');
    let queue = Promise.resolve();
    let frames = 0;
    let bytesIn = 0;
    const statTimer = window.setInterval(() => {
      setStats({ fps: frames, bps: bytesIn });
      frames = 0;
      bytesIn = 0;
    }, 1000);

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        const m = JSON.parse(ev.data) as { type: string; consent?: string; message?: string };
        if (m.type === 'connecting' && m.consent === 'ask') setState('consent');
        if (m.type === 'ready') setState('ready');
        if (m.type === 'closed') setMessage(m.message ?? '');
        return;
      }
      const buf = ev.data as ArrayBuffer;
      bytesIn += buf.byteLength;
      const kind = String.fromCharCode(new Uint8Array(buf, 0, 1)[0]);
      if (kind === 'I') {
        setInfo(JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 1))));
        return;
      }
      if (kind !== 'F') return;
      // kafelki dekodujemy poza głównym wątkiem, rysujemy po kolei; potwierdzenie dopiero po narysowaniu
      queue = queue.then(async () => {
        const f = parseFrame(buf);
        const c = canvas.current;
        if (!c) return;
        if (c.width !== f.w || c.height !== f.h) {
          c.width = f.w;
          c.height = f.h;
        }
        const ctx = c.getContext('2d');
        const bitmaps = await Promise.all(f.tiles.map((t) => createImageBitmap(t.blob)));
        bitmaps.forEach((bm, i) => {
          ctx?.drawImage(bm, f.tiles[i].x, f.tiles[i].y);
          bm.close();
        });
        frames++;
        if (ws.readyState === WebSocket.OPEN) ws.send('{"t":"ack"}');
      });
    };
    ws.onclose = () => {
      setState('closed');
      wsRef.current = null;
    };
    return () => {
      window.clearInterval(statTimer);
      ws.close();
    };
    // jakość i monitor zmieniamy w locie (cfg); nowe połączenie tylko przy zmianie trybu podglądu / „Połącz ponownie”
  }, [agent.id, supported, viewOnly, session]);

  // ---------- mysz i klawiatura ----------
  const pressedKeys = useRef(new Set<string>());
  const pressedButtons = useRef(new Set<number>());
  const pendingMove = useRef<{ x: number; y: number } | null>(null);

  const pos = (e: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };

  const releaseAll = useCallback(() => {
    for (const code of pressedKeys.current) send({ t: 'k', code, d: false });
    pressedKeys.current.clear();
    for (const b of pressedButtons.current) send({ t: 'b', x: 0.5, y: 0.5, b, d: false });
    pressedButtons.current.clear();
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c || state !== 'ready' || viewOnly) return;
    let raf = 0;
    const flushMove = () => {
      raf = 0;
      if (pendingMove.current) send({ t: 'm', ...pendingMove.current });
      pendingMove.current = null;
    };
    const onMove = (e: PointerEvent) => {
      pendingMove.current = pos(e); // ruch zbierany do jednej wiadomości na klatkę ekranu
      if (!raf) raf = requestAnimationFrame(flushMove);
    };
    const onDown = (e: PointerEvent) => {
      e.preventDefault();
      c.focus();
      c.setPointerCapture(e.pointerId);
      const b = e.button === 1 ? 1 : e.button === 2 ? 2 : 0;
      pressedButtons.current.add(b);
      send({ t: 'b', ...pos(e), b, d: true });
    };
    const onUp = (e: PointerEvent) => {
      const b = e.button === 1 ? 1 : e.button === 2 ? 2 : 0;
      pressedButtons.current.delete(b);
      send({ t: 'b', ...pos(e), b, d: false });
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const lines = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
      if (lines) send({ t: 'w', dy: Math.max(-2400, Math.min(2400, Math.sign(lines) * Math.max(120, Math.round(Math.abs(lines) / 100) * 120))) });
    };
    const onKey = (d: boolean) => (e: KeyboardEvent) => {
      e.preventDefault(); // skróty trafiają do zdalnego komputera, nie do przeglądarki
      if (!e.code) return;
      if (d) pressedKeys.current.add(e.code);
      else pressedKeys.current.delete(e.code);
      send({ t: 'k', code: e.code, d });
    };
    const down = onKey(true);
    const up = onKey(false);
    const noMenu = (e: Event) => e.preventDefault();
    c.addEventListener('pointermove', onMove);
    c.addEventListener('pointerdown', onDown);
    c.addEventListener('pointerup', onUp);
    c.addEventListener('wheel', onWheel, { passive: false });
    c.addEventListener('keydown', down);
    c.addEventListener('keyup', up);
    c.addEventListener('blur', releaseAll);
    c.addEventListener('contextmenu', noMenu);
    return () => {
      cancelAnimationFrame(raf);
      releaseAll();
      c.removeEventListener('pointermove', onMove);
      c.removeEventListener('pointerdown', onDown);
      c.removeEventListener('pointerup', onUp);
      c.removeEventListener('wheel', onWheel);
      c.removeEventListener('keydown', down);
      c.removeEventListener('keyup', up);
      c.removeEventListener('blur', releaseAll);
      c.removeEventListener('contextmenu', noMenu);
    };
  }, [state, viewOnly, releaseAll]);

  // pełny ekran przeglądarki (Esc wychodzi)
  useEffect(() => {
    const on = () => setFullscreen(document.fullscreenElement === wrap.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void wrap.current?.requestFullscreen().then(() => canvas.current?.focus());
  };

  if (!agent.online) return <EmptyState icon={Plug} title="Komputer jest offline" text="Pulpit zdalny jest dostępny, gdy komputer jest włączony." />;
  if (!supported)
    return (
      <EmptyState
        icon={MonitorSmartphone}
        title="Pulpit zdalny niedostępny"
        text={agent.os === 'windows' ? 'Ta wersja agenta nie ma jeszcze pulpitu zdalnego — zaktualizuj agenta (System → Aktualizacje).' : 'Pulpit zdalny jest na razie dostępny dla Windows. macOS i Linux — w kolejnych wersjach.'}
      />
    );

  const secure = info?.desktop && info.desktop.toLowerCase() !== 'default';
  return (
    <div ref={wrap} className={`desktop-wrap glass-card anim-rise ${fullscreen ? 'fullscreen' : ''}`}>
      <div className="term-bar">
        <div className="term-status">
          <span
            className={`dot ${state === 'ready' ? 'dot-live' : ''}`}
            style={{ color: state === 'ready' ? 'rgb(var(--success))' : state === 'closed' ? 'rgb(var(--faint))' : 'rgb(var(--warning))' }}
          />
          <span className="small">
            {state === 'ready' ? (viewOnly ? 'Podgląd' : 'Sterowanie') : state === 'consent' ? 'Czekam na zgodę użytkownika komputera…' : state === 'connecting' ? 'Łączenie…' : 'Sesja zakończona'}
          </span>
        </div>
        {secure && (
          <Badge variant="warning">
            <ShieldAlert /> Ekran blokady / UAC
          </Badge>
        )}
        {state === 'ready' && (
          <span className="small muted mono">
            {stats.fps} kl./s · {bytes(stats.bps)}/s
          </span>
        )}
        <div className="toolbar" style={{ marginLeft: 'auto' }}>
          {info && info.monitors.length > 1 && (
            <select
              className="pole desk-select"
              value={info.current}
              onChange={(e) => send({ t: 'cfg', monitor: Number(e.target.value) })}
              aria-label="Monitor"
            >
              {info.monitors.map((m) => (
                <option key={m.index} value={m.index}>
                  Monitor {m.index + 1} ({m.w}×{m.h}){m.primary ? ' — główny' : ''}
                </option>
              ))}
            </select>
          )}
          <select
            className="pole desk-select"
            value={quality}
            onChange={(e) => {
              const q = e.target.value as Quality;
              setQuality(q);
              send({ t: 'cfg', quality: q });
            }}
            aria-label="Jakość"
          >
            {(Object.keys(QUALITY_LABELS) as Quality[]).map((q) => (
              <option key={q} value={q}>
                {QUALITY_LABELS[q]}
              </option>
            ))}
          </select>
          <Button size="sm" variant={viewOnly ? 'outline' : 'ghost'} icon={viewOnly ? Eye : MousePointer2} onClick={() => setViewOnly((v) => !v)} title="Przełącz podgląd / sterowanie">
            {viewOnly ? 'Podgląd' : 'Sterowanie'}
          </Button>
          <Button size="sm" variant="ghost" icon={RotateCcw} title="Połącz ponownie" onClick={() => setSession((n) => n + 1)} />
          <Button size="sm" variant="ghost" icon={fullscreen ? Minimize2 : Maximize2} title={fullscreen ? 'Zamknij pełny ekran' : 'Pełny ekran'} onClick={toggleFullscreen} />
        </div>
      </div>
      <div className="desktop-stage">
        <canvas ref={canvas} className={`desktop-canvas ${viewOnly ? 'view-only' : ''}`} tabIndex={0} width={1280} height={720} aria-label="Ekran zdalnego komputera" />
        {state !== 'ready' && (
          <div className="desktop-overlay">
            {state === 'closed' ? (
              <>
                <Lock />
                <div>{message || 'Połączenie zakończone.'}</div>
                <Button size="sm" icon={RotateCcw} onClick={() => setSession((n) => n + 1)}>
                  Połącz ponownie
                </Button>
              </>
            ) : (
              <>
                <span className="spinner" style={{ width: 22, height: 22 }} />
                <div>{state === 'consent' ? 'Użytkownik komputera musi zaakceptować połączenie (30 s).' : 'Łączenie z ekranem komputera…'}</div>
              </>
            )}
          </div>
        )}
      </div>
      <div className="term-foot small muted">
        Kliknij obraz, aby sterować klawiaturą (skróty klawiszowe trafiają do zdalnego komputera). Sesja jest zapisywana w dzienniku zdarzeń.
      </div>
    </div>
  );
}
