import type { Scope } from './context.ts';
import type { Db } from './db.ts';
import { HttpError, notFound } from './errors.ts';

/**
 * Widoczność wg klientów. Konto z dostępem do wybranych klientów widzi tylko ich komputery;
 * komputery bez przypisanego klienta widzą wyłącznie konta z dostępem do wszystkich.
 */
export function canSeeClient(scope: Scope, clientId: number | null): boolean {
  return scope.allClients || (clientId !== null && scope.clientIds.includes(clientId));
}

/** Fragment SQL filtrujący po kolumnie client_id. */
export function scopeSql(scope: Scope, column = 'client_id'): { sql: string; params: number[] } {
  if (scope.allClients) return { sql: '1 = 1', params: [] };
  if (scope.clientIds.length === 0) return { sql: '0 = 1', params: [] };
  return { sql: `${column} IN (${scope.clientIds.map(() => '?').join(', ')})`, params: scope.clientIds };
}

/** Rzuca 404, gdy komputer nie istnieje LUB jest poza zakresem — nie zdradzamy istnienia cudzych komputerów. */
export function assertAgentAccess(db: Db, scope: Scope, agentId: string): { clientId: number | null } {
  const row = db.prepare('SELECT client_id FROM agents WHERE id = ?').get(agentId) as { client_id: number | null } | undefined;
  if (!row || !canSeeClient(scope, row.client_id)) throw notFound();
  return { clientId: row.client_id };
}

/** Sprawdza, że klient istnieje i jest w zakresie, oraz że lokalizacja należy do tego klienta. */
export function assertPlacement(db: Db, scope: Scope, clientId: number | null, siteId: number | null): void {
  if (clientId === null) {
    if (siteId !== null) throw new HttpError(400, 'validation', 'Lokalizacja wymaga wybrania klienta.');
    if (!scope.allClients) throw new HttpError(403, 'forbidden', 'Komputer musi być przypisany do jednego z Twoich klientów.');
    return;
  }
  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(clientId);
  if (!client || !canSeeClient(scope, clientId)) throw new HttpError(400, 'validation', 'Nieznany klient.');
  if (siteId !== null) {
    const site = db.prepare('SELECT client_id FROM sites WHERE id = ?').get(siteId) as { client_id: number } | undefined;
    if (!site || site.client_id !== clientId) throw new HttpError(400, 'validation', 'Lokalizacja nie należy do wybranego klienta.');
  }
}
