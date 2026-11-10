import { randomUUID } from 'node:crypto';
import type { DB } from '../connection.js';
import type { Conversation } from '../../types.js';

interface Row {
  id: string;
  title: string;
  timezone: string;
  created_at: number;
  updated_at: number;
}

const toConversation = (r: Row): Conversation => ({
  id: r.id,
  title: r.title,
  timezone: r.timezone,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class ConversationRepository {
  constructor(private db: DB) {}

  create(input: { title: string; timezone: string; now?: number; id?: string }): Conversation {
    const now = input.now ?? Date.now();
    const id = input.id ?? randomUUID();
    this.db
      .prepare('INSERT INTO conversations (id, title, timezone, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, input.title, input.timezone, now, now);
    return { id, title: input.title, timezone: input.timezone, createdAt: now, updatedAt: now };
  }

  get(id: string): Conversation | null {
    const r = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Row | undefined;
    return r ? toConversation(r) : null;
  }

  list(limit = 200): Conversation[] {
    return (this.db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?').all(limit) as Row[]).map(toConversation);
  }

  /** Full-text search over message content; returns conversations ordered by best match. */
  search(query: string, limit = 50): Array<Conversation & { snippet: string }> {
    const fts = toFtsQuery(query);
    if (!fts) return [];
    const rows = this.db
      .prepare(
        `SELECT c.*, snippet(messages_fts, 0, '«', '»', '…', 12) AS snippet, bm25(messages_fts) AS rank
         FROM messages_fts
         JOIN messages m ON m.rowid = messages_fts.rowid
         JOIN conversations c ON c.id = m.conversation_id
         WHERE messages_fts MATCH ?
         ORDER BY rank LIMIT 200`,
      )
      .all(fts) as Array<Row & { snippet: string; rank: number }>;
    const seen = new Map<string, Conversation & { snippet: string }>();
    for (const r of rows) if (!seen.has(r.id)) seen.set(r.id, { ...toConversation(r), snippet: r.snippet });
    // Title matches too
    const titleRows = this.db
      .prepare(`SELECT * FROM conversations WHERE title LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT 50`)
      .all(`%${query.replace(/[\\%_]/g, (c) => '\\' + c)}%`) as Row[];
    for (const r of titleRows) if (!seen.has(r.id)) seen.set(r.id, { ...toConversation(r), snippet: '' });
    return [...seen.values()].slice(0, limit);
  }

  rename(id: string, title: string): Conversation | null {
    const res = this.db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, Date.now(), id);
    return res.changes ? this.get(id) : null;
  }

  touch(id: string, now = Date.now()): void {
    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, id);
  }

  setTimezone(id: string, tz: string): void {
    this.db.prepare('UPDATE conversations SET timezone = ? WHERE id = ?').run(tz, id);
  }

  /** Deletes a conversation and (via ON DELETE CASCADE) all its messages, snapshots, facts, summary and logs. */
  delete(id: string): boolean {
    return this.db.transaction(() => {
      const res = this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
      // Remove entities no longer referenced anywhere.
      this.db.exec(
        `DELETE FROM entities WHERE id NOT IN (SELECT entity_id FROM message_entities)
           AND id NOT IN (SELECT entity_id FROM research_snapshots)`,
      );
      return res.changes > 0;
    })();
  }
}

/** Converts free text into a safe FTS5 OR-query of quoted terms. */
export function toFtsQuery(text: string): string {
  const STOP = new Set(['the', 'and', 'for', 'what', 'did', 'you', 'ask', 'asked', 'about', 'with', 'this', 'that', 'has', 'any', 'have', 'since', 'our', 'was', 'were', 'are', 'is', 'how', 'why', 'when', 'from', 'into', 'your', 'tell', 'me', 'we', 'i', 'a', 'an', 'of', 'to', 'in', 'on', 'it', 'still', 'correct', 'today', 'last', 'changed', 'change']);
  const terms = (text.toLowerCase().match(/[a-z0-9][a-z0-9+.-]*/g) ?? [])
    .map((t) => t.replace(/[.-]+$/, ''))
    .filter((t) => t.length >= 2 && !STOP.has(t));
  const unique = [...new Set(terms)].slice(0, 16);
  return unique.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
}
