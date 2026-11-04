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
}

export interface AgentDetail extends Agent {
  inventory: Inventory | null;
}

export interface Site {
  id: number;
  clientId: number;
  name: string;
  agentCount: number;
}

export interface Client {
  id: number;
  name: string;
  notes: string;
  color: string;
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

  // klienci, lokalizacje, tagi
  clients: () => request<Client[]>('GET', '/api/clients'),
  createClient: (body: { name: string; notes?: string; color?: string }) => request<{ id: number }>('POST', '/api/clients', body),
  updateClient: (id: number, body: { name?: string; notes?: string; color?: string }) => request<Ok>('PATCH', `/api/clients/${id}`, body),
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
};
