import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api.ts';

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'error' | 'exists' | 'cancelled';

export interface UploadItem {
  id: number;
  file: File;
  dir: string;
  status: UploadStatus;
  loaded: number;
  error?: string;
  overwrite?: boolean;
}

/**
 * Kolejka wysyłania: pliki idą po jednym (nie zapychamy łącza komputera),
 * z postępem z XHR (fetch nie raportuje postępu wysyłania), anulowaniem i obsługą „plik istnieje”.
 */
export function useUploads(agentId: string, onUploaded: (dir: string) => void) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const current = useRef<{ id: number; xhr: XMLHttpRequest } | null>(null);
  const seq = useRef(0);
  const onUploadedRef = useRef(onUploaded);
  onUploadedRef.current = onUploaded;

  const patch = (id: number, p: Partial<UploadItem>) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x)));

  const add = useCallback((files: File[], dir: string) => {
    setItems((xs) => [...xs, ...files.map((file) => ({ id: ++seq.current, file, dir, status: 'queued' as const, loaded: 0 }))]);
  }, []);

  // uruchom następny z kolejki, gdy nic się nie wysyła
  useEffect(() => {
    if (current.current) return;
    const next = items.find((x) => x.status === 'queued');
    if (!next) return;

    const xhr = new XMLHttpRequest();
    current.current = { id: next.id, xhr };
    patch(next.id, { status: 'uploading', loaded: 0, error: undefined });
    xhr.open('POST', api.uploadUrl(agentId, next.dir, next.file.name, !!next.overwrite));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => patch(next.id, { loaded: e.loaded });
    const finish = (p: Partial<UploadItem>) => {
      current.current = null;
      patch(next.id, p);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        finish({ status: 'done', loaded: next.file.size });
        onUploadedRef.current(next.dir);
        return;
      }
      let body: { error?: string; message?: string } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* brak treści */
      }
      if (xhr.status === 401) window.dispatchEvent(new Event('overvnc:unauthorized'));
      finish(xhr.status === 422 && body.error === 'exists' ? { status: 'exists' } : { status: 'error', error: body.message ?? `Błąd ${xhr.status}` });
    };
    xhr.onerror = () => finish({ status: 'error', error: 'Przerwane połączenie' });
    xhr.onabort = () => finish({ status: 'cancelled' });
    xhr.send(next.file);
  }, [items, agentId]);

  // przerwij wysyłanie przy opuszczeniu widoku
  useEffect(() => () => current.current?.xhr.abort(), []);

  const cancel = useCallback((id: number) => {
    if (current.current?.id === id) current.current.xhr.abort();
    else patch(id, { status: 'cancelled' });
  }, []);

  const overwrite = useCallback((id: number) => patch(id, { status: 'queued', overwrite: true }), []);
  const clearFinished = useCallback(() => setItems((xs) => xs.filter((x) => x.status === 'queued' || x.status === 'uploading' || x.status === 'exists')), []);

  return { items, add, cancel, overwrite, clearFinished };
}
