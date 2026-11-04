// ---------- typy danych z API ----------

export interface Metrics {
  ts: number;
  cpuPercent: number;
  memTotal: number;
  memUsed: number;
  memPercent: number;
  swapUsed: number;
  disks: { mountpoint: string; total: number; used: number; usedPercent: number }[] | null;
  uptime: number;
  load?: number[];
  netRxBps: number;
  netTxBps: number;
  processes: number;
  activeUsers?: string[];
}

export interface TagRef {
  id: number;
  name: string;
  color: string;
}

/** Jedna próbka historii metryk (do wykresów). Procenty 0–100, sieć w bajtach/s. */
export interface MetricSample {
  ts: number;
  cpu: number;
  mem: number;
  memUsed: number;
  disk: number;
  rx: number;
  tx: number;
}

export type MetricRange = '1h' | '6h' | '24h' | '7d';

export type AlertKind = 'offline' | 'cpu' | 'mem' | 'disk' | 'license';

export interface AlertItem {
  id: number;
  ruleId: number | null;
  agentId: string;
  hostname: string;
  label: string;
  clientId: number | null;
  clientName: string | null;
  kind: AlertKind;
  title: string;
  /** np. punkt montowania dysku */
  detail: string;
  value: number | null;
  startedAt: number;
  resolvedAt: number | null;
  ackBy: string | null;
  ackAt: number | null;
}

export interface AlertRule {
  id: number;
  name: string;
  kind: AlertKind;
  threshold: number;
  durationMin: number;
  clientId: number | null;
  clientName: string | null;
  enabled: boolean;
  notify: boolean;
}

export type AlertRuleInput = Omit<AlertRule, 'id' | 'clientName'>;

export interface NotificationSettings {
  pushover: { configured: boolean; userHint: string | null };
  panelUrl: string | null;
}


export interface Agent {
  id: string;
  hostname: string;
  label: string;
  os: string;
  platform: string;
  arch: string;
  agentVersion: string;
  lastIp: string | null;
  enrolledAt: number;
  lastSeen: number | null;
  online: boolean;
  connectedAt: number | null;
  metrics: Metrics | null;
  /** polecenia obsługiwane przez połączonego agenta (pusta lista, gdy offline) */
  capabilities: string[];
  /** powłoki dostępne na komputerze (gdy online) */
  shells: string[];
  /** konto, na którym działa agent, np. root lub NT AUTHORITY\\SYSTEM */
  runAs: string;
  clientId: number | null;
  clientName: string | null;
  clientColor: string | null;
  siteId: number | null;
  siteName: string | null;
  tags: TagRef[];
  notes: string;
  /** tylko po stronie panelu: zmienia się, gdy serwer zgłosi nowe dane inwentarza */
  rev?: number;
}

export interface Inventory {
  collectedAt: number;
  host: {
    hostname: string;
    os: string;
    platform: string;
    platformFamily: string;
    platformVersion: string;
    kernelVersion: string;
    arch: string;
    hostId: string;
    bootTime: number;
    virtualization?: string;
  };
  cpu: { model: string; cores: number; threads: number; mhz: number };
  memory: { total: number; swapTotal: number };
  disks: { device: string; mountpoint: string; fstype: string; total: number; used: number; usedPercent: number }[] | null;
  network: { name: string; mac: string; addrs: string[] | null }[] | null;
  users: string[] | null;
  software: { name: string; version?: string; publisher?: string }[] | null;
  softwareError?: string;
  /** tylko Windows: licencja, ochrona przed zapisem (UWF), zadania kiosku */
  windows?: WinStatus | null;
}

export interface WinStatus {
  license?: {
    name: string;
    description: string;
    /** 0 brak licencji, 1 licencja, 2–6 okresy przejściowe */
    status: number;
    evaluation: boolean;
    graceMinutes: number;
    evalEnd?: number;
    rearmsLeft: number;
  };
  uwf?: { installed: boolean; enabled: boolean; nextEnabled: boolean; overlayUsedMB: number; overlayFreeMB: number; agentExcluded: boolean };
  task?: { kind: string; step: string; started: number };
  lastTask?: { kind: string; ok: boolean; message: string; at: number };
}

export type KioskAction = 'service-on' | 'service-off' | 'extend';

export interface AgentDetail extends Agent {
  inventory: Inventory | null;
}

export interface ProcInfo {
  pid: number;
  ppid: number;
  name: string;
  user: string;
  cmdline: string;
  cpu: number;
  memRss: number;
  memPercent: number;
  started: number;
}

export interface ServiceInfo {
  name: string;
  displayName: string;
  status: 'running' | 'stopped' | 'starting' | 'stopping' | 'failed' | 'other';
  startType: 'auto' | 'manual' | 'disabled' | 'static' | '';
  description?: string;
}

