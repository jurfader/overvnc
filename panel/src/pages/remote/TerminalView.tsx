import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { Maximize2, Minimize2, Plug, RotateCcw, ShieldAlert, TerminalSquare } from 'lucide-react';
import type { Agent } from '../../api.ts';
import { Badge, Button, EmptyState } from '../../components.tsx';

type State = 'connecting' | 'ready' | 'closed';

/** Klawisze specjalne dla ekranów dotykowych (klawiatura telefonu ich nie ma). */
const EXTRA_KEYS: { label: string; seq: string; ctrlSeq?: string; title?: string }[] = [
  { label: 'Esc', seq: '\x1b' },
  { label: 'Tab', seq: '\t' },
  { label: '↑', seq: '\x1b[A', ctrlSeq: '\x1b[1;5A', title: 'Strzałka w górę (poprzednie polecenie)' },
  { label: '↓', seq: '\x1b[B', ctrlSeq: '\x1b[1;5B', title: 'Strzałka w dół' },
  { label: '←', seq: '\x1b[D', ctrlSeq: '\x1b[1;5D', title: 'Strzałka w lewo' },
  { label: '→', seq: '\x1b[C', ctrlSeq: '\x1b[1;5C', title: 'Strzałka w prawo' },
  { label: 'Home', seq: '\x1b[H' },
  { label: 'End', seq: '\x1b[F' },
  { label: 'PgUp', seq: '\x1b[5~' },
  { label: 'PgDn', seq: '\x1b[6~' },
  { label: '|', seq: '|' },
  { label: '~', seq: '~' },
  { label: '/', seq: '/' },
  { label: '-', seq: '-' },
  { label: ':', seq: ':' },
];

/** Ctrl+znak -> kod sterujący (Ctrl+C = 0x03 itd.). */
function ctrlChar(ch: string): string | null {
  const c = ch.toUpperCase();
  if (c >= 'A' && c <= 'Z') return String.fromCharCode(c.charCodeAt(0) - 64);
  const map: Record<string, string> = { ' ': '\x00', '@': '\x00', '[': '\x1b', '\\': '\x1c', ']': '\x1d', '^': '\x1e', _: '\x1f', '?': '\x7f' };
  return map[ch] ?? null;
}

const SHELL_LABELS: Record<string, string> = { powershell: 'PowerShell', pwsh: 'PowerShell 7', cmd: 'Wiersz polecenia', bash: 'bash', zsh: 'zsh', sh: 'sh' };

/** Kolory xterm zgodne z motywem OVERVNC (ciemny terminal także w jasnym motywie — tak czyta się go najlepiej). */
const THEME = {
  background: '#0b0b12',
  foreground: '#e6e6f0',
  cursor: '#e91e8c',
  cursorAccent: '#0b0b12',
  selectionBackground: 'rgba(233, 30, 140, 0.35)',
  black: '#1b1b26',
  red: '#ff5c7a',
  green: '#3ddc84',
  yellow: '#f5b83d',
  blue: '#5b9cff',
  magenta: '#e91e8c',
  cyan: '#38d6e6',
  white: '#d8d8e6',
  brightBlack: '#5c5c75',
  brightRed: '#ff7f96',
  brightGreen: '#6ff0a5',
  brightYellow: '#ffd36b',
  brightBlue: '#8bb8ff',
  brightMagenta: '#c43bbf',
  brightCyan: '#7ae8f2',
  brightWhite: '#ffffff',
};

