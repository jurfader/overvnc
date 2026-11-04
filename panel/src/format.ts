export function bytes(n: number | undefined | null, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

export function rate(bps: number | undefined): string {
  return bps == null ? '—' : `${bytes(bps)}/s`;
}

const rtf = new Intl.RelativeTimeFormat('pl', { numeric: 'auto' });

export function ago(ts: number | null | undefined): string {
  if (!ts) return 'nigdy';
  const s = Math.round((ts - Date.now()) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return 'przed chwilą';
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}

export function dateTime(ts: number | null | undefined): string {
  return ts ? new Date(ts).toLocaleString('pl-PL') : '—';
}

export function duration(seconds: number | undefined): string {
  if (!seconds) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d} d ${h} h` : h > 0 ? `${h} h ${m} min` : `${m} min`;
}

export function osLabel(os: string): string {
  return ({ windows: 'Windows', darwin: 'macOS', linux: 'Linux' } as Record<string, string>)[os] ?? os;
}

/** "darwin 27.0" -> "macOS 27.0", "ubuntu 24.04" -> "Ubuntu 24.04". */
export function platformLabel(os: string, platform: string): string {
  if (!platform) return '';
  if (os === 'darwin') return platform.replace(/^darwin/i, 'macOS');
  return platform.charAt(0).toUpperCase() + platform.slice(1);
}

/** Polska odmiana liczebników: plural(2, 'komputer', 'komputery', 'komputerów') -> 'komputery'. */
export function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  const d = n % 10;
  const h = n % 100;
  return d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many;
}
