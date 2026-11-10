import { randomUUID } from 'node:crypto';
import type { DB } from '../connection.js';
import type { Message, MessageMetadata, MessageStatus, Role } from '../../types.js';
import { toFtsQuery } from './conversations.js';

interface Row {
  id: string;
  conversation_id: string;
  role: Role;
  content: string;
  reply_to: string | null;
  status: MessageStatus;
  created_at: number;
  metadata: string;
}

export const toMessage = (r: Row): Message => ({
  id: r.id,
  conversationId: r.conversation_id,
  role: r.role,
  content: r.content,
  replyTo: r.reply_to,
  status: r.status,
  createdAt: r.created_at,
  metadata: safeJson(r.metadata),
});

function safeJson(s: string): MessageMetadata {
  try {
    return JSON.parse(s) as MessageMetadata;
  } catch {
    return {};
  }
}

export class MessageRepository {
  constructor(private db: DB) {}

  insert(input: {
    conversationId: string;
    role: Role;
    content: string;
    replyTo?: string | null;
    status?: MessageStatus;
    metadata?: MessageMetadata;
    createdAt?: number;
    id?: string;
  }): Message {
    const m: Message = {
      id: input.id ?? randomUUID(),
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      replyTo: input.replyTo ?? null,
      status: input.status ?? 'complete',
      createdAt: input.createdAt ?? Date.now(),
      metadata: input.metadata ?? {},
    };
    this.db
      .prepare(
        'INSERT INTO messages (id, conversation_id, role, content, reply_to, status, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(m.id, m.conversationId, m.role, m.content, m.replyTo, m.status, m.createdAt, JSON.stringify(m.metadata));
    return m;
  }

  get(id: string): Message | null {
    const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined;
    return r ? toMessage(r) : null;
  }

  listByConversation(conversationId: string): Message[] {
    return (
      this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid').all(conversationId) as Row[]
    ).map(toMessage);
  }

  /** Last `limit` messages of a conversation in chronological order, optionally excluding one id. */
  recent(conversationId: string, limit: number, excludeId?: string): Message[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM messages WHERE conversation_id = ? AND id != ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
      )
      .all(conversationId, excludeId ?? '', limit) as Row[];
    return rows.reverse().map(toMessage);
  }

  /** User messages in [start, end), across all conversations, excluding the given conversation's in-flight message. */
  userMessagesInRange(start: number, end: number, excludeMessageId?: string): Message[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM messages WHERE role = 'user' AND created_at >= ? AND created_at < ? AND id != ?
           ORDER BY created_at`,
        )
        .all(start, end, excludeMessageId ?? '') as Row[]
    ).map(toMessage);
  }

  /** Full-text search over messages. Optional restriction to a time range and exclusion of a conversation. */
  searchText(
    text: string,
    opts: { start?: number; end?: number; excludeConversationId?: string; role?: Role; limit?: number } = {},
  ): Array<Message & { rank: number }> {
    const fts = toFtsQuery(text);
    if (!fts) return [];
    const rows = this.db
      .prepare(
        `SELECT m.*, bm25(messages_fts) AS rank FROM messages_fts
         JOIN messages m ON m.rowid = messages_fts.rowid
         WHERE messages_fts MATCH ?
           AND m.created_at >= ? AND m.created_at < ?
           AND m.conversation_id != ?
           AND (? IS NULL OR m.role = ?)
         ORDER BY rank LIMIT ?`,
      )
      .all(
        fts,
        opts.start ?? 0,
        opts.end ?? Number.MAX_SAFE_INTEGER,
        opts.excludeConversationId ?? '',
        opts.role ?? null,
        opts.role ?? null,
        opts.limit ?? 20,
      ) as Array<Row & { rank: number }>;
    return rows.map((r) => ({ ...toMessage(r), rank: r.rank }));
  }

  replyTo(userMessageId: string): Message | null {
    const r = this.db
      .prepare(`SELECT * FROM messages WHERE reply_to = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1`)
      .get(userMessageId) as Row | undefined;
    return r ? toMessage(r) : null;
  }

  /** The most recent conversation (other than `excludeConversationId`) with a message before `before`. */
  previousConversationId(excludeConversationId: string, before: number): string | null {
    const r = this.db
      .prepare(
        `SELECT conversation_id FROM messages WHERE conversation_id != ? AND created_at < ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(excludeConversationId, before) as { conversation_id: string } | undefined;
    return r?.conversation_id ?? null;
  }

  /** Distinct local dates that have user messages — used to suggest alternatives when a date has none. */
  activeDays(limit = 400): number[] {
    return (
      this.db
        .prepare(`SELECT created_at FROM messages WHERE role = 'user' ORDER BY created_at DESC LIMIT ?`)
        .all(limit) as Array<{ created_at: number }>
    ).map((r) => r.created_at);
  }
}