export interface FsRoot {
  path: string;
  label: string;
  total?: number;
  free?: number;
  kind: 'drive' | 'shortcut';
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'dir' | 'file' | 'other';
  link?: boolean;
  size: number;
  modified: number;
  mode: string;
  hidden?: boolean;
}

export interface DirListing {
  path: string;
  parent?: string;
  entries: FileEntry[];
  truncated?: boolean;
}

export interface TextFile {
  path: string;
  size: number;
  modified: number;
  content?: string;
  binary?: boolean;
  tooLarge?: boolean;
}

export interface UpdatesStatus {
  policy: 'auto' | 'manual';
  target: string | null;
  latest: string | null;
  releases: { version: string; created: string | null; platforms: string[] }[];
  source: { configured: boolean; repo: string | null; lastCheck: number | null; lastError: string | null };
  agents: { version: string; count: number; online: number }[];
  outdated: number;
}

export type PowerAction = 'reboot' | 'shutdown' | 'cancel' | 'logoff' | 'lock';
export type ServiceAction = 'start' | 'stop' | 'restart' | 'enable' | 'disable';

export interface Site {
  id: number;
  clientId: number;
  name: string;
  agentCount: number;
}

export type ConsentMode = 'none' | 'notify' | 'ask';

export interface Client {
  id: number;
  name: string;
  notes: string;
  color: string;
  consentMode: ConsentMode;
  createdAt: number;
  agentCount: number;
  sites: Site[];
}

export interface Tag extends TagRef {
  agentCount: number;
}

export interface EnrollToken {
  id: number;
  label: string;
  usesLeft: number | null;
  expiresAt: number;
  createdAt: number;
  createdBy: string | null;
  clientId: number | null;
  clientName: string | null;
  siteId: number | null;
  siteName: string | null;
}

export interface AuditEntry {
  id: number;
  ts: number;
  actor: string;
  action: string;
  target: string | null;
  details: string | null;
  ip: string | null;
}

export type Role = 'owner' | 'admin' | 'tech' | 'viewer';
export type Permission =
  | 'agents.view'
  | 'agents.refresh'
  | 'agents.remote'
  | 'agents.manage'
  | 'clients.manage'
  | 'tokens.manage'
  | 'audit.view'
  | 'team.manage';
export type Restriction = 'password_change_required' | 'mfa_setup_required' | null;

export const ROLE_LABELS: Record<Role, string> = { owner: 'Właściciel', admin: 'Administrator', tech: 'Technik', viewer: 'Podgląd' };
export const ROLE_HINTS: Record<Role, string> = {
  owner: 'Pełny dostęp, w tym zarządzanie zespołem.',
  admin: 'Wszystko poza zarządzaniem zespołem.',
  tech: 'Praca zdalna na komputerach, bez usuwania i ustawień.',
  viewer: 'Tylko podgląd: lista, metryki i inwentarz.',
};

export interface Me {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  roleLabel: string;
  permissions: Permission[];
  allClients: boolean;
  clientIds: number[];
  mfaEnabled: boolean;
  mfaRequired: boolean;
  recoveryCodesLeft: number;
  restriction: Restriction;
}

export interface TeamMember {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  allClients: boolean;
  clientIds: number[];
  disabled: boolean;
  mustChangePassword: boolean;
  mfaEnabled: boolean;
  lastLoginAt: number | null;
  createdAt: number;
}

export interface SessionInfo {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

export type LoginResult = { username: string; mfaRequired?: undefined } | { mfaRequired: true; ticket: string };

// ---------- błędy ----------

/** Błąd z API: `code` jest maszynowy (np. "agent_offline"), `message` gotowy do pokazania użytkownikowi. */
export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Komunikat błędu do pokazania w panelu. */
export function errorMessage(err: unknown, fallback = 'Wystąpił błąd.'): string {
  if (err instanceof ApiError) return err.message || fallback;
  return 'Brak połączenia z serwerem.';
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data as { error?: string; message?: string };
    const code = e.error ?? 'http_' + res.status;
    if (res.status === 401 && !url.startsWith('/api/auth/login')) window.dispatchEvent(new Event('overvnc:unauthorized'));
    // konto dostało ograniczenie (np. właściciel zresetował 2FA) — przeładuj profil
    if (code === 'password_change_required' || code === 'mfa_setup_required') window.dispatchEvent(new Event('overvnc:restricted'));
    throw new ApiError(res.status, code, e.message ?? res.statusText);
  }
  return data as T;
}

type Ok = { ok: true };

