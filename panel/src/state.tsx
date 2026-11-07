import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type AlertItem, type ChatMessage, type Client, type Me, type Permission, type Tag } from './api.ts';

// ---------- zalogowane konto ----------

interface MeState {
  me: Me;
  can: (perm: Permission) => boolean;
  reloadMe: () => Promise<void>;
}

const MeContext = createContext<MeState | null>(null);

export function MeProvider({ me, reloadMe, children }: { me: Me; reloadMe: () => Promise<void>; children: ReactNode }) {
  const can = useCallback((perm: Permission) => me.permissions.includes(perm), [me]);
  return <MeContext.Provider value={{ me, can, reloadMe }}>{children}</MeContext.Provider>;
}

export function useMe(): MeState {
  const ctx = useContext(MeContext);
  if (!ctx) throw new Error('useMe poza MeProvider');
  return ctx;
}

// ---------- klienci i tagi (słowniki używane w wielu widokach) ----------

interface OrgState {
  clients: Client[];
  tags: Tag[];
  reloadOrg: () => Promise<void>;
  clientById: (id: number | null) => Client | undefined;
}

const OrgContext = createContext<OrgState | null>(null);

export function OrgProvider({ children }: { children: ReactNode }) {
  const [clients, setClients] = useState<Client[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);

  const reloadOrg = useCallback(async () => {
    const [c, t] = await Promise.all([api.clients(), api.tags()]).catch(() => [null, null] as const);
    if (c) setClients(c);
    if (t) setTags(t);
  }, []);

  useEffect(() => {
    void reloadOrg();
    const on = () => void reloadOrg();
    window.addEventListener('overvnc:org-changed', on);
    return () => window.removeEventListener('overvnc:org-changed', on);
  }, [reloadOrg]);

  const clientById = useCallback((id: number | null) => (id == null ? undefined : clients.find((c) => c.id === id)), [clients]);
  return <OrgContext.Provider value={{ clients, tags, reloadOrg, clientById }}>{children}</OrgContext.Provider>;
}

export function useOrg(): OrgState {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error('useOrg poza OrgProvider');
  return ctx;
}

/** Powiadamia wszystkie widoki, że zmienili się klienci/tagi. */
export function orgChanged(): void {
  window.dispatchEvent(new Event('overvnc:org-changed'));
}

// ---------- alerty (otwarte — licznik w menu, znaczniki na liście komputerów) ----------

interface AlertsState {
  open: AlertItem[];
  /** otwarte i niepotwierdzone */
  unacked: number;
  byAgent: Map<string, AlertItem[]>;
  /** rośnie przy każdej zmianie alertów — widoki historii pobierają ją wtedy ponownie */
  version: number;
  reload: () => Promise<void>;
}

const AlertsContext = createContext<AlertsState | null>(null);

/** Zdarzenie alertu z WebSocketu panelu (App przekazuje je przez window). */
export interface AlertEvent {
  type: 'alert_opened' | 'alert_resolved' | 'alert_updated';
  data: AlertItem;
}

export function alertEvent(e: AlertEvent): void {
  window.dispatchEvent(new CustomEvent<AlertEvent>('overvnc:alert', { detail: e }));
}

export function AlertsProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<AlertItem[]>([]);
  const [version, setVersion] = useState(0);

  const reload = useCallback(async () => {
    const list = await api.alerts('open').catch(() => null);
    if (list) setOpen(list);
    setVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    void reload();
    const onAlert = (ev: Event) => {
      const { type, data } = (ev as CustomEvent<AlertEvent>).detail;
      if (!data) return;
      setOpen((prev) => {
        const rest = prev.filter((a) => a.id !== data.id);
        return type === 'alert_resolved' || data.resolvedAt ? rest : [data, ...rest].sort((a, b) => b.startedAt - a.startedAt);
      });
      setVersion((v) => v + 1);
    };
    const onReload = () => void reload();
    window.addEventListener('overvnc:alert', onAlert);
    window.addEventListener('overvnc:alerts-reload', onReload);
    return () => {
      window.removeEventListener('overvnc:alert', onAlert);
      window.removeEventListener('overvnc:alerts-reload', onReload);
    };
  }, [reload]);

  const value = useMemo(() => {
    const byAgent = new Map<string, AlertItem[]>();
    for (const a of open) byAgent.set(a.agentId, [...(byAgent.get(a.agentId) ?? []), a]);
    return { open, unacked: open.filter((a) => !a.ackAt).length, byAgent, version, reload };
  }, [open, version, reload]);
  return <AlertsContext.Provider value={value}>{children}</AlertsContext.Provider>;
}

export function useAlerts(): AlertsState {
  const ctx = useContext(AlertsContext);
  if (!ctx) throw new Error('useAlerts poza AlertsProvider');
  return ctx;
}

// ---------- czat (nieprzeczytane wiadomości od użytkowników komputerów) ----------

/** Zdarzenie czatu z WebSocketu panelu (App przekazuje je przez window). */
export interface ChatEvent {
  type: 'chat_message' | 'chat_read';
  id: string;
  data?: ChatMessage;
}

export function chatEvent(e: ChatEvent): void {
  window.dispatchEvent(new CustomEvent<ChatEvent>('overvnc:chat', { detail: e }));
}

const ChatContext = createContext<Map<string, number>>(new Map());

export function ChatProvider({ children }: { children: ReactNode }) {
  const [unread, setUnread] = useState<Map<string, number>>(new Map());
  const reload = useCallback(async () => {
    const list = await api.chatUnread().catch(() => null);
    if (list) setUnread(new Map(list.map((u) => [u.agentId, u.count])));
  }, []);
  useEffect(() => {
    void reload();
    const seen = new Set<number>();
    const on = (ev: Event) => {
      const e = (ev as CustomEvent<ChatEvent>).detail;
      if (e.type === 'chat_read') return setUnread((m) => (m.has(e.id) ? new Map([...m].filter(([k]) => k !== e.id)) : m));
      const msg = e.data;
      if (!msg || msg.direction !== 'in' || msg.readAt || seen.has(msg.id)) return;
      seen.add(msg.id);
      setUnread((m) => new Map(m).set(e.id, (m.get(e.id) ?? 0) + 1));
    };
    const onReload = () => void reload();
    window.addEventListener('overvnc:chat', on);
    window.addEventListener('overvnc:alerts-reload', onReload);
    return () => {
      window.removeEventListener('overvnc:chat', on);
      window.removeEventListener('overvnc:alerts-reload', onReload);
    };
  }, [reload]);
  return <ChatContext.Provider value={unread}>{children}</ChatContext.Provider>;
}

/** Liczba nieprzeczytanych wiadomości czatu dla każdego komputera. */
export function useChatUnread(): Map<string, number> {
  return useContext(ChatContext);
}
