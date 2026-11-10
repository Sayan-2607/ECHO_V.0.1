import { randomUUID } from 'node:crypto';
import type { DB } from '../connection.js';
import type { SourceType } from '../../types.js';

export interface Snapshot {
  id: string;
  conversationId: string;
  messageId: string;
  entityId: string;
  entityName: string;
  attribute: string;
  attributeKey: string;
  plan: string | null;
  billingPeriod: string | null;
  unit: string | null;
  region: string | null;
  currency: string | null;
  value: string;
  numericValue: number | null;
  status: string | null;
  quote: string | null;
  sourceUrl: string | null;
  sourceType: SourceType | null;
  observedAt: number;
  sourceDate: string | null;
  confidence: number;
  origin: 'web_evidence' | 'conversation_stated';
}

export type NewSnapshot = Omit<Snapshot, 'id' | 'entityName'>;

interface Row {
  id: string;
  conversation_id: string;
  message_id: string;
  entity_id: string;
  display_name: string;
  attribute: string;
  attribute_key: string;
  plan: string | null;
  billing_period: string | null;
  unit: string | null;
  region: string | null;
  currency: string | null;
  value: string;
  numeric_value: number | null;
  status: string | null;
  quote: string | null;
  source_url: string | null;
  source_type: SourceType | null;
  observed_at: number;
  source_date: string | null;
  confidence: number;
  origin: 'web_evidence' | 'conversation_stated';
}

const toSnapshot = (r: Row): Snapshot => ({
  id: r.id,
  conversationId: r.conversation_id,
  messageId: r.message_id,
  entityId: r.entity_id,
  entityName: r.display_name,
  attribute: r.attribute,
  attributeKey: r.attribute_key,
  plan: r.plan,
  billingPeriod: r.billing_period,
  unit: r.unit,
  region: r.region,
  currency: r.currency,
  value: r.value,
  numericValue: r.numeric_value,
  status: r.status,
  quote: r.quote,
  sourceUrl: r.source_url,
  sourceType: r.source_type,
  observedAt: r.observed_at,
  sourceDate: r.source_date,
  confidence: r.confidence,
  origin: r.origin,
});

export class SnapshotRepository {
  constructor(private db: DB) {}

  insert(s: NewSnapshot): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO research_snapshots (id, conversation_id, message_id, entity_id, attribute, attribute_key, plan, billing_period,
          unit, region, currency, value, numeric_value, status, quote, source_url, source_type, observed_at, source_date, confidence, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, s.conversationId, s.messageId, s.entityId, s.attribute, s.attributeKey, s.plan, s.billingPeriod, s.unit, s.region,
        s.currency, s.value, s.numericValue, s.status, s.quote, s.sourceUrl, s.sourceType, s.observedAt, s.sourceDate, s.confidence, s.origin,
      );
    return id;
  }

  forConversation(conversationId: string): Snapshot[] {
    return (
      this.db
        .prepare(
          `SELECT s.*, e.display_name FROM research_snapshots s JOIN entities e ON e.id = s.entity_id
           WHERE s.conversation_id = ? ORDER BY s.observed_at`,
        )
        .all(conversationId) as Row[]
    ).map(toSnapshot);
  }

  /** Snapshots of the given entities observed before `before` (latest first). */
  forEntitiesBefore(entityIds: string[], before: number): Snapshot[] {
    if (!entityIds.length) return [];
    const ph = entityIds.map(() => '?').join(',');
    return (
      this.db
        .prepare(
          `SELECT s.*, e.display_name FROM research_snapshots s JOIN entities e ON e.id = s.entity_id
           WHERE s.entity_id IN (${ph}) AND s.observed_at < ? ORDER BY s.observed_at DESC LIMIT 200`,
        )
        .all(...entityIds, before) as Row[]
    ).map(toSnapshot);
  }
}
