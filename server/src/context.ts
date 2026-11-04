import type { Config } from './config.ts';
import type { Db } from './db.ts';
import type { Hub } from './hub.ts';
import type { RateLimiter } from './ratelimit.ts';

/** Zależności współdzielone przez wszystkie moduły tras. */
export interface Ctx {
  config: Config;
  db: Db;
  hub: Hub;
  limits: {
    login: RateLimiter;
    enroll: RateLimiter;
  };
}

export interface SessionUser {
  id: number;
  username: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}
