/**
 * Role i uprawnienia. Jedno źródło prawdy — panel dostaje listę uprawnień z /api/auth/me
 * i na jej podstawie pokazuje/ukrywa akcje; serwer egzekwuje je na każdej trasie.
 */
export const ROLES = ['owner', 'admin', 'tech', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Właściciel',
  admin: 'Administrator',
  tech: 'Technik',
  viewer: 'Podgląd',
};

const ALL: Role[] = ['owner', 'admin', 'tech', 'viewer'];
const TECH_UP: Role[] = ['owner', 'admin', 'tech'];
const ADMIN_UP: Role[] = ['owner', 'admin'];

export const PERMISSIONS = {
  /** lista komputerów, metryki, inwentarz */
  'agents.view': ALL,
  /** odświeżanie inwentarza */
  'agents.refresh': TECH_UP,
  /** praca zdalna: terminal, procesy, pliki, pulpit, zasilanie, skrypty */
  'agents.remote': TECH_UP,
  /** nazwa, klient/lokalizacja, tagi, notatki, usuwanie */
  'agents.manage': ADMIN_UP,
  /** klienci, lokalizacje, tagi */
  'clients.manage': ADMIN_UP,
  /** tokeny rejestracji */
  'tokens.manage': ADMIN_UP,
  /** dziennik zdarzeń */
  'audit.view': ADMIN_UP,
  /** konta zespołu */
  'team.manage': ['owner'] as Role[],
} satisfies Record<string, Role[]>;

export type Permission = keyof typeof PERMISSIONS;

/** Role, dla których 2FA jest obowiązkowe. */
export const MFA_REQUIRED_ROLES: Role[] = ['owner', 'admin'];

export function can(role: Role, perm: Permission): boolean {
  return (PERMISSIONS[perm] as Role[]).includes(role);
}

export function permissionsOf(role: Role): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(role, p));
}

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}
