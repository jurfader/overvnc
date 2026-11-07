import type { Db } from './db.ts';
import type { Hub } from './hub.ts';
import type { Notifier } from './notify.ts';

/** Wiadomość czatu w postaci dla panelu. */
export interface ChatView {
  id: number;
  agentId: string;
  ts: number;
  direction: 'in' | 'out';
  author: string;
  text: string;
  deliveredAt: number | null;
  readAt: number | null;
}

export const CHAT_COLS = 'id, agent_id AS agentId, ts, direction, author, text, delivered_at AS deliveredAt, read_at AS readAt';

/**
 * Czat ze wsparciem: wiadomości od użytkownika komputera (ikona w zasobniku) zapisuje i ogłasza w panelu
 * (plus Pushover); wiadomości wsparcia doręcza od razu albo po połączeniu komputera.
 */
export class ChatService {
  private db: Db;
  private hub: Hub;
  private notifier: Notifier;

  constructor(db: Db, hub: Hub, notifier: Notifier) {
    this.db = db;
    this.hub = hub;
    this.notifier = notifier;
    hub.on('chat', (id, m) => this.incoming(id, m));
    hub.on('ready', (id) => void this.deliverPending(id));
  }

  view(id: number): ChatView {
    return this.db.prepare(`SELECT ${CHAT_COLS} FROM chat_messages WHERE id = ?`).get(id) as unknown as ChatView;
  }

  private incoming(agentId: string, m: { author: string; text: string; ts: number }): void {
    const res = this.db
      .prepare("INSERT INTO chat_messages (agent_id, ts, direction, author, text) VALUES (?, ?, 'in', ?, ?)")
      .run(agentId, Math.min(m.ts, Date.now()), m.author, m.text);
    const msg = this.view(Number(res.lastInsertRowid));
    this.hub.broadcastAgent(agentId, { type: 'chat_message', id: agentId, data: msg });
    const a = this.db.prepare('SELECT hostname, label FROM agents WHERE id = ?').get(agentId) as { hostname: string; label: string } | undefined;
    this.notifier.enqueue({
      title: `${a?.label || a?.hostname || 'Komputer'}: wiadomość (${m.author})`,
      message: m.text.slice(0, 500),
      priority: 0,
      url: this.notifier.machineUrl(agentId),
      urlTitle: 'Odpowiedz w panelu',
    });
  }

  /** Wiadomość wsparcia: zapis i próba doręczenia (komputer offline — po połączeniu). */
  async send(agentId: string, author: string, userId: number, text: string): Promise<ChatView> {
    const res = this.db
      .prepare("INSERT INTO chat_messages (agent_id, ts, direction, author, user_id, text) VALUES (?, ?, 'out', ?, ?, ?)")
      .run(agentId, Date.now(), author, userId, text);
    const id = Number(res.lastInsertRowid);
    await this.deliver(agentId, id);
    const msg = this.view(id);
    this.hub.broadcastAgent(agentId, { type: 'chat_message', id: agentId, data: msg });
    return msg;
  }

  private async deliver(agentId: string, id: number): Promise<boolean> {
    if (!this.hub.isOnline(agentId) || !this.hub.summary(agentId)?.capabilities.includes('chat.send')) return false;
    const m = this.view(id);
    try {
      // usługa agenta przyjęła wiadomość — trafi do okna od razu albo gdy użytkownik je otworzy (historia)
      await this.hub.request(agentId, 'chat.send', { id: m.id, ts: m.ts, author: m.author, text: m.text }, { timeoutMs: 15_000 });
      this.db.prepare('UPDATE chat_messages SET delivered_at = ? WHERE id = ?').run(Date.now(), id);
      return true;
    } catch {
      return false;
    }
  }

  private async deliverPending(agentId: string): Promise<void> {
    const ids = this.db.prepare("SELECT id FROM chat_messages WHERE agent_id = ? AND direction = 'out' AND delivered_at IS NULL ORDER BY id").all(agentId) as { id: number }[];
    for (const { id } of ids) {
      if (await this.deliver(agentId, id)) this.hub.broadcastAgent(agentId, { type: 'chat_message', id: agentId, data: this.view(id) });
    }
  }
}
