import type { LLMClient } from '../llm/client.js';
import type { Repositories } from '../database/repositories/index.js';
import type { Message, VerifiedClaim } from '../types.js';
import { EXTRACT_SYSTEM } from '../agent/prompts.js';
import { ExtractionSchema, type ExtractionOutput } from '../agent/schemas.js';
import { attributeKey } from '../agent/verifier.js';
import { containsNormalized, extractNumbers, nearlyEqual, truncate } from '../utils/text.js';
import type { Logger } from '../utils/logger.js';

/**
 * Persists verified web evidence as research snapshots (the future historical baseline).
 * Runs inside the caller's transaction.
 */
export function persistEvidenceSnapshots(repos: Repositories, args: { conversationId: string; messageId: string; claims: VerifiedClaim[]; observedAt: number }): number {
  let n = 0;
  for (const c of args.claims) {
    const entity = repos.entities.upsert(c.entity, 'product');
    repos.entities.link(args.messageId, entity.id, 'researched');
    repos.snapshots.insert({
      conversationId: args.conversationId,
      messageId: args.messageId,
      entityId: entity.id,
      attribute: c.category,
      attributeKey: c.attributeKey,
      plan: c.plan ?? null,
      billingPeriod: c.billingPeriod ?? null,
      unit: c.unit ?? null,
      region: c.region ?? null,
      currency: c.currency ?? null,
      value: c.value,
      numericValue: c.numericValue ?? null,
      status: c.status ?? null,
      quote: c.quote,
      sourceUrl: c.sourceUrl,
      sourceType: c.sourceType,
      observedAt: args.observedAt,
      sourceDate: c.eventDate ?? c.sourceDate,
      confidence: c.confidence,
      origin: 'web_evidence',
    });
    n++;
  }
  return n;
}

export interface ExtractionStats {
  entities: number;
  facts: number;
  statedValues: number;
  droppedUngrounded: number;
}

/**
 * Structured memory extraction after an exchange. Every extracted item must be grounded:
 * its evidenceText must occur in the message it claims to come from, otherwise it is dropped.
 * Facts the model marks "stated" but which come from the assistant are downgraded to "inferred".
 */
export async function extractAndStoreMemory(args: {
  llm: LLMClient;
  repos: Repositories;
  conversationId: string;
  userMessage: Message;
  assistantMessage: Message;
  verifiedClaims: VerifiedClaim[];
  understoodEntities: Array<{ name: string; type: string }>;
  signal?: AbortSignal;
  logger: Logger;
}): Promise<ExtractionStats> {
  const { repos, userMessage: um, assistantMessage: am } = args;
  // Entities named by the user (from UNDERSTAND) are linked immediately and deterministically.
  repos.db.transaction(() => {
    for (const e of args.understoodEntities) {
      if (!containsNormalized(um.content, e.name)) continue;
      const ent = repos.entities.upsert(e.name, e.type);
      repos.entities.link(um.id, ent.id, 'mentioned');
    }
  })();

  let out: ExtractionOutput;
  try {
    const prev = repos.summaries.get(args.conversationId);
    out = await args.llm.completeJSON({
      stage: 'extract',
      system: EXTRACT_SYSTEM,
      user: [
        `Previous summary: ${prev ?? '(none)'}`,
        `USER MESSAGE:\n${truncate(um.content, 4000)}`,
        `ASSISTANT ANSWER:\n${truncate(am.content, 8000)}`,
      ].join('\n\n'),
      schema: ExtractionSchema,
      signal: args.signal,
    });
  } catch (err) {
    args.logger.warn('memory extraction failed; raw messages are still stored', { error: (err as Error).message });
    return { entities: 0, facts: 0, statedValues: 0, droppedUngrounded: 0 };
  }

  const stats: ExtractionStats = { entities: 0, facts: 0, statedValues: 0, droppedUngrounded: 0 };
  const msgFor = (role: 'user' | 'assistant') => (role === 'user' ? um : am);
  repos.db.transaction(() => {
    if (out.summary.trim()) repos.summaries.upsert(args.conversationId, out.summary.trim(), am.createdAt);

    for (const e of out.entities) {
      const msg = msgFor(e.sourceRole);
      if (!containsNormalized(msg.content, e.name) && !containsNormalized(msg.content, e.name.split(' ')[0] ?? e.name)) {
        stats.droppedUngrounded++;
        continue;
      }
      const ent = repos.entities.upsert(e.name, e.type);
      repos.entities.link(msg.id, ent.id, e.relation);
      stats.entities++;
    }

    for (const f of out.facts) {
      const msg = msgFor(f.sourceRole);
      if (!containsNormalized(msg.content, f.evidenceText)) {
        stats.droppedUngrounded++;
        continue;
      }
      const certainty = f.sourceRole === 'user' ? f.certainty : 'inferred';
      repos.facts.insert({ conversationId: args.conversationId, messageId: msg.id, kind: f.kind, content: f.content, certainty, createdAt: msg.createdAt });
      stats.facts++;
    }

    for (const v of out.statedValues) {
      const msg = msgFor(v.sourceRole);
      if (!containsNormalized(msg.content, v.evidenceText)) {
        stats.droppedUngrounded++;
        continue;
      }
      const num = v.numericValue ?? extractNumbers(v.value)[0] ?? null;
      if (v.category === 'price' && (num === null || !extractNumbers(v.evidenceText).some((x) => nearlyEqual(x, num)))) {
        stats.droppedUngrounded++;
        continue;
      }
      const key = attributeKey({ ...v, category: v.category });
      // Skip values already stored as verified web evidence for this message.
      if (args.verifiedClaims.some((c) => c.attributeKey === key && (c.numericValue === num || c.value === v.value))) continue;
      const ent = repos.entities.upsert(v.entity, 'product');
      repos.entities.link(msg.id, ent.id, 'mentioned');
      repos.snapshots.insert({
        conversationId: args.conversationId,
        messageId: msg.id,
        entityId: ent.id,
        attribute: v.category,
        attributeKey: key,
        plan: v.plan,
        billingPeriod: v.billingPeriod,
        unit: v.unit,
        region: v.region,
        currency: v.currency,
        value: v.value,
        numericValue: num,
        status: null,
        quote: v.evidenceText,
        sourceUrl: null,
        sourceType: null,
        observedAt: msg.createdAt,
        sourceDate: null,
        confidence: v.sourceRole === 'user' ? 0.6 : 0.5,
        origin: 'conversation_stated',
      });
      stats.statedValues++;
    }
  })();
  return stats;
}
