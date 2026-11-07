/**
 * Stan zabezpieczeń (ocena faktów zebranych przez agenta) i historia zmian komputera
 * (porównanie kolejnych inwentarzy). Ocena jest tutaj, nie w agencie — zmiana progów nie wymaga
 * aktualizacji komputerów.
 */

export type Severity = 'critical' | 'warning' | 'info';
export const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

export interface SecurityIssue {
  code: string;
  severity: Severity;
  title: string;
  detail?: string;
}

export interface SecuritySummary {
  level: 'ok' | Severity;
  issues: SecurityIssue[];
  checkedAt: number;
}

/** Definicje antywirusa starsze niż tyle dni = ostrzeżenie. */
export const AV_MAX_AGE_DAYS = 7;
/** Brak zainstalowanych poprawek Windows przez tyle dni = informacja. */
export const NO_UPDATES_DAYS = 60;

const DAY = 86_400_000;

/* eslint-disable @typescript-eslint/no-explicit-any */
export function assessSecurity(sec: any, os: string, now = Date.now()): SecuritySummary | null {
  if (!sec || typeof sec !== 'object') return null;
  const issues: SecurityIssue[] = [];
  const add = (code: string, severity: Severity, title: string, detail?: string) => issues.push({ code, severity, title, ...(detail ? { detail } : {}) });
  const mac = os === 'darwin';

  const av = sec.antivirus;
  if (av) {
    const products: { name: string; enabled: boolean; upToDate: boolean }[] = Array.isArray(av.products) ? av.products : [];
    const others = products.filter((p) => p.enabled && !/defender/i.test(p.name ?? ''));
    const defenderOn = !!(av.defender && av.enabled && av.realTime);
    if (!defenderOn && others.length === 0) {
      add('av_off', 'critical', 'Antywirus wyłączony', av.defender ? (av.enabled ? 'Defender: ochrona w czasie rzeczywistym wyłączona' : 'Defender wyłączony') : 'Nie wykryto aktywnego antywirusa');
    } else if (defenderOn && others.length === 0 && typeof av.signatureAgeDays === 'number' && av.signatureAgeDays > AV_MAX_AGE_DAYS) {
      add('av_outdated', 'warning', `Nieaktualne definicje antywirusa (${av.signatureAgeDays} dni)`, 'Defender nie pobrał nowych definicji');
    } else if (others.length > 0 && others.every((p) => !p.upToDate)) {
      add('av_outdated', 'warning', 'Nieaktualne definicje antywirusa', others.map((p) => p.name).join(', '));
    }
  }

  const fw = sec.firewall;
  if (fw && fw.enabled === false) {
    const off = Array.isArray(fw.profiles) ? fw.profiles.filter((p: any) => !p.enabled).map((p: any) => p.name) : [];
    // zapora macOS jest domyślnie wyłączona (system nie nasłuchuje usług) — tylko informacja
    add('firewall_off', mac ? 'info' : 'critical', 'Zapora wyłączona', off.length ? `Profile: ${off.join(', ')}` : undefined);
  }

  if (sec.sip === false) add('sip_off', 'critical', 'Ochrona integralności systemu (SIP) wyłączona');
  if (sec.gatekeeper === false) add('gatekeeper_off', 'warning', 'Gatekeeper wyłączony', 'macOS uruchamia niepodpisane aplikacje bez ostrzeżenia');

  const enc = sec.encryption;
  if (enc && enc.enabled === false && !/niedostępny/.test(enc.status ?? '')) {
    add('encryption_off', 'info', `${enc.name ?? 'Szyfrowanie dysku'} wyłączony`, enc.status);
  }

  const up = sec.updates;
  if (up) {
    if (up.rebootRequired) add('reboot_required', 'warning', 'Wymagany restart po aktualizacjach');
    if (up.security > 0) add('updates_security', 'warning', `${up.security} ${plural(up.security, 'poprawka', 'poprawki', 'poprawek')} bezpieczeństwa do zainstalowania`);
    else if (up.pending > 0) add('updates_pending', 'info', `${up.pending} ${plural(up.pending, 'aktualizacja', 'aktualizacje', 'aktualizacji')} do zainstalowania`);
    if (up.error) add('updates_error', 'info', 'Nie udało się sprawdzić aktualizacji', String(up.error).slice(0, 200));
    if (!mac && up.lastInstalled && now - up.lastInstalled > NO_UPDATES_DAYS * DAY) {
      add('updates_stale', 'info', `Brak zainstalowanych poprawek od ${Math.floor((now - up.lastInstalled) / DAY)} dni`);
    }
  }

  issues.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  return { level: issues[0]?.severity ?? 'ok', issues, checkedAt: Number(sec.checkedAt) || now };
}

function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  const d = n % 10;
  const h = n % 100;
  return d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many;
}

// ---------- historia zmian ----------

export type ChangeKind = 'software' | 'os' | 'hardware' | 'security' | 'system';

