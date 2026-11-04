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

export interface EnrollToken {
  id: number;
  label: string;
  usesLeft: number | null;
  expiresAt: number;
  createdAt: number;
  createdBy: string | null;
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
    if (res.status === 401 && url !== '/api/auth/login') window.dispatchEvent(new Event('overvnc:unauthorized'));
    const e = data as { error?: string; message?: string };
    throw new ApiError(res.status, e.error ?? 'http_' + res.status, e.message ?? res.statusText);
  }
  return data as T;
}

export const api = {
  me: () => request<{ username: string }>('GET', '/api/auth/me'),
  login: (username: string, password: string) => request<{ username: string }>('POST', '/api/auth/login', { username, password }),
  logout: () => request('POST', '/api/auth/logout', {}),

  agents: () => request<Agent[]>('GET', '/api/agents'),
  agent: (id: string) => request<AgentDetail>('GET', `/api/agents/${id}`),
  setLabel: (id: string, label: string) => request('PATCH', `/api/agents/${id}`, { label }),
  refreshInventory: (id: string) => request('POST', `/api/agents/${id}/refresh`, {}),
  deleteAgent: (id: string) => request('DELETE', `/api/agents/${id}`),

  tokens: () => request<EnrollToken[]>('GET', '/api/enroll-tokens'),
  createToken: (label: string, ttlHours: number, maxUses: number | null) =>
    request<{ id: number; token: string }>('POST', '/api/enroll-tokens', { label, ttlHours, maxUses }),
  deleteToken: (id: number) => request('DELETE', `/api/enroll-tokens/${id}`),

  audit: () => request<AuditEntry[]>('GET', '/api/audit?limit=300'),
};
