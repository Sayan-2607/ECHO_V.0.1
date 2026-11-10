import { openDatabase, type DB } from '../../server/database/connection.js';
import { createApp, type EchoApp } from '../../server/app.js';
import { testConfig, type AppConfig } from '../../server/config.js';
import { silentLogger } from '../../server/utils/logger.js';
import type { Repositories } from '../../server/database/repositories/index.js';
import type { AgentEvent, EntityRelation } from '../../server/types.js';
import { attributeKey } from '../../server/agent/verifier.js';
import { MockSearchProvider, noSleep, ScriptedLLM } from './fakes.js';
import type { LLMClient } from '../../server/llm/client.js';
import type { SearchProvider } from '../../server/search/provider.js';
import { DateTime } from 'luxon';

/** "Now" for all tests: Tue 10 Nov 2026, 20:06 IST. */
export const NOW = new Date('2026-11-10T14:36:00Z');
export const TZ = 'Asia/Kolkata';

export function makeApp(opts: { db?: DB; llm?: LLMClient; search?: SearchProvider; config?: Partial<AppConfig>; now?: Date } = {}): EchoApp & { db: DB } {
  const db = opts.db ?? openDatabase(':memory:');
  const app = createApp({
    config: testConfig(opts.config),
    db,
    llm: opts.llm ?? new ScriptedLLM(),
    searchProvider: opts.search ?? new MockSearchProvider(),
    logger: silentLogger,
    clock: () => opts.now ?? NOW,
    sleep: noSleep,
  });
  return { ...app, db };
}

/** Local wall-clock time in TZ → epoch ms. e.g. at('2026-11-09 11:00') */
export const at = (local: string, tz = TZ) => DateTime.fromFormat(local, 'yyyy-MM-dd HH:mm', { zone: tz }).toMillis();

export interface SeedSnapshot {
  entity: string;
  category: 'price' | 'plan' | 'feature' | 'launch' | 'api' | 'policy' | 'availability' | 'announcement' | 'other';
  plan?: string | null;
  billingPeriod?: 'monthly' | 'annual' | 'one_time' | 'usage' | null;
  unit?: string | null;
  currency?: string | null;
  value: string;
  numericValue?: number | null;
  sourceUrl?: string | null;
}

export interface SeedExchange {
  at: string; // local 'yyyy-MM-dd HH:mm'
  user: string;
  assistant?: string;
  entities?: Array<{ name: string; relation?: EntityRelation; on?: 'user' | 'assistant' }>;
  snapshots?: SeedSnapshot[];
}

/** Writes a past conversation directly to the database (as if ECHO had produced it then). */
export function seedConversation(repos: Repositories, input: { title: string; tz?: string; exchanges: SeedExchange[] }): string {
  const tz = input.tz ?? TZ;
  const first = at(input.exchanges[0]!.at, tz);
  const conv = repos.conversations.create({ title: input.title, timezone: tz, now: first });
  for (const ex of input.exchanges) {
    const t = at(ex.at, tz);
    const um = repos.messages.insert({ conversationId: conv.id, role: 'user', content: ex.user, createdAt: t });
    const am = ex.assistant ? repos.messages.insert({ conversationId: conv.id, role: 'assistant', content: ex.assistant, replyTo: um.id, createdAt: t + 30000 }) : null;
    for (const e of ex.entities ?? []) {
      const ent = repos.entities.upsert(e.name, 'product');
      repos.entities.link(e.on === 'user' || !am ? um.id : am.id, ent.id, e.relation ?? 'mentioned');
    }
    for (const s of ex.snapshots ?? []) {
      if (!am) throw new Error('snapshots need an assistant message');
      const ent = repos.entities.upsert(s.entity, 'product');
      repos.snapshots.insert({
        conversationId: conv.id,
        messageId: am.id,
        entityId: ent.id,
        attribute: s.category,
        attributeKey: attributeKey({ ...s }),
        plan: s.plan ?? null,
        billingPeriod: s.billingPeriod ?? null,
        unit: s.unit ?? null,
        region: null,
        currency: s.currency ?? null,
        value: s.value,
        numericValue: s.numericValue ?? null,
        status: null,
        quote: s.value,
        sourceUrl: s.sourceUrl ?? null,
        sourceType: s.sourceUrl ? 'official_pricing' : null,
        observedAt: am.createdAt,
        sourceDate: null,
        confidence: s.sourceUrl ? 0.92 : 0.6,
        origin: s.sourceUrl ? 'web_evidence' : 'conversation_stated',
      });
    }
    repos.conversations.touch(conv.id, am?.createdAt ?? t);
  }
  return conv.id;
}

/** Runs the orchestrator directly and collects all emitted events. */
export async function runAgent(app: EchoApp, message: string, opts: { conversationId?: string | null; signal?: AbortSignal; timezone?: string } = {}) {
  const events: AgentEvent[] = [];
  const result = await app.orchestrator.run({
    conversationId: opts.conversationId ?? null,
    message,
    timezone: opts.timezone ?? TZ,
    requestId: 'test-' + Math.random().toString(36).slice(2),
    signal: opts.signal ?? new AbortController().signal,
    emit: (e) => events.push(e),
  });
  return { result, events };
}

/** Parses an SSE body into events. */
export function parseSSE(body: string): Array<{ event: string; data: any }> {
  return body
    .split('\n\n')
    .map((block) => {
      const ev = block.match(/^event: (.+)$/m)?.[1];
      const data = block.match(/^data: (.+)$/m)?.[1];
      return ev && data ? { event: ev, data: JSON.parse(data) } : null;
    })
    .filter((x): x is { event: string; data: any } => x !== null);
}
