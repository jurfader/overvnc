import { useEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Copy, Download, Laptop, Monitor, Server, type LucideIcon } from 'lucide-react';
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

export function Modal({ open, onClose, children, wide }: { open: boolean; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="okno-tlo anim-fade" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`okno anim-pop ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
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

// ---------- organizacja: tagi, klienci, kolory ----------

export const PALETTE = ['#E91E8C', '#9B26D9', '#3B82F6', '#06B6D4', '#22C55E', '#F59E0B', '#EF4444', '#64748B'];

export function TagChip({ name, color, onRemove }: { name: string; color: string; onRemove?: () => void }) {
  return (
    <span className="chip" style={{ '--c': color || '#8B8BA0' } as CSSProperties}>
      {name}
      {onRemove && (
        <button type="button" className="chip-x" onClick={onRemove} aria-label={`Usuń ${name}`}>
          ×
        </button>
      )}
    </span>
  );
}

export function ClientLabel({ name, color, site }: { name: string | null; color?: string | null; site?: string | null }) {
  if (!name) return <span className="muted small">bez klienta</span>;
  return (
    <span className="client-label">
      <span className="client-dot" style={{ background: color || 'rgb(var(--faint))' }} />
      <span style={{ minWidth: 0 }}>
        <span className="strong nowrap">{name}</span>
        {site && <span className="muted small client-site">{site}</span>}
      </span>
    </span>
  );
}

export function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="swatches" role="radiogroup" aria-label="Kolor">
      {PALETTE.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value.toLowerCase() === c.toLowerCase()}
          className={`swatch ${value.toLowerCase() === c.toLowerCase() ? 'on' : ''}`}
          style={{ background: c }}
          onClick={() => onChange(c)}
          aria-label={c}
        />
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode }[] }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((it) => (
        <button key={it.value} role="tab" aria-selected={value === it.value} className={`tab ${value === it.value ? 'on' : ''}`} onClick={() => onChange(it.value)}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function Checkbox({ checked, indeterminate, onChange, label }: { checked: boolean; indeterminate?: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <input
      type="checkbox"
      className="cb"
      aria-label={label}
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = !!indeterminate;
      }}
      onChange={(e) => onChange(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

/** Pole formularza z etykietą i podpowiedzią. */
export function Field({ label, hint, children, group }: { label: string; hint?: ReactNode; children: ReactNode; group?: boolean }) {
  // group: grupa przycisków (dni tygodnia, przełączniki) — <label> przekierowałby kliknięcie w podpis na pierwszy przycisk
  if (group)
    return (
      <div className="field" role="group" aria-label={label}>
        {label}
        {children}
        {hint && <span className="field-hint">{hint}</span>}
      </div>
    );
  return (
    <label className="field">
      {label}
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

/** Lista haseł/kodów do skopiowania (hasło tymczasowe, kody zapasowe). */
export function SecretBox({ lines, filename }: { lines: string[]; filename?: string }) {
  const [copied, setCopied] = useState(false);
  const text = lines.join('\n');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast('Nie udało się skopiować — zaznacz ręcznie', 'err');
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([text + '\n'], { type: 'text/plain' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: filename ?? 'overvnc.txt' });
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="secret-box">
      <div className={`secret-lines ${lines.length > 1 ? 'grid-codes' : ''}`}>
        {lines.map((l) => (
          <code key={l}>{l}</code>
        ))}
      </div>
      <div className="secret-actions">
        <Button size="sm" variant={copied ? 'outline' : 'secondary'} icon={copied ? CheckCircle2 : Copy} onClick={copy}>
          {copied ? 'Skopiowano' : 'Kopiuj'}
        </Button>
        {filename && (
          <Button size="sm" variant="secondary" icon={Download} onClick={download}>
            Pobierz
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------- menu rozwijane ----------

/**
 * Zamyka menu po kliknięciu/dotknięciu poza nim i klawiszem Esc. Na telefonie menu jest panelem od dołu,
 * a przyciemnione tło to pseudo-element kontenera — dotknięcie samego kontenera też zamyka menu.
 */
export function useDismiss<T extends HTMLElement>(open: boolean, onClose: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const el = ref.current;
      if (!el || !el.contains(e.target as Node) || e.target === el) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open, onClose]);
  return ref;
}

export interface MenuItem {
  key: string;
  label: ReactNode;
  icon?: LucideIcon;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

/** Przycisk z menu akcji (na telefonie — panel od dołu ekranu). */
export function Dropdown({
  icon,
  label,
  title,
  items,
  variant,
  size,
  className,
}: {
  icon?: LucideIcon;
  label?: ReactNode;
  title?: string;
  items: MenuItem[];
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const close = useRef(() => setOpen(false)).current;
  const ref = useDismiss<HTMLDivElement>(open, close);
  if (items.length === 0) return null;
  return (
    <div className={`dropdown ${className ?? ''}`} ref={ref}>
      <Button icon={icon} variant={variant} size={size} title={title} aria-label={title} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {label}
      </Button>
      {open && (
        <div className="dropdown-menu anim-pop" role="menu">
          {items.map(({ key, label: l, icon: Icon, danger, disabled, onClick }) => (
            <button
              key={key}
              role="menuitem"
              disabled={disabled}
              className={`dropdown-item ${danger ? 'danger' : ''}`}
              onClick={() => {
                setOpen(false);
                onClick();
              }}
            >
              {Icon && <Icon />} {l}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
