import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Laptop, Monitor, Server, type LucideIcon } from 'lucide-react';
import { osLabel } from './format.ts';

// ---------- przycisk ----------

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
  size?: 'sm' | 'md';
  icon?: LucideIcon;
  loading?: boolean;
};

export function Button({ variant = 'secondary', size = 'md', icon: Icon, loading, children, className = '', disabled, ...rest }: ButtonProps) {
  const iconOnly = !children;
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={`btn btn-${variant} ${size === 'sm' ? 'btn-sm' : ''} ${iconOnly ? 'btn-icon' : ''} ${className}`}
    >
      {loading ? <span className="spinner" /> : Icon && <Icon />}
      {children}
    </button>
  );
}

// ---------- odznaki / status ----------

export function Badge({ variant = 'neutral', children }: { variant?: 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'brand'; children: ReactNode }) {
  return <span className={`badge badge-${variant}`}>{children}</span>;
}

export function Status({ online }: { online: boolean }) {
  return online ? (
    <Badge variant="success">
      <span className="dot dot-live" /> Online
    </Badge>
  ) : (
    <Badge>
      <span className="dot" /> Offline
    </Badge>
  );
}

export function osIcon(os: string): LucideIcon {
  return os === 'windows' ? Monitor : os === 'darwin' ? Laptop : Server;
}

export function OsBadge({ os }: { os: string }) {
  return <Badge variant={os === 'windows' ? 'info' : os === 'darwin' ? 'neutral' : 'warning'}>{osLabel(os) || '?'}</Badge>;
}

// ---------- pasek użycia ----------

export function Meter({ value, caption }: { value: number | null | undefined; caption?: string }) {
  if (value == null) return <span className="muted small">—</span>;
  const level = value >= 90 ? 'crit' : value >= 75 ? 'warn' : 'ok';
  return (
    <div className="meter" title={caption}>
      <div className="meter-top">
        <span className="val">{value.toFixed(0)}%</span>
        {caption && <span className="cap">{caption}</span>}
      </div>
      <div className="meter-track">
        <div className={`meter-fill ${level}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </div>
    </div>
  );
}

// ---------- kafelek statystyki / karta ----------

export function StatTile({ icon: Icon, label, value, hint, children, delay = 0 }: { icon: LucideIcon; label: string; value?: ReactNode; hint?: ReactNode; children?: ReactNode; delay?: number }) {
  return (
    <div className="glass-card stat anim-rise" style={{ animationDelay: `${delay}ms` }}>
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        <span className="card-icon">
          <Icon />
        </span>
      </div>
      {value !== undefined && <div className="stat-value">{value}</div>}
      {children}
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function CardHead({ icon: Icon, title, children }: { icon?: LucideIcon; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="card-head">
      <h3>
        {Icon && (
          <span className="card-icon">
            <Icon />
          </span>
        )}
        {title}
      </h3>
      {children}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, text, children }: { icon: LucideIcon; title: string; text?: string; children?: ReactNode }) {
  return (
    <div className="glass-card empty anim-rise">
      <div className="empty-icon">
        <Icon />
      </div>
      <h3>{title}</h3>
      {text && <p>{text}</p>}
      {children}
    </div>
  );
}

// ---------- okno modalne ----------

export function Modal({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="okno-tlo anim-fade" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="okno anim-pop" role="dialog" aria-modal="true">
        {children}
      </div>
    </div>
  );
}

// ---------- powiadomienia (toasty) ----------

interface ToastMsg {
  id: number;
  text: string;
  kind: 'ok' | 'err';
}

export function toast(text: string, kind: 'ok' | 'err' = 'ok'): void {
  window.dispatchEvent(new CustomEvent('overvnc:toast', { detail: { text, kind } }));
}

export function Toasts() {
  const [items, setItems] = useState<ToastMsg[]>([]);
  useEffect(() => {
    let seq = 0;
    const on = (e: Event) => {
      const { text, kind } = (e as CustomEvent).detail;
      const id = ++seq;
      setItems((xs) => [...xs, { id, text, kind }]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 3500);
    };
    window.addEventListener('overvnc:toast', on);
    return () => window.removeEventListener('overvnc:toast', on);
  }, []);
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind} anim-rise`}>
          {t.kind === 'ok' ? <CheckCircle2 /> : <AlertCircle />}
          {t.text}
        </div>
      ))}
    </div>
  );
}

// ---------- motyw ----------

export type Theme = 'dark' | 'light';
const THEME_KEY = 'overvnc-theme';

export function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* tryb prywatny itp. */
  }
}
