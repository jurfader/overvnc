import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type Client, type Me, type Permission, type Tag } from './api.ts';

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
