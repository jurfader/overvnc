import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';

export interface ScreenshotState {
  url: string | null;
  error: string | null;
  /** czas wykonania zrzutu na komputerze (ms od epoki) */
  at: number | null;
  loading: boolean;
  refresh: () => void;
}

/**
 * Zrzut ekranu komputera jako adres blob: (obraz trafia przez fetch, żeby pokazać czytelny błąd z serwera).
 * intervalMs > 0 — odświeżanie cykliczne, wstrzymywane gdy karta przeglądarki jest ukryta albo `active` = false.
 */
export function useScreenshot(agentId: string, width: number, opts: { enabled: boolean; intervalMs?: number; active?: boolean }): ScreenshotState {
  const { enabled, intervalMs = 0, active = true } = opts;
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const busy = useRef(false);
  const urlRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!enabled || busy.current) return;
    busy.current = true;
    setLoading(true);
    try {
      const res = await fetch(api.screenshotUrl(agentId, width), { credentials: 'same-origin' });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { message?: string };
        setError(e.message ?? `Błąd ${res.status}`);
        return;
      }
      const next = URL.createObjectURL(await res.blob());
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = next;
      setUrl(next);
      setAt(Number(res.headers.get('X-Captured-At')) || Date.now());
      setError(null);
    } catch {
      setError('Brak połączenia z serwerem.');
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [agentId, width, enabled]);

  useEffect(() => {
    if (!enabled || !active) return;
    void load();
    if (!intervalMs) return;
    const tick = () => document.visibilityState === 'visible' && void load();
    const t = window.setInterval(tick, intervalMs);
    return () => window.clearInterval(t);
  }, [load, enabled, active, intervalMs]);

  // zwolnienie pamięci obrazu przy odmontowaniu
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  return { url, error, at, loading, refresh: () => void load() };
}
