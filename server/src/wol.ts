/**
 * Wake-on-LAN przez przekaźnik: pakiet wysyła inny włączony komputer z tej samej sieci lokalnej.
 *
 * Sama zgodność podsieci NIE wystarcza — tysiące firm używa 192.168.1.0/24. Przekaźnik musi więc
 * dodatkowo wychodzić do internetu z tego samego publicznego IP albo należeć do tego samego klienta.
 */

interface NetIf {
  name?: string;
  mac?: string;
  addrs?: string[] | null;
}

export interface WolHost {
  id: string;
  clientId: number | null;
  siteId: number | null;
  lastIp: string | null;
  online: boolean;
  network: NetIf[];
}

interface Subnet {
  network: number;
  prefix: number;
  broadcast: string;
}

function ipToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

const intToIp = (n: number) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');

/** Sieci prywatne (RFC 1918) — tylko w nich WoL ma sens. */
function isPrivate(n: number): boolean {
  return n >>> 24 === 10 || n >>> 20 === (172 << 4) + 1 || n >>> 16 === (192 << 8) + 168;
}

/** Podsieci IPv4 prywatne z listy interfejsów (adresy w formacie "192.168.1.10/24"). */
export function privateSubnets(network: NetIf[]): Subnet[] {
  const out: Subnet[] = [];
  for (const nic of network) {
    for (const a of nic.addrs ?? []) {
      const [ip, pfx] = a.split('/');
      const n = ipToInt(ip);
      const prefix = Number(pfx);
      if (n === null || !isPrivate(n) || !Number.isInteger(prefix) || prefix < 8 || prefix > 30) continue;
      const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
      const net = (n & mask) >>> 0;
      out.push({ network: net, prefix, broadcast: intToIp((net | (~mask >>> 0)) >>> 0) });
    }
  }
  return out;
}

const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const VIRTUAL_NIC = /^(lo|docker|br-|veth|virbr|vmnet|vboxnet|utun|awdl|llw|tun|tap|zt|tailscale|wg)/i;

/** Adresy MAC fizycznych kart z adresem w sieci prywatnej. */
export function wakeMacs(network: NetIf[]): string[] {
  const macs = new Set<string>();
  for (const nic of network) {
    if (!nic.mac || !MAC_RE.test(nic.mac) || nic.mac === '00:00:00:00:00:00') continue;
    if (nic.name && VIRTUAL_NIC.test(nic.name)) continue;
    if (privateSubnets([nic]).length === 0) continue;
    macs.add(nic.mac.toLowerCase());
  }
  return [...macs];
}

export interface WolPlan {
  relayId: string;
  macs: string[];
  broadcasts: string[];
}

/** Wybiera przekaźnik; preferuje komputer z tej samej lokalizacji. null = brak możliwości. */
export function planWake(target: WolHost, candidates: WolHost[]): WolPlan | null {
  const macs = wakeMacs(target.network);
  const targetNets = privateSubnets(target.network);
  if (macs.length === 0 || targetNets.length === 0) return null;

  const scored: { host: WolHost; broadcasts: string[]; score: number }[] = [];
  for (const c of candidates) {
    if (!c.online || c.id === target.id) continue;
    const sameNat = !!target.lastIp && c.lastIp === target.lastIp;
    const sameClient = target.clientId !== null && c.clientId === target.clientId;
    if (!sameNat && !sameClient) continue;
    const shared = privateSubnets(c.network).filter((s) => targetNets.some((t) => t.network === s.network && t.prefix === s.prefix));
    if (shared.length === 0) continue;
    const score = (sameNat ? 2 : 0) + (target.siteId !== null && c.siteId === target.siteId ? 1 : 0);
    scored.push({ host: c, broadcasts: [...new Set(shared.map((s) => s.broadcast))], score });
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  return best ? { relayId: best.host.id, macs, broadcasts: best.broadcasts } : null;
}
