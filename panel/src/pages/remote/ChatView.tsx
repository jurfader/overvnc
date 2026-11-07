import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Check, CheckCheck, Clock, MessageCircle, Send } from 'lucide-react';
import { api, errorMessage, type Agent, type ChatMessage } from '../../api.ts';
import { Button, toast } from '../../components.tsx';
import { useMe, type ChatEvent } from '../../state.tsx';
import { dateTime } from '../../format.ts';

/** Czat z użytkownikiem komputera — okno czatu otwiera się z ikony OVERVNC w zasobniku. */
export function ChatView({ agent }: { agent: Agent }) {
  const { can } = useMe();
  const write = can('agents.remote');
  const [items, setItems] = useState<ChatMessage[] | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const supported = !agent.online || agent.capabilities.includes('chat.send');

  // historia + wiadomości na żywo (nowe i zmiana stanu doręczenia)
  useEffect(() => {
    let alive = true;
    api.chat(agent.id).then(
      (r) => alive && setItems(r.items),
      (e) => alive && (setItems([]), toast(errorMessage(e), 'err')),
    );
    const on = (ev: Event) => {
      const e = (ev as CustomEvent<ChatEvent>).detail;
      if (e.id !== agent.id || e.type !== 'chat_message' || !e.data) return;
      const m = e.data;
      setItems((xs) => {
        if (!xs) return xs;
        const i = xs.findIndex((x) => x.id === m.id);
        return i >= 0 ? xs.map((x) => (x.id === m.id ? m : x)) : [...xs, m];
      });
    };
    window.addEventListener('overvnc:chat', on);
    return () => {
      alive = false;
      window.removeEventListener('overvnc:chat', on);
    };
  }, [agent.id]);

  // widoczne wiadomości od użytkownika = przeczytane
  const unread = items?.some((m) => m.direction === 'in' && !m.readAt) ?? false;
  const lastOut = items?.findLast((m) => m.direction === 'out')?.id;
  useEffect(() => {
    if (!unread) return;
    const mark = () => {
      if (document.visibilityState !== 'visible') return;
      setItems((xs) => xs?.map((m) => (m.direction === 'in' && !m.readAt ? { ...m, readAt: Date.now() } : m)) ?? xs);
      void api.readChat(agent.id).catch(() => {});
    };
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [unread, agent.id]);

  useLayoutEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items?.length]);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    try {
      const m = await api.sendChat(agent.id, t);
      setItems((xs) => (xs && !xs.some((x) => x.id === m.id) ? [...xs, m] : xs));
      setText('');
    } catch (err) {
      toast(errorMessage(err), 'err');
    } finally {
      setSending(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter wysyła, Shift+Enter — nowa linia (na telefonie Enter to nowa linia, wysyła przycisk)
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && matchMedia('(hover: hover)').matches) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <section className="glass-card chat-card anim-rise">
      <div className="chat-list" ref={list}>
        {items === null && <div className="muted small chat-empty">Ładowanie…</div>}
        {items?.length === 0 && (
          <div className="chat-empty">
            <MessageCircle />
            <strong>Brak wiadomości</strong>
            <span className="small muted">
              Użytkownik komputera pisze do wsparcia z ikony OVERVNC w zasobniku (przy zegarze). Możesz też napisać pierwszy — okno czatu otworzy się na jego ekranie.
            </span>
          </div>
        )}
        {items?.map((m, i) => {
          const prev = items[i - 1];
          const head = !prev || prev.direction !== m.direction || prev.author !== m.author || m.ts - prev.ts > 10 * 60_000;
          return (
            <div key={m.id} className={`chat-msg ${m.direction}${head ? ' head' : ''}`}>
              {head && (
                <div className="chat-meta">
                  <strong>{m.author}</strong> · {dateTime(m.ts)}
                </div>
              )}
              <div className="chat-bubble">{m.text}</div>
              {m.direction === 'out' && (m.id === lastOut || !m.deliveredAt) && (
                <div className="chat-state">
                  {m.deliveredAt ? (
                    <>
                      <CheckCheck /> Doręczono
                    </>
                  ) : agent.online ? (
                    <>
                      <Check /> Wysłano
                    </>
                  ) : (
                    <>
                      <Clock /> Doręczę po połączeniu komputera
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {write && supported && (
        <form className="chat-compose" onSubmit={send}>
          <textarea
            className="pole"
            rows={1}
            value={text}
            maxLength={4000}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            placeholder={agent.online ? 'Napisz do użytkownika komputera…' : 'Komputer offline — wiadomość dotrze po połączeniu…'}
            aria-label="Wiadomość"
          />
          <Button variant="primary" icon={Send} loading={sending} disabled={!text.trim()} aria-label="Wyślij" title="Wyślij" />
        </form>
      )}
      {!supported && <p className="small muted chat-note">Czat wymaga agenta w wersji 0.22.0 lub nowszej — zaktualizuj agenta.</p>}
    </section>
  );
}
