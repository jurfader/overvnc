import { useCallback, useEffect, useRef, useState } from 'react';
import { Eye, Keyboard, Lock, Maximize2, Minimize2, MonitorSmartphone, MousePointer2, Plug, RotateCcw, ShieldAlert, ZoomOut } from 'lucide-react';
import type { Agent } from '../../api.ts';
import { Badge, Button, EmptyState } from '../../components.tsx';
import { bytes } from '../../format.ts';
import { keyForChar } from './keytext.ts';

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

interface Zoom {
  s: number;
  x: number;
  y: number;
}
const NO_ZOOM: Zoom = { s: 1, x: 0, y: 0 };
interface Mods {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}
const NO_MODS: Mods = { ctrl: false, alt: false, shift: false, meta: false };
const MAX_ZOOM = 4;
const LONG_PRESS_MS = 500;
const DRAG_START_PX = 10;
const SCROLL_STEP_PX = 40;
const SENTINEL = '\u00a0\u00a0';

/** Pasek klawiszy dla ekranów dotykowych. */
const DESK_KEYS: { label: string; code?: string; wheel?: number; title?: string }[] = [
  { label: 'Esc', code: 'Escape' },
  { label: 'Tab', code: 'Tab' },
  { label: 'Del', code: 'Delete' },
  { label: '↑', code: 'ArrowUp' },
  { label: '↓', code: 'ArrowDown' },
  { label: '←', code: 'ArrowLeft' },
  { label: '→', code: 'ArrowRight' },
  { label: 'Home', code: 'Home' },
  { label: 'End', code: 'End' },
  { label: 'PgUp', code: 'PageUp' },
  { label: 'PgDn', code: 'PageDown' },
  { label: 'F5', code: 'F5' },
  { label: '⇡ przewiń', wheel: -360, title: 'Przewiń w górę' },
  { label: '⇣ przewiń', wheel: 360, title: 'Przewiń w dół' },
];
const MOD_KEYS: { key: keyof Mods; label: string }[] = [
  { key: 'ctrl', label: 'Ctrl' },
  { key: 'alt', label: 'Alt' },
  { key: 'shift', label: 'Shift' },
  { key: 'meta', label: 'Win' },
];

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
        if (m.type === 'ready') {
          setState('ready');
          // sterowanie myszą: kursor rysuje przeglądarka (bez opóźnienia łącza), agent go nie dorysowuje;
          // podgląd i ekrany dotykowe: kursor z komputera — widać, co robi jego użytkownik
          const localCursor = !viewOnly && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
          ws.send(JSON.stringify({ t: 'cfg', cursor: !localCursor }));
        }
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

  // telefon: widok od razu na całym ekranie (nagłówek strony i zakładki zostają powyżej)
  useEffect(() => {
    if (window.matchMedia('(max-width: 720px)').matches) wrap.current?.scrollIntoView({ block: 'start' });
  }, []);

  // ---------- mysz, dotyk i klawiatura ----------
  const pressedKeys = useRef(new Set<string>());
  const pressedButtons = useRef(new Set<number>());
  const pendingMove = useRef<{ x: number; y: number } | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const keyInput = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const [zoom, setZoom] = useState<Zoom>(NO_ZOOM);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const [mods, setMods] = useState<Mods>(NO_MODS);
  const modsRef = useRef(mods);
  modsRef.current = mods;
  const viewOnlyRef = useRef(viewOnly);
  viewOnlyRef.current = viewOnly;
  const [keyboardOpen, setKeyboardOpen] = useState(false);

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

  /** Pojedyncze naciśnięcie klawisza; modyfikatory z paska (Ctrl/Alt/Shift/Win) działają na jedno naciśnięcie. */
  const tapKey = useCallback((code: string, extra: string[] = []) => {
    if (viewOnlyRef.current) return;
    const m = modsRef.current;
    const held = [...new Set([...(m.ctrl ? ['ControlLeft'] : []), ...(m.alt ? ['AltLeft'] : []), ...(m.shift ? ['ShiftLeft'] : []), ...(m.meta ? ['MetaLeft'] : []), ...extra])];
    for (const h of held) send({ t: 'k', code: h, d: true });
    send({ t: 'k', code, d: true });
    send({ t: 'k', code, d: false });
    for (const h of [...held].reverse()) send({ t: 'k', code: h, d: false });
    if (m.ctrl || m.alt || m.shift || m.meta) setMods(NO_MODS);
  }, []);

  /** Tekst z klawiatury ekranowej -> naciśnięcia klawiszy. */
  const typeText = useCallback(
    (text: string) => {
      for (const ch of text) {
        const k = keyForChar(ch);
        if (k) tapKey(k.code, [...(k.shift ? ['ShiftLeft'] : []), ...(k.altGr ? ['AltRight'] : [])]);
      }
    },
    [tapKey],
  );

  /** Powiększenie mieści się w obszarze ekranu (bez pustych pasów przy krawędziach). */
  const clampZoom = (z: Zoom): Zoom => {
    const st = stage.current;
    if (!st || z.s <= 1.001) return NO_ZOOM;
    const s = Math.min(MAX_ZOOM, z.s);
    return { s, x: Math.min(0, Math.max(st.clientWidth * (1 - s), z.x)), y: Math.min(0, Math.max(st.clientHeight * (1 - s), z.y)) };
  };

  useEffect(() => setZoom(NO_ZOOM), [info?.current, session]);

  useEffect(() => {
    const c = canvas.current;
    const st = stage.current;
    if (!c || !st || state !== 'ready') return;
    let raf = 0;
    const flushMove = () => {
      raf = 0;
      if (pendingMove.current) send({ t: 'm', ...pendingMove.current });
      pendingMove.current = null;
    };
    const queueMove = (p: { x: number; y: number }) => {
      pendingMove.current = p; // ruch zbierany do jednej wiadomości na klatkę ekranu
      if (!raf) raf = requestAnimationFrame(flushMove);
    };
    const click = (p: { x: number; y: number }, b: number) => {
      send({ t: 'm', ...p });
      send({ t: 'b', ...p, b, d: true });
      send({ t: 'b', ...p, b, d: false });
    };

    // --- mysz i pióro: bez zmian względem komputera ---
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch' || viewOnlyRef.current) return;
      queueMove(pos(e));
    };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'touch' || viewOnlyRef.current) return;
      e.preventDefault();
      c.focus();
      c.setPointerCapture(e.pointerId);
      const b = e.button === 1 ? 1 : e.button === 2 ? 2 : 0;
      pressedButtons.current.add(b);
      send({ t: 'b', ...pos(e), b, d: true });
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerType === 'touch' || viewOnlyRef.current) return;
      const b = e.button === 1 ? 1 : e.button === 2 ? 2 : 0;
      pressedButtons.current.delete(b);
      send({ t: 'b', ...pos(e), b, d: false });
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (viewOnlyRef.current) return;
      const lines = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
      if (lines) send({ t: 'w', dy: Math.max(-2400, Math.min(2400, Math.sign(lines) * Math.max(120, Math.round(Math.abs(lines) / 100) * 120))) });
    };
    const onKey = (d: boolean) => (e: KeyboardEvent) => {
      e.preventDefault(); // skróty trafiają do zdalnego komputera, nie do przeglądarki
      if (!e.code || viewOnlyRef.current) return;
      if (d) pressedKeys.current.add(e.code);
      else pressedKeys.current.delete(e.code);
      send({ t: 'k', code: e.code, d });
    };

    // --- dotyk: stuknięcie = klik, przytrzymanie = prawy klik, przeciąganie = przeciąganie myszą,
    //     dwa palce = przewijanie (albo przesuwanie widoku po powiększeniu), rozsunięcie palców = powiększenie ---
    const touches = new Map<number, { x: number; y: number }>();
    let tap: { id: number; sx: number; sy: number; timer: number; dragging: boolean; done: boolean; last: { x: number; y: number } } | null = null;
    let gesture: { mode: 'pending' | 'pinch' | 'pan' | 'scroll'; d0: number; c0: { x: number; y: number }; last: { x: number; y: number }; z0: Zoom; acc: number } | null = null;
    const local = (e: PointerEvent) => {
      const r = st.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const pair = () => {
      const [a, b] = [...touches.values()];
      return { d: Math.hypot(a.x - b.x, a.y - b.y), c: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    };
    const endDrag = (p: { x: number; y: number }) => {
      if (raf) {
        cancelAnimationFrame(raf);
        flushMove();
      }
      send({ t: 'b', ...p, b: 0, d: false });
      pressedButtons.current.delete(0);
    };

    const onTouchDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      e.preventDefault();
      st.setPointerCapture(e.pointerId);
      touches.set(e.pointerId, local(e));
      if (touches.size === 1) {
        const start = { clientX: e.clientX, clientY: e.clientY };
        tap = {
          id: e.pointerId,
          sx: e.clientX,
          sy: e.clientY,
          dragging: false,
          done: false,
          last: pos(start),
          timer: window.setTimeout(() => {
            if (!tap || tap.dragging || touches.size !== 1 || viewOnlyRef.current) return;
            tap.done = true;
            click(pos(start), 2); // przytrzymanie = prawy przycisk
            navigator.vibrate?.(15);
          }, LONG_PRESS_MS),
        };
      } else if (touches.size === 2) {
        // drugi palec przerywa stuknięcie/przeciąganie — zaczyna się gest dwoma palcami
        if (tap) {
          window.clearTimeout(tap.timer);
          if (tap.dragging) endDrag(tap.last);
          tap = null;
        }
        const { d, c: center } = pair();
        gesture = { mode: 'pending', d0: d, c0: center, last: center, z0: zoomRef.current, acc: 0 };
      }
    };
    const onTouchMove = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || !touches.has(e.pointerId)) return;
      e.preventDefault();
      touches.set(e.pointerId, local(e));
      if (touches.size === 1 && tap && tap.id === e.pointerId && !tap.done) {
        if (!tap.dragging && Math.hypot(e.clientX - tap.sx, e.clientY - tap.sy) > DRAG_START_PX) {
          window.clearTimeout(tap.timer);
          if (viewOnlyRef.current) {
            tap.done = true;
            return;
          }
          tap.dragging = true;
          const p0 = pos({ clientX: tap.sx, clientY: tap.sy });
          send({ t: 'm', ...p0 });
          send({ t: 'b', ...p0, b: 0, d: true });
          pressedButtons.current.add(0);
        }
        if (tap.dragging) {
          tap.last = pos(e);
          queueMove(tap.last);
        }
        return;
      }
      if (touches.size !== 2 || !gesture) return;
      const { d, c: center } = pair();
      if (gesture.mode === 'pending') {
        const scaleChange = Math.abs(d - gesture.d0) / Math.max(1, gesture.d0);
        const shift = Math.hypot(center.x - gesture.c0.x, center.y - gesture.c0.y);
        if (scaleChange > 0.08) gesture.mode = 'pinch';
        else if (shift > 12) gesture.mode = zoomRef.current.s > 1.001 ? 'pan' : 'scroll';
        else return;
      }
      if (gesture.mode === 'scroll') {
        // palce w górę = treść w dół (jak przy przewijaniu strony na telefonie)
        gesture.acc += gesture.last.y - center.y;
        gesture.last = center;
        while (Math.abs(gesture.acc) >= SCROLL_STEP_PX) {
          const dir = Math.sign(gesture.acc);
          gesture.acc -= dir * SCROLL_STEP_PX;
          if (!viewOnlyRef.current) send({ t: 'w', dy: dir * 120 });
        }
        return;
      }
      const z0 = gesture.z0;
      const s = gesture.mode === 'pinch' ? Math.min(MAX_ZOOM, Math.max(1, (z0.s * d) / Math.max(1, gesture.d0))) : z0.s;
      // punkt obrazu pod środkiem palców zostaje pod palcami
      const px = (gesture.c0.x - z0.x) / z0.s;
      const py = (gesture.c0.y - z0.y) / z0.s;
      setZoom(clampZoom({ s, x: center.x - px * s, y: center.y - py * s }));
    };
    const onTouchUp = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || !touches.has(e.pointerId)) return;
      touches.delete(e.pointerId);
      if (tap && tap.id === e.pointerId) {
        window.clearTimeout(tap.timer);
        if (tap.dragging) endDrag(pos(e));
        else if (!tap.done && e.type === 'pointerup' && !viewOnlyRef.current) click(pos(e), 0);
        tap = null;
      }
      if (touches.size < 2) gesture = null;
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
    st.addEventListener('contextmenu', noMenu);
    st.addEventListener('pointerdown', onTouchDown);
    st.addEventListener('pointermove', onTouchMove);
    st.addEventListener('pointerup', onTouchUp);
    st.addEventListener('pointercancel', onTouchUp);
    return () => {
      cancelAnimationFrame(raf);
      if (tap) window.clearTimeout(tap.timer);
      releaseAll();
      c.removeEventListener('pointermove', onMove);
      c.removeEventListener('pointerdown', onDown);
      c.removeEventListener('pointerup', onUp);
      c.removeEventListener('wheel', onWheel);
      c.removeEventListener('keydown', down);
      c.removeEventListener('keyup', up);
      c.removeEventListener('blur', releaseAll);
      st.removeEventListener('contextmenu', noMenu);
      st.removeEventListener('pointerdown', onTouchDown);
      st.removeEventListener('pointermove', onTouchMove);
      st.removeEventListener('pointerup', onTouchUp);
      st.removeEventListener('pointercancel', onTouchUp);
    };
  }, [state, releaseAll]);

  // ---------- klawiatura ekranowa (ukryte pole tekstowe) ----------
  // pole zawsze zawiera dwa znaki-wartowniki: skrócenie = Backspace (działa też, gdy „nic nie wpisano”)
  const resetInput = () => {
    const el = keyInput.current;
    if (!el) return;
    el.value = SENTINEL;
    el.setSelectionRange(SENTINEL.length, SENTINEL.length);
  };
  const flushInput = (v: string) => {
    if (v.length < SENTINEL.length) for (let i = 0; i < SENTINEL.length - v.length; i++) tapKey('Backspace');
    else typeText(v.startsWith(SENTINEL) ? v.slice(SENTINEL.length) : v.replaceAll('\u00a0', ''));
    resetInput();
  };
  const openKeyboard = () => {
    resetInput();
    keyInput.current?.focus(); // w obsłudze dotknięcia — inaczej telefon nie pokaże klawiatury
  };

  // pełny ekran przeglądarki (Esc wychodzi)
  useEffect(() => {
    const on = () => setFullscreen(document.fullscreenElement === wrap.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  // iPhone nie obsługuje trybu pełnoekranowego dla elementów strony — wtedy pełny ekran w obrębie strony
  const [cssFull, setCssFull] = useState(false);
  const toggleFullscreen = () => {
    if (cssFull) return setCssFull(false);
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (document.fullscreenEnabled && wrap.current?.requestFullscreen) void wrap.current.requestFullscreen().then(() => canvas.current?.focus(), () => setCssFull(true));
    else setCssFull(true);
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
    <div ref={wrap} className={`desktop-wrap glass-card anim-rise ${fullscreen || cssFull ? 'fullscreen' : ''} ${cssFull ? 'fullscreen-css' : ''}`}>
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
            <span className="btn-label">{viewOnly ? 'Podgląd' : 'Sterowanie'}</span>
          </Button>
          {zoom.s > 1 && <Button size="sm" variant="ghost" icon={ZoomOut} title="Pomniejsz (cały ekran)" onClick={() => setZoom(NO_ZOOM)} />}
          <Button size="sm" variant="ghost" icon={RotateCcw} title="Połącz ponownie" onClick={() => setSession((n) => n + 1)} />
          <Button size="sm" variant="ghost" icon={fullscreen || cssFull ? Minimize2 : Maximize2} title={fullscreen || cssFull ? 'Zamknij pełny ekran' : 'Pełny ekran'} onClick={toggleFullscreen} />
        </div>
      </div>
      <div className="desktop-stage" ref={stage}>
        <div className="desktop-zoom" style={zoom.s > 1 ? { transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})` } : undefined}>
          <canvas ref={canvas} className={`desktop-canvas ${viewOnly ? 'view-only' : ''}`} tabIndex={0} width={1280} height={720} aria-label="Ekran zdalnego komputera" />
        </div>
        {/* klawiatura ekranowa: pole poza widokiem; tekst zamieniany na naciśnięcia klawiszy */}
        <input
          ref={keyInput}
          className="desktop-keyinput"
          aria-label="Klawiatura zdalnego komputera"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="send"
          defaultValue={SENTINEL}
          onFocus={() => setKeyboardOpen(true)}
          onBlur={() => setKeyboardOpen(false)}
          onKeyDown={(e) => {
            if (viewOnly) return;
            // klawiatura fizyczna (np. tablet z klawiaturą Bluetooth): prawdziwe klawisze, także skróty
            if (e.nativeEvent.keyCode !== 229 && e.code && e.key !== 'Unidentified') {
              e.preventDefault();
              if (!pressedKeys.current.has(e.code)) {
                pressedKeys.current.add(e.code);
                send({ t: 'k', code: e.code, d: true });
              }
              return;
            }
            if (e.key === 'Enter') {
              e.preventDefault();
              tapKey('Enter');
            }
          }}
          onKeyUp={(e) => {
            if (pressedKeys.current.has(e.code)) {
              e.preventDefault();
              pressedKeys.current.delete(e.code);
              send({ t: 'k', code: e.code, d: false });
            }
          }}
          onInput={(e) => !composing.current && flushInput(e.currentTarget.value)}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={(e) => {
            composing.current = false;
            flushInput(e.currentTarget.value);
          }}
        />
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
      {state === 'ready' && !viewOnly && (
        <div className="term-keys desk-keys" role="toolbar" aria-label="Klawisze specjalne">
          <button type="button" className={`term-key wide ${keyboardOpen ? 'on' : ''}`} onClick={() => (keyboardOpen ? keyInput.current?.blur() : openKeyboard())}>
            <Keyboard size={15} /> Klawiatura
          </button>
          {MOD_KEYS.map((m) => (
            <button
              key={m.key}
              type="button"
              className={`term-key mod ${mods[m.key] ? 'on' : ''}`}
              aria-pressed={mods[m.key]}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => setMods((cur) => ({ ...cur, [m.key]: !cur[m.key] }))}
            >
              {m.label}
            </button>
          ))}
          {DESK_KEYS.map((k) => (
            <button
              key={k.label}
              type="button"
              className="term-key"
              title={k.title}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => (k.wheel ? send({ t: 'w', dy: k.wheel }) : k.code && tapKey(k.code))}
            >
              {k.label}
            </button>
          ))}
        </div>
      )}
      <div className="term-foot small muted">
        <span className="mouse-only">Kliknij obraz, aby sterować klawiaturą (skróty klawiszowe trafiają do zdalnego komputera). </span>
        <span className="touch-only">Dotknij — klik · przytrzymaj — prawy klik · przeciągnij — przeciąganie · dwa palce — przewijanie · rozsuń palce — powiększenie. </span>
        Sesja jest zapisywana w dzienniku zdarzeń.
      </div>
    </div>
  );
}