export const api = {
  // uwierzytelnianie
  me: () => request<Me>('GET', '/api/auth/me'),
  login: (username: string, password: string) => request<LoginResult>('POST', '/api/auth/login', { username, password }),
  loginMfa: (ticket: string, code: string) => request<{ username: string }>('POST', '/api/auth/login/mfa', { ticket, code }),
  logout: () => request<Ok>('POST', '/api/auth/logout', {}),
  changePassword: (currentPassword: string, newPassword: string) => request<Ok>('POST', '/api/auth/password', { currentPassword, newPassword }),
  mfaSetup: () => request<{ secret: string; otpauthUrl: string }>('POST', '/api/auth/2fa/setup', {}),
  mfaEnable: (code: string) => request<{ recoveryCodes: string[] }>('POST', '/api/auth/2fa/enable', { code }),
  mfaDisable: (password: string) => request<Ok>('POST', '/api/auth/2fa/disable', { password }),
  regenerateRecoveryCodes: (password: string) => request<{ recoveryCodes: string[] }>('POST', '/api/auth/2fa/recovery-codes', { password }),
  sessions: () => request<SessionInfo[]>('GET', '/api/auth/sessions'),
  revokeSession: (id: string) => request<Ok>('DELETE', `/api/auth/sessions/${id}`),
  revokeOtherSessions: () => request<{ revoked: number }>('DELETE', '/api/auth/sessions'),

  // komputery
  agents: () => request<Agent[]>('GET', '/api/agents'),
  agent: (id: string) => request<AgentDetail>('GET', `/api/agents/${id}`),
  updateAgent: (id: string, patch: { label?: string; notes?: string; clientId?: number | null; siteId?: number | null; tagIds?: number[] }) =>
    request<Agent>('PATCH', `/api/agents/${id}`, patch),
  bulkUpdate: (body: { ids: string[]; clientId?: number | null; siteId?: number | null; addTagIds?: number[]; removeTagIds?: number[] }) =>
    request<{ updated: number }>('POST', '/api/agents/bulk', body),
  refreshInventory: (id: string) => request<Ok>('POST', `/api/agents/${id}/refresh`, {}),
  deleteAgent: (id: string) => request<Ok>('DELETE', `/api/agents/${id}`),
  metricsHistory: (id: string, range: MetricRange) => request<{ range: MetricRange; samples: MetricSample[] }>('GET', `/api/agents/${id}/metrics?range=${range}`),

  // praca zdalna
  processes: (id: string) => request<ProcInfo[]>('GET', `/api/agents/${id}/processes`),
  killProcess: (id: string, pid: number, force: boolean, name: string) =>
    request<Ok>('POST', `/api/agents/${id}/processes/${pid}/kill`, { force, name }),
  services: (id: string) => request<ServiceInfo[]>('GET', `/api/agents/${id}/services`),
  controlService: (id: string, name: string, action: ServiceAction) =>
    request<Ok>('POST', `/api/agents/${id}/services/${encodeURIComponent(name)}/${action}`, {}),
  power: (id: string, action: PowerAction, delayMinutes = 0, message = '') => request<Ok>('POST', `/api/agents/${id}/power`, { action, delayMinutes, message }),
  // pliki
  fsRoots: (id: string) => request<FsRoot[]>('GET', `/api/agents/${id}/files/roots`),
  fsList: (id: string, path: string) => request<DirListing>('GET', `/api/agents/${id}/files?path=${encodeURIComponent(path)}`),
  fsMkdir: (id: string, path: string) => request<{ path: string }>('POST', `/api/agents/${id}/files/mkdir`, { path }),
  fsRename: (id: string, from: string, to: string) => request<{ path: string }>('POST', `/api/agents/${id}/files/rename`, { from, to }),
  fsDelete: (id: string, paths: string[]) => request<{ deleted: number }>('POST', `/api/agents/${id}/files/delete`, { paths }),
  fsReadText: (id: string, path: string) => request<TextFile>('GET', `/api/agents/${id}/files/text?path=${encodeURIComponent(path)}`),
  fsWriteText: (id: string, path: string, content: string, expectedModified: number) =>
    request<TextFile>('PUT', `/api/agents/${id}/files/text`, { path, content, expectedModified }),
  downloadUrl: (id: string, path: string, zip = false) => `/api/agents/${id}/files/download?path=${encodeURIComponent(path)}${zip ? '&zip=1' : ''}`,
  uploadUrl: (id: string, dir: string, name: string, overwrite: boolean) =>
    `/api/agents/${id}/files/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}${overwrite ? '&overwrite=1' : ''}`,

  // aktualizacje agentów
  updates: () => request<UpdatesStatus>('GET', '/api/updates'),
  updatesCheck: () => request<{ added: string | null; latest: string | null; queued: number }>('POST', '/api/updates/check', {}),
  updatesPolicy: (policy: 'auto' | 'manual') => request<{ policy: string }>('PUT', '/api/updates/policy', { policy }),
  updatesApprove: (version: string) => request<{ target: string; queued: number }>('POST', '/api/updates/approve', { version }),
  updatesRollout: () => request<{ queued: number }>('POST', '/api/updates/rollout', {}),
  upgradeAgent: (id: string) => request<{ status: string; version: string }>('POST', `/api/agents/${id}/update`, {}),

  wakeInfo: (id: string) => request<{ possible: boolean; reason: 'no_mac' | 'no_relay' | null; relay: { id: string; name: string } | null; macs: string[] }>('GET', `/api/agents/${id}/wake`),
  wake: (id: string) => request<{ ok: true; relay: { id: string; name: string } }>('POST', `/api/agents/${id}/wake`, {}),

  // klienci, lokalizacje, tagi
  clients: () => request<Client[]>('GET', '/api/clients'),
  createClient: (body: { name: string; notes?: string; color?: string; consentMode?: ConsentMode }) => request<{ id: number }>('POST', '/api/clients', body),
  updateClient: (id: number, body: { name?: string; notes?: string; color?: string; consentMode?: ConsentMode }) => request<Ok>('PATCH', `/api/clients/${id}`, body),
  deleteClient: (id: number) => request<Ok>('DELETE', `/api/clients/${id}`),
  createSite: (clientId: number, name: string) => request<{ id: number }>('POST', `/api/clients/${clientId}/sites`, { name }),
  updateSite: (id: number, name: string) => request<Ok>('PATCH', `/api/sites/${id}`, { name }),
  deleteSite: (id: number) => request<Ok>('DELETE', `/api/sites/${id}`),
  tags: () => request<Tag[]>('GET', '/api/tags'),
  createTag: (name: string, color: string) => request<{ id: number }>('POST', '/api/tags', { name, color }),
  updateTag: (id: number, body: { name?: string; color?: string }) => request<Ok>('PATCH', `/api/tags/${id}`, body),
  deleteTag: (id: number) => request<Ok>('DELETE', `/api/tags/${id}`),

  // tokeny rejestracji
  tokens: () => request<EnrollToken[]>('GET', '/api/enroll-tokens'),
  createToken: (body: { label: string; ttlHours: number; maxUses: number | null; clientId: number | null; siteId: number | null }) =>
    request<{ id: number; token: string }>('POST', '/api/enroll-tokens', body),
  deleteToken: (id: number) => request<Ok>('DELETE', `/api/enroll-tokens/${id}`),

  // zespół
  users: () => request<TeamMember[]>('GET', '/api/users'),
  createUser: (body: { username: string; displayName: string; role: Role; allClients: boolean; clientIds: number[] }) =>
    request<{ user: TeamMember; temporaryPassword: string }>('POST', '/api/users', body),
  updateUser: (id: number, body: Partial<Pick<TeamMember, 'displayName' | 'role' | 'allClients' | 'clientIds' | 'disabled'>>) =>
    request<TeamMember>('PATCH', `/api/users/${id}`, body),
  resetPassword: (id: number) => request<{ temporaryPassword: string }>('POST', `/api/users/${id}/reset-password`, {}),
  reset2fa: (id: number) => request<Ok>('POST', `/api/users/${id}/reset-2fa`, {}),
  deleteUser: (id: number) => request<Ok>('DELETE', `/api/users/${id}`),

  audit: () => request<AuditEntry[]>('GET', '/api/audit?limit=300'),
  // kiosk: zrzut ekranu (miniatury) i komunikat na ekranie
  screenshotUrl: (id: string, w = 640) => `/api/agents/${id}/screenshot?w=${w}`,
  kioskAction: (id: string, action: KioskAction) => request<{ status: string; restarts?: number }>('POST', `/api/agents/${id}/kiosk/${action}`, {}),
  screenMessage: (id: string, body: { text: string; title?: string; seconds?: number }) => request<Ok>('POST', `/api/agents/${id}/message`, body),

  // alerty i powiadomienia
  alerts: (state: 'open' | 'all', agentId?: string) =>
    request<AlertItem[]>('GET', `/api/alerts?state=${state}${agentId ? `&agentId=${agentId}` : ''}`),
  ackAlert: (id: number) => request<AlertItem>('POST', `/api/alerts/${id}/ack`, {}),
  alertRules: () => request<AlertRule[]>('GET', '/api/alert-rules'),
  createAlertRule: (r: AlertRuleInput) => request<{ id: number }>('POST', '/api/alert-rules', r),
  updateAlertRule: (id: number, r: AlertRuleInput) => request<Ok>('PUT', `/api/alert-rules/${id}`, r),
  deleteAlertRule: (id: number) => request<Ok>('DELETE', `/api/alert-rules/${id}`),
  notificationSettings: () => request<NotificationSettings>('GET', '/api/settings/notifications'),
  saveNotificationSettings: (body: { token?: string; user?: string; clear?: boolean }) =>
    request<NotificationSettings>('PUT', '/api/settings/notifications', body),
  testNotification: () => request<Ok>('POST', '/api/settings/notifications/test', {}),

};
