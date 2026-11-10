import { randomUUID } from 'node:crypto';
import type { DB } from '../connection.js';
import type { Entity, EntityRelation } from '../../types.js';
import { canonicalEntityName } from '../../utils/entityNames.js';

interface Row {
  id: string;
  canonical_name: string;
  display_name: string;
  entity_type: string;
}
const toEntity = (r: Row): Entity => ({
  id: r.id,
  canonicalName: r.canonical_name,
  displayName: r.display_name,
  entityType: r.entity_type,
});

export interface LinkedEntity extends Entity {
  relation: EntityRelation;
  messageId: string;
}

const RELATION_RANK: Record<EntityRelation, number> = { shortlisted: 4, decided: 3, researched: 2, mentioned: 1 };

export class EntityRepository {
  constructor(private db: DB) {}

  upsert(name: string, type = 'other'): Entity {
    const canonical = canonicalEntityName(name);
    const existing = this.db.prepare('SELECT * FROM entities WHERE canonical_name = ?').get(canonical) as Row | undefined;
    if (existing) {
      if (existing.entity_type === 'other' && type !== 'other') {
        this.db.prepare('UPDATE entities SET entity_type = ? WHERE id = ?').run(type, existing.id);
        existing.entity_type = type;
      }
      return toEntity(existing);
    }
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO entities (id, canonical_name, display_name, entity_type) VALUES (?, ?, ?, ?)')
      .run(id, canonical, name.trim(), type);
    return { id, canonicalName: canonical, displayName: name.trim(), entityType: type };
  }

  findByName(name: string): Entity | null {
    const r = this.db.prepare('SELECT * FROM entities WHERE canonical_name = ?').get(canonicalEntityName(name)) as Row | undefined;
    return r ? toEntity(r) : null;
  }

  /** Links an entity to a message; keeps the strongest relation if linked twice. */
  link(messageId: string, entityId: string, relation: EntityRelation = 'mentioned'): void {
    const cur = this.db
      .prepare('SELECT relation FROM message_entities WHERE message_id = ? AND entity_id = ?')
      .get(messageId, entityId) as { relation: EntityRelation } | undefined;
    if (!cur) {
      this.db.prepare('INSERT INTO message_entities (message_id, entity_id, relation) VALUES (?, ?, ?)').run(messageId, entityId, relation);
    } else if (RELATION_RANK[relation] > RELATION_RANK[cur.relation]) {
      this.db.prepare('UPDATE message_entities SET relation = ? WHERE message_id = ? AND entity_id = ?').run(relation, messageId, entityId);
    }
  }

  forMessages(messageIds: string[]): LinkedEntity[] {
    if (!messageIds.length) return [];
    const ph = messageIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT e.*, me.relation, me.message_id FROM message_entities me JOIN entities e ON e.id = me.entity_id
         WHERE me.message_id IN (${ph})`,
      )
      .all(...messageIds) as Array<Row & { relation: EntityRelation; message_id: string }>;
    return rows.map((r) => ({ ...toEntity(r), relation: r.relation, messageId: r.message_id }));
  }

  forConversation(conversationId: string): LinkedEntity[] {
    const rows = this.db
      .prepare(
        `SELECT e.*, me.relation, me.message_id FROM message_entities me
         JOIN entities e ON e.id = me.entity_id
         JOIN messages m ON m.id = me.message_id
         WHERE m.conversation_id = ? ORDER BY m.created_at, me.rowid`,
      )
      .all(conversationId) as Array<Row & { relation: EntityRelation; message_id: string }>;
    return rows.map((r) => ({ ...toEntity(r), relation: r.relation, messageId: r.message_id }));
  }

  /** Conversations (other than `exclude`) that mention any of the given entity names. */
  conversationsMentioning(names: string[], exclude: string): Array<{ conversationId: string; hits: number; lastAt: number }> {
    const canon = [...new Set(names.map(canonicalEntityName).filter(Boolean))];
    if (!canon.length) return [];
    const ph = canon.map(() => '?').join(',');
    return this.db
      .prepare(
        `SELECT m.conversation_id AS conversationId, COUNT(DISTINCT e.id) AS hits, MAX(m.created_at) AS lastAt
         FROM entities e JOIN message_entities me ON me.entity_id = e.id JOIN messages m ON m.id = me.message_id
         WHERE e.canonical_name IN (${ph}) AND m.conversation_id != ?
         GROUP BY m.conversation_id ORDER BY hits DESC, lastAt DESC LIMIT 10`,
      )
      .all(...canon, exclude) as Array<{ conversationId: string; hits: number; lastAt: number }>;
  }
}

/** Collapses duplicate links into one entry per entity, keeping the strongest relation. */
export function dedupeLinked(xs: LinkedEntity[]): LinkedEntity[] {
  const by = new Map<string, LinkedEntity>();
  for (const e of xs) {
    const cur = by.get(e.id);
    if (!cur || RELATION_RANK[e.relation] > RELATION_RANK[cur.relation]) by.set(e.id, e);
  }
  return [...by.values()];
}