export interface Change {
  kind: ChangeKind;
  title: string;
  detail?: string;
}

const GB = 1024 ** 3;
const gb = (b: number) => `${Math.round(b / GB)} GB`;

/** Różnice między poprzednim a nowym inwentarzem. Pierwszy inwentarz (brak poprzedniego) = brak zmian. */
export function diffInventory(prev: any, next: any): Change[] {
  if (!prev || !next) return [];
  const out: Change[] = [];

  const ph = prev.host ?? {};
  const nh = next.host ?? {};
  if (ph.hostname && nh.hostname && ph.hostname !== nh.hostname) out.push({ kind: 'system', title: `Nazwa komputera: ${ph.hostname} → ${nh.hostname}` });
  const osName = (h: any) => [h.platform, h.platformVersion].filter(Boolean).join(' ');
  if (osName(ph) && osName(nh) && osName(ph) !== osName(nh)) out.push({ kind: 'os', title: `System: ${osName(ph)} → ${osName(nh)}` });
  else if (ph.kernelVersion && nh.kernelVersion && ph.kernelVersion !== nh.kernelVersion) {
    out.push({ kind: 'os', title: `Wersja systemu: ${ph.kernelVersion} → ${nh.kernelVersion}` });
  }

  // sprzęt
  const pm = Number(prev.memory?.total) || 0;
  const nm = Number(next.memory?.total) || 0;
  if (pm && nm && Math.round(pm / GB) !== Math.round(nm / GB)) out.push({ kind: 'hardware', title: `Pamięć RAM: ${gb(pm)} → ${gb(nm)}` });
  if (prev.cpu?.model && next.cpu?.model && prev.cpu.model !== next.cpu.model) out.push({ kind: 'hardware', title: 'Procesor', detail: `${prev.cpu.model} → ${next.cpu.model}` });
  const disks = (inv: any) => new Map<string, number>((Array.isArray(inv.disks) ? inv.disks : []).map((d: any) => [String(d.mountpoint), Number(d.total) || 0]));
  const pd = disks(prev);
  const nd = disks(next);
  for (const [mp, total] of nd) {
    const before = pd.get(mp);
    if (before === undefined) out.push({ kind: 'hardware', title: `Nowy dysk: ${mp} (${gb(total)})` });
    else if (Math.round(before / GB) !== Math.round(total / GB)) out.push({ kind: 'hardware', title: `Dysk ${mp}: ${gb(before)} → ${gb(total)}` });
  }
  for (const [mp, total] of pd) if (!nd.has(mp)) out.push({ kind: 'hardware', title: `Odłączony dysk: ${mp} (${gb(total)})` });

  // programy — tylko gdy oba spisy są pełne (błąd odczytu nie może wyglądać jak odinstalowanie wszystkiego)
  const ok = (inv: any) => !inv.softwareError && Array.isArray(inv.software) && inv.software.length > 0;
  if (ok(prev) && ok(next)) {
    const index = (inv: any) => {
      const m = new Map<string, { name: string; versions: string[] }>();
      for (const s of inv.software) {
        const name = String(s.name ?? '').trim();
        if (!name) continue;
        const key = name.toLowerCase();
        const e = m.get(key) ?? { name, versions: [] };
        if (s.version) e.versions.push(String(s.version));
        m.set(key, e);
      }
      for (const e of m.values()) e.versions.sort();
      return m;
    };
    const ps = index(prev);
    const ns = index(next);
    for (const [key, e] of ns) {
      const before = ps.get(key);
      const v = e.versions.join(', ');
      if (!before) out.push({ kind: 'software', title: `Zainstalowano: ${e.name}`, detail: v || undefined });
      else if (before.versions.join(', ') !== v) out.push({ kind: 'software', title: `Zaktualizowano: ${e.name}`, detail: `${before.versions.join(', ') || '?'} → ${v || '?'}` });
    }
    for (const [key, e] of ps) if (!ns.has(key)) out.push({ kind: 'software', title: `Odinstalowano: ${e.name}`, detail: e.versions.join(', ') || undefined });
  }
  return out;
}

/** Zmiany stanu zabezpieczeń: nowe problemy i rozwiązane. */
export function diffSecurity(prev: SecuritySummary | null, next: SecuritySummary | null): Change[] {
  if (!prev || !next) return [];
  const before = new Map(prev.issues.map((i) => [i.code, i]));
  const after = new Map(next.issues.map((i) => [i.code, i]));
  const out: Change[] = [];
  for (const [code, i] of after) {
    // informacje (np. liczba aktualizacji) zmieniają się często — do historii tylko ostrzeżenia i krytyczne
    if (i.severity !== 'info' && !before.has(code)) out.push({ kind: 'security', title: i.title, detail: i.detail });
  }
  for (const [code, i] of before) {
    if (i.severity !== 'info' && !after.has(code)) out.push({ kind: 'security', title: `Rozwiązano: ${i.title}` });
  }
  return out;
}
