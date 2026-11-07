import type { Db } from './db.ts';
import type { Hub } from './hub.ts';

export type AgentKind = 'computer' | 'kiosk';

/**
 * Profil komputera do agenta (`agent.profile`): po każdym połączeniu i po zmianie w panelu.
 * Agent zapamiętuje go lokalnie — funkcje kiosku działają też bez połączenia z serwerem.
 * Zwraca uwagę agenta (np. „zmiana zadziała po ponownym zalogowaniu klienta”) albo null.
 */
export async function pushProfile(db: Db, hub: Hub, agentId: string): Promise<string | null> {
  const row = db.prepare('SELECT kind, phone_app FROM agents WHERE id = ?').get(agentId) as { kind: AgentKind; phone_app: number } | undefined;
  if (!row || !hub.isOnline(agentId) || !hub.summary(agentId)?.capabilities.includes('agent.profile')) return null;
  const r = await hub.request<{ note?: string }>(agentId, 'agent.profile', { kiosk: row.kind === 'kiosk', phoneApp: row.kind === 'kiosk' && !!row.phone_app }, { timeoutMs: 150_000 });
  return r?.note || null;
}

export function installProfilePush(db: Db, hub: Hub, log: (msg: string) => void): void {
  hub.on('ready', (id) => {
    pushProfile(db, hub, id).catch((e: Error) => log(`profil ${id}: ${e.message}`));
  });
}
