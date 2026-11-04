import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { Maximize2, Minimize2, Plug, RotateCcw, ShieldAlert, TerminalSquare } from 'lucide-react';
import type { Agent } from '../../api.ts';
import { Badge, Button, EmptyState } from '../../components.tsx';

type State = 'connecting' | 'ready' | 'closed';

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

  const supported = agent.online && agent.capabilities.includes('term.open');
  // "NT AUTHORITY\\SYSTEM" -> "SYSTEM"
  const account = agent.runAs.split('\\').pop() ?? '';
  const privileged = account === 'root' || account.toUpperCase() === 'SYSTEM';

  useEffect(() => {
    if (!supported || !host.current) return;
    let disposed = false;
    const term = new Terminal({
      fontFamily: '"JetBrains Mono Variable", ui-monospace, Menlo, Consolas, monospace',
      fontSize: 13.5,
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
        if (ws?.readyState === WebSocket.OPEN) ws.send(enc.encode(d));
      });
    });

    return () => {
      disposed = true;
      ro.disconnect();
      window.clearTimeout(resizeTimer);
      ws?.close();
      term.dispose();
    };
  }, [agent.id, supported, shell, session]);

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
      <div className="term-foot small muted">
        Terminal działa na koncie {account ? <strong>{account}</strong> : 'agenta'}
        {privileged ? ' (pełne uprawnienia administracyjne)' : ''}. Sesja jest zapisywana w dzienniku zdarzeń i zamyka się po 30 min bezczynności.
      </div>
    </div>
  );
}
