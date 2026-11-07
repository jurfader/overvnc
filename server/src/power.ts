import type { Hub } from './hub.ts';

export interface PowerRequest {
  action: string;
  delayMinutes: number;
  message: string;
}

/**
 * Akcja zasilania na komputerze (panel albo zadanie). Plan restartu/wyłączenia (odliczanie w panelu) zgłaszają
 * nowsze agenty same (zdarzenie `power`, przed odpowiedzią); dla starszych zapisujemy go z naszego zlecenia.
 */
export async function requestPower(hub: Hub, agentId: string, body: PowerRequest, timeoutMs?: number): Promise<unknown> {
  const r = await hub.request(agentId, 'power.action', body, { capability: `power.${body.action}`, ...(timeoutMs ? { timeoutMs } : {}) });
  if (!hub.summary(agentId)?.capabilities.includes('power.pending')) {
    if ((body.action === 'reboot' || body.action === 'shutdown') && body.delayMinutes > 0)
      hub.setPowerPending(agentId, { action: body.action, at: Date.now() + body.delayMinutes * 60_000, message: body.message });
    else if (body.action === 'reboot' || body.action === 'shutdown' || body.action === 'cancel') hub.setPowerPending(agentId, null);
  }
  return r;
}