export function TerminalView({ agent }: { agent: Agent }) {
  const host = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [shell, setShell] = useState(agent.shells[0] ?? '');
  const [state, setState] = useState<State>('connecting');
  const [session, setSession] = useState(0); // zmiana = nowa sesja
  const [fullscreen, setFullscreen] = useState(false);
  const [activeShell, setActiveShell] = useState('');
  // modyfikatory „przyklejane” z paska klawiszy — działają na następny wpisany znak
  const [mods, setMods] = useState({ ctrl: false, alt: false });
  const modsRef = useRef(mods);
  modsRef.current = mods;
  const sendRef = useRef<(data: string) => void>(() => {});
  const termRef = useRef<Terminal | null>(null);

  const supported = agent.online && agent.capabilities.includes('term.open');
  // "NT AUTHORITY\\SYSTEM" -> "SYSTEM"
  const account = agent.runAs.split('\\').pop() ?? '';
  const privileged = account === 'root' || account.toUpperCase() === 'SYSTEM';

  useEffect(() => {
    if (!supported || !host.current) return;
    let disposed = false;
    const term = new Terminal({
      fontFamily: '"JetBrains Mono Variable", ui-monospace, Menlo, Consolas, monospace',
      fontSize: window.innerWidth < 720 ? 12 : 13.5,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 10_000,
      allowProposedApi: true,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    const enc = new TextEncoder();
    let ws: WebSocket | null = null;
    termRef.current = term;
    sendRef.current = (d: string) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(enc.encode(d));
    };
    let resizeTimer: number | undefined;
    let wasReady = false;
    let gotReason = false;

    const sendSize = () => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* kontener ukryty */
      }
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(sendSize, 120);
    });

    // font musi być załadowany przed pomiarem znaków, inaczej siatka terminala się rozjedzie
    void document.fonts.load('13.5px "JetBrains Mono Variable"').finally(() => {
      if (disposed || !host.current) return;
      term.open(host.current);
      fit.fit();
      term.focus();
      ro.observe(host.current);
      setState('connecting');
      term.writeln('\x1b[38;5;245mŁączenie z komputerem…\x1b[0m');

      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const params = new URLSearchParams({ cols: String(term.cols), rows: String(term.rows) });
      if (shell) params.set('shell', shell);
      ws = new WebSocket(`${proto}://${location.host}/ws/term/${agent.id}?${params}`);
      ws.binaryType = 'arraybuffer';
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') {
          term.write(new Uint8Array(ev.data as ArrayBuffer));
          return;
        }
        const msg = JSON.parse(ev.data) as { type: string; shell?: string; message?: string };
        if (msg.type === 'ready') {
          wasReady = true;
          setState('ready');
          setActiveShell(msg.shell ?? '');
          term.write('\x1b[2K\r');
        } else if (msg.type === 'closed') {
          gotReason = true;
          term.writeln(`\r\n\x1b[38;5;245m— ${msg.message ?? 'Sesja zakończona.'}\x1b[0m`);
        }
      };
      ws.onclose = (ev) => {
        setState('closed');
        if (disposed) return;
        if (!wasReady && !gotReason) term.writeln('\r\n\x1b[31mNie udało się połączyć z terminalem (komputer offline lub brak uprawnień).\x1b[0m');
        else if (!gotReason) term.writeln('\r\n\x1b[38;5;245m— Połączenie przerwane.\x1b[0m');
      };
      term.onData((d) => {
        const m = modsRef.current;
        if ((m.ctrl || m.alt) && d.length === 1) {
          let out = d;
          if (m.ctrl) out = ctrlChar(d) ?? d;
          if (m.alt) out = '\x1b' + out;
          setMods({ ctrl: false, alt: false });
          d = out;
        }
        if (ws?.readyState === WebSocket.OPEN) ws.send(enc.encode(d));
      });
    });

    return () => {
      disposed = true;
      ro.disconnect();
      window.clearTimeout(resizeTimer);
      ws?.close();
      termRef.current = null;
      sendRef.current = () => {};
      term.dispose();
    };
  }, [agent.id, supported, shell, session]);

  // telefon: widok od razu na całym ekranie (nagłówek strony i zakładki zostają powyżej)
  useEffect(() => {
    if (window.matchMedia('(max-width: 720px)').matches) wrap.current?.scrollIntoView({ block: 'start' });
  }, []);

  // pełny ekran: Esc wychodzi (xterm przechwytuje Esc, więc tylko gdy terminal nie ma fokusu — dlatego też przycisk)
  const toggleFullscreen = useCallback(() => setFullscreen((f) => !f), []);

  if (!agent.online) return <EmptyState icon={Plug} title="Komputer jest offline" text="Terminal jest dostępny, gdy komputer jest włączony i połączony z serwerem." />;
  if (!supported) return <EmptyState icon={TerminalSquare} title="Niedostępne" text="Ta wersja agenta nie obsługuje terminala — zaktualizuj agenta na komputerze." />;

  return (
    <div ref={wrap} className={`term-wrap glass-card anim-rise ${fullscreen ? 'fullscreen' : ''}`}>
      <div className="term-bar">
        <div className="term-status">
          <span className={`dot ${state === 'ready' ? 'dot-live' : ''}`} style={{ color: state === 'ready' ? 'rgb(var(--success))' : state === 'closed' ? 'rgb(var(--faint))' : 'rgb(var(--warning))' }} />
          <span className="small">{state === 'ready' ? `Połączono · ${SHELL_LABELS[activeShell] ?? activeShell}` : state === 'connecting' ? 'Łączenie…' : 'Sesja zakończona'}</span>
        </div>
        {account && (
          <Badge variant={privileged ? 'warning' : 'neutral'}>
            <ShieldAlert /> {account}
          </Badge>
        )}
        <div className="toolbar" style={{ marginLeft: 'auto' }}>
          {agent.shells.length > 1 && (
            <select className="pole" style={{ width: 'auto', height: 30, fontSize: 12.5 }} value={shell} onChange={(e) => setShell(e.target.value)} aria-label="Powłoka">
              {agent.shells.map((s) => (
                <option key={s} value={s}>
                  {SHELL_LABELS[s] ?? s}
                </option>
              ))}
            </select>
          )}
          <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => setSession((n) => n + 1)}>
            Nowa sesja
          </Button>
          <Button size="sm" variant="ghost" icon={fullscreen ? Minimize2 : Maximize2} title={fullscreen ? 'Zamknij pełny ekran' : 'Pełny ekran'} onClick={toggleFullscreen} />
        </div>
      </div>
      <div className="term-host" ref={host} />
      {/* pasek klawiszy specjalnych (telefon/tablet); onPointerDown bez fokusu — klawiatura ekranowa zostaje otwarta */}
      <div className="term-keys" role="toolbar" aria-label="Klawisze specjalne">
        {(['ctrl', 'alt'] as const).map((k) => (
          <button
            key={k}
            type="button"
            className={`term-key mod ${mods[k] ? 'on' : ''}`}
            aria-pressed={mods[k]}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => {
              setMods((m) => ({ ...m, [k]: !m[k] }));
              termRef.current?.focus();
            }}
          >
            {k === 'ctrl' ? 'Ctrl' : 'Alt'}
          </button>
        ))}
        <button
          type="button"
          className="term-key"
          title="Przerwij (Ctrl+C)"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => {
            sendRef.current('\x03');
            termRef.current?.focus();
          }}
        >
          ^C
        </button>
        {EXTRA_KEYS.map((k) => (
          <button
            key={k.label}
            type="button"
            className="term-key"
            title={k.title}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => {
              const m = modsRef.current;
              let seq = m.ctrl && k.ctrlSeq ? k.ctrlSeq : m.ctrl && k.seq.length === 1 ? (ctrlChar(k.seq) ?? k.seq) : k.seq;
              if (m.alt) seq = '\x1b' + seq;
              if (m.ctrl || m.alt) setMods({ ctrl: false, alt: false });
              sendRef.current(seq);
              termRef.current?.focus();
            }}
          >
            {k.label}
          </button>
        ))}
      </div>
      <div className="term-foot small muted">
        Terminal działa na koncie {account ? <strong>{account}</strong> : 'agenta'}
        {privileged ? ' (pełne uprawnienia administracyjne)' : ''}. Sesja jest zapisywana w dzienniku zdarzeń i zamyka się po 30 min bezczynności.
      </div>
    </div>
  );
}
