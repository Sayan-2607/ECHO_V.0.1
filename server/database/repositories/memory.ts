import { randomUUID } from 'node:crypto';
import type { DB } from '../connection.js';

export interface MemoryFact {
  id: string;
  conversationId: string;
  messageId: string;
  kind: string;
  content: string;
  certainty: 'stated' | 'inferred';
  createdAt: number;
}

interface FactRow {
  id: string;
  conversation_id: string;
  message_id: string;
  kind: string;
  content: string;
  certainty: 'stated' | 'inferred';
  created_at: number;
}

export class FactRepository {
  constructor(private db: DB) {}

  insert(f: Omit<MemoryFact, 'id'>): string {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO memory_facts (id, conversation_id, message_id, kind, content, certainty, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, f.conversationId, f.messageId, f.kind, f.content, f.certainty, f.createdAt);
    return id;
  }

  forConversation(conversationId: string): MemoryFact[] {
    return (
      this.db.prepare('SELECT * FROM memory_facts WHERE conversation_id = ? ORDER BY created_at').all(conversationId) as FactRow[]
    ).map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      messageId: r.message_id,
      kind: r.kind,
      content: r.content,
      certainty: r.certainty,
      createdAt: r.created_at,
    }));
  }
}

export class SummaryRepository {
  constructor(private db: DB) {}

  upsert(conversationId: string, summary: string, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO conversation_summaries (id, conversation_id, summary, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at`,
      )
      .run(randomUUID(), conversationId, summary, now);
  }

  get(conversationId: string): string | null {
    const r = this.db.prepare('SELECT summary FROM conversation_summaries WHERE conversation_id = ?').get(conversationId) as
      | { summary: string }
      | undefined;
    return r?.summary ?? null;
  }
}

export class SearchLogRepository {
  constructor(private db: DB) {}

  insert(e: {
    requestId: string;
    conversationId: string | null;
    query: string;
    outcome: string;
    resultCount: number;
    cached: boolean;
    attempts: number;
    durationMs: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO search_log (id, request_id, conversation_id, query, outcome, result_count, cached, attempts, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), e.requestId, e.conversationId, e.query, e.outcome, e.resultCount, e.cached ? 1 : 0, e.attempts, e.durationMs, Date.now());
  }

  forRequest(requestId: string): Array<{ query: string; outcome: string; cached: number }> {
    return this.db.prepare('SELECT query, outcome, cached FROM search_log WHERE request_id = ?').all(requestId) as Array<{
      query: string;
      outcome: string;
      cached: number;
    }>;
  }
}
