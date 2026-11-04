import type { Config } from './config.ts';
import type { Db } from './db.ts';
import type { Hub } from './hub.ts';
import type { RateLimiter } from './ratelimit.ts';
import type { Role } from './permissions.ts';
import type { UpdateStore } from './updates.ts';
import type { MetricsStore } from './metrics.ts';
import type { AlertEngine } from './alerts.ts';
import type { Notifier } from './notify.ts';
import type { JobRunner } from './jobs.ts';
import type { Scheduler } from './schedules.ts';

/** Zależności współdzielone przez wszystkie moduły tras. */
export interface Ctx {
  config: Config;
  db: Db;
  hub: Hub;
  /** Klucz AES-256 do szyfrowania sekretów w bazie. */
  secretKey: Buffer;
  /** Wydania agenta i polityka aktualizacji. */
  updates: UpdateStore;
  /** Historia metryk komputerów (wykresy monitoringu). */
  metrics: MetricsStore;
  /** Silnik alertów (reguły, otwarte alerty). */
  alerts: AlertEngine;
  /** Powiadomienia push (Pushover). */
  notifier: Notifier;
  /** Zadania w tle (skrypty i akcje na wielu komputerach). */
  jobs: JobRunner;
  /** Harmonogram zadań (dni tygodnia + godzina). */
  scheduler: Scheduler;
  /** Wysyła „sprawdź aktualizację” do nieaktualnych komputerów (ustawiane przez trasy aktualizacji). */
  rollout?: (ids?: string[]) => number;
  limits: {
    login: RateLimiter;
    enroll: RateLimiter;
  };
}

/**
 * Konto ma ograniczony dostęp, dopóki nie wykona wymaganej czynności:
 * - password_change_required — logowanie hasłem tymczasowym nadanym przez właściciela,
 * - mfa_setup_required — rola wymaga 2FA, a nie jest skonfigurowane.
 */
export type Restriction = 'password_change_required' | 'mfa_setup_required' | null;

/** Zakres widoczności komputerów (wg klientów). */
export interface Scope {
  allClients: boolean;
  clientIds: number[];
}

export interface SessionUser extends Scope {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  sessionId: string;
  mfaEnabled: boolean;
  restriction: Restriction;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}
