import crypto from 'node:crypto';
import type { Config } from './config.ts';

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/**
 * Serwery STUN/TURN dla jednej sesji pulpitu. Hasło do TURN jest jednorazowe (standard „TURN REST
 * API”, w coturnie `use-auth-secret` + `static-auth-secret`): nazwa = czas wygaśnięcia:identyfikator,
 * hasło = base64(HMAC-SHA1(sekret, nazwa)). Bez sekretu nikt nie użyje przekaźnika na srv.
 */
export function iceServersFor(config: Config, who: string, now = Date.now()): IceServer[] {
  const p = config.p2p;
  if (!p.enabled) return [];
  const out: IceServer[] = [];
  if (p.stun.length) out.push({ urls: p.stun });
  if (p.turn) {
    const username = `${Math.floor(now / 1000) + p.turn.ttlSec}:${who.replace(/[^A-Za-z0-9_.-]/g, '')}`;
    const credential = crypto.createHmac('sha1', p.turn.secret).update(username).digest('base64');
    out.push({ urls: p.turn.urls, username, credential });
  }
  return out;
}
