import { isIP } from 'node:net';
import type { Db } from './db.ts';
import type { Hub } from './hub.ts';

export type AgentKind = 'computer' | 'kiosk';

/**
 * Profil komputera do agenta (`agent.profile`): po każdym połączeniu i po zmianie w panelu.
 * Agent zapamiętuje go lokalnie — funkcje kiosku działają też bez połączenia z serwerem.
 * Zwraca uwagę agenta (np. „zmiana zadziała po ponownym zalogowaniu klienta”) albo null.
 */
export async function pushProfile(db: Db, hub: Hub, agentId: string): Promise<string | null> {
  const row = db.prepare('SELECT kind, phone_app, end_button, share_mode, share_allow FROM agents WHERE id = ?').get(agentId) as
    | { kind: AgentKind; phone_app: number; end_button: number; share_mode: string; share_allow: string }
    | undefined;
  if (!row || !hub.isOnline(agentId) || !hub.summary(agentId)?.capabilities.includes('agent.profile')) return null;
  const kiosk = row.kind === 'kiosk';
  const r = await hub.request<{ note?: string }>(
    agentId,
    'agent.profile',
    {
      kiosk,
      phoneApp: kiosk && !!row.phone_app,
      endButton: kiosk && !!row.end_button,
      shareMode: kiosk ? row.share_mode : 'off',
      shareAllow: kiosk ? row.share_allow : '',
    },
    { timeoutMs: 150_000 },
  );
  return r?.note || null;
}

export function installProfilePush(db: Db, hub: Hub, log: (msg: string) => void): void {
  hub.on('ready', (id) => {
    pushProfile(db, hub, id).catch((e: Error) => log(`profil ${id}: ${e.message}`));
  });
}

/** Lista adresów IP / sieci CIDR oddzielonych przecinkami (puste = sieć lokalna). */
export function validAllowList(s: string): boolean {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .every((x) => {
      const [ip, bits, extra] = x.split('/');
      if (extra !== undefined || !isIP(ip)) return false;
      if (bits === undefined) return true;
      const n = Number(bits);
      return /^\d+$/.test(bits) && n >= 0 && n <= (isIP(ip) === 6 ? 128 : 32);
    });
}
