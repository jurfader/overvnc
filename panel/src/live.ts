import { useEffect, useRef } from 'react';

export interface LiveEvent {
  type: 'agent_online' | 'agent_offline' | 'agent_updated' | 'agent_metrics' | 'agent_added' | 'agent_removed' | 'org_changed' | 'alert_opened' | 'alert_resolved' | 'alert_updated' | 'jobs_changed';
  id?: string;
  data?: any;
}

/** Utrzymuje połączenie WebSocket z serwerem i przekazuje zdarzenia na żywo. */
export function useLiveEvents(enabled: boolean, onEvent: (e: LiveEvent) => void, onReconnect: () => void): void {
  const handler = useRef(onEvent);
  const reconnect = useRef(onReconnect);
  handler.current = onEvent;
  reconnect.current = onReconnect;

  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 1000;
    let first = true;
    let timer: number | undefined;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws/panel`);
      ws.onopen = () => {
        retry = 1000;
        // po zerwaniu połączenia mogliśmy przegapić zdarzenia — pobierz stan od nowa
        if (!first) reconnect.current();
        first = false;
      };
      ws.onmessage = (m) => {
        try {
          handler.current(JSON.parse(m.data));
        } catch {
          /* ignoruj */
        }
      };
      ws.onclose = () => {
        if (closed) return;
        timer = window.setTimeout(connect, retry);
        retry = Math.min(retry * 2, 30_000);
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(timer);
      ws?.close();
    };
  }, [enabled]);
}
