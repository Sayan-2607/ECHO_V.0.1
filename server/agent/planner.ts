import type { LLMClient } from '../llm/client.js';
import type { RetrievedContext } from '../memory/retrieval.js';
import { renderMemory } from '../memory/retrieval.js';
import { canonicalEntityName, sameEntity } from '../utils/entityNames.js';
import { normalizeQuery } from '../search/normalization.js';
import type { Understanding } from './understand.js';
import { PLAN_SYSTEM } from './prompts.js';
import { PlanSchema } from './schemas.js';
import type { Logger } from '../utils/logger.js';

export interface PlannedQuery {
  query: string;
  entity: string | null;
  purpose: string;
}

export interface ResearchPlan {
  needsSearch: boolean;
  rationale: string;
  queries: PlannedQuery[];
  targetEntities: string[];
  timeSensitiveClaims: string[];
  entityCountNote: string | null;
  source: 'llm' | 'rule' | 'fallback';
}

/**
 * Which entities the research is about. For historical questions these come from stored memory
 * (never invented): if the conversation shortlisted items, exactly those; otherwise every entity it discussed.
 */
export function resolveTargetEntities(u: Understanding, ctx: RetrievedContext): { targets: string[]; note: string | null } {
  const fromMessage = u.entities.map((e) => e.name);
  const fromMemory: string[] = [];
  for (const rc of ctx.referenced) {
    const shortlisted = rc.entities.filter((e) => e.relation === 'shortlisted');
    const chosen = shortlisted.length ? shortlisted : rc.entities;
    for (const e of chosen) fromMemory.push(e.displayName);
  }
  // If the user names items that are in memory, research exactly those. Otherwise use what memory
  // holds, plus any additional named companies/products (generic categories like "CRM tools" are not targets).
  const overlap = fromMessage.filter((m) => fromMemory.some((x) => sameEntity(x, m)));
  const extraNamed = u.entities.filter((e) => e.type === 'company' || e.type === 'product').map((e) => e.name);
  const chosen = !fromMemory.length ? fromMessage : overlap.length ? fromMessage : [...fromMemory, ...extraNamed];
  const all: string[] = [];
  for (const name of chosen) if (!all.some((x) => sameEntity(x, name))) all.push(name);
  let note: string | null = null;
  if (u.expectedEntityCount && ctx.referenced.length && fromMemory.length !== u.expectedEntityCount) {
    note = `You mentioned ${u.expectedEntityCount} items, but the stored conversation contains ${fromMemory.length}: ${fromMemory.join(', ') || 'none'}. I used only what is stored.`;
  }
  return { targets: all, note };
}

/** Stage 3/4 — PLAN RESEARCH and DECIDE WHETHER TO SEARCH. */
export async function planResearch(args: {
  llm: LLMClient;
  message: string;
  understanding: Understanding;
  context: RetrievedContext;
  budget: number;
  now: Date;
  signal?: AbortSignal;
  logger: Logger;
}): Promise<ResearchPlan> {
  const u = args.understanding;
  const { targets, note } = resolveTargetEntities(u, args.context);

  // Rule-based decisions that need no model call.
  if (u.intent === 'chit_chat' || u.intent === 'recall') {
    return { needsSearch: false, rationale: u.intent === 'recall' ? 'memory recall only' : 'conversational', queries: [], targetEntities: targets, timeSensitiveClaims: [], entityCountNote: note, source: 'rule' };
  }

  const memory = renderMemory(args.context, u.timezone, 1500);
  const user = [
    `Today: ${args.now.toISOString().slice(0, 10)}. Search budget: at most ${args.budget} queries.`,
    `User message: ${args.message}`,
    `Intent: ${u.intent}; needsFreshInfo: ${u.needsFreshInfo}; attributes: ${u.attributesOfInterest.join(', ') || 'unspecified'}`,
    `Target entities (from the message and stored memory — do not add others): ${targets.join(', ') || 'none identified'}`,
    memory ? `Stored memory:\n${memory}` : 'No stored memory retrieved.',
  ].join('\n\n');

  let out;
  let source: ResearchPlan['source'] = 'llm';
  try {
    out = await args.llm.completeJSON({ stage: 'plan', system: PLAN_SYSTEM, user, schema: PlanSchema, signal: args.signal });
  } catch (err) {
    if (args.signal?.aborted) throw err;
    args.logger.warn('plan: LLM failed, using fallback plan', { error: (err as Error).message });
    source = 'fallback';
    out = { needsSearch: u.needsFreshInfo, rationale: 'fallback plan', queries: [], timeSensitiveClaims: [] };
  }

  let needsSearch = out.needsSearch;
  // Historical comparisons and re-checks of entity facts must consult current evidence.
  if (!needsSearch && (u.intent === 'historical_comparison' || (u.intent === 'recheck' && targets.length > 0))) needsSearch = true;
  if (!needsSearch) {
    return { needsSearch: false, rationale: out.rationale, queries: [], targetEntities: targets, timeSensitiveClaims: out.timeSensitiveClaims, entityCountNote: note, source };
  }
  const queries = allocateQueries(out.queries, targets, args.budget, u.attributesOfInterest, args.now.getFullYear(), args.message);
  return { needsSearch: queries.length > 0, rationale: out.rationale, queries, targetEntities: targets, timeSensitiveClaims: out.timeSensitiveClaims, entityCountNote: note, source };
}

/**
 * Deterministic query allocation under the tool budget:
 *  - one query per target entity (LLM query if it gave one for that entity, else a default);
 *  - duplicates removed; if entities exceed the budget, the remaining entities share the last query
 *    (and are likely to be reported as not verified);
 *  - with spare budget, the LLM's extra queries are kept, leaving at least one call for a gap search when possible.
 */
export function allocateQueries(
  proposed: PlannedQuery[],
  targets: string[],
  budget: number,
  attributes: string[],
  year: number,
  fallbackTopic: string,
): PlannedQuery[] {
  const attr = /pric|cost|plan/i.test(attributes.join(' ')) || attributes.length === 0 ? 'pricing plans' : attributes.slice(0, 2).join(' ');
  const perEntity: PlannedQuery[] = targets.map((t) => {
    const fromLlm = proposed.find((q) => q.entity && sameEntity(q.entity, t));
    return fromLlm ? { ...fromLlm, entity: t } : { query: `${t} ${attr} ${year}`, entity: t, purpose: `current ${attr} for ${t}` };
  });
  let result: PlannedQuery[];
  if (perEntity.length > budget) {
    const own = perEntity.slice(0, Math.max(0, budget - 1));
    const rest = targets.slice(own.length);
    result = [...own, { query: `${rest.join(' vs ')} ${attr} ${year}`, entity: null, purpose: `shared query (budget) for ${rest.join(', ')}` }];
  } else {
    result = [...perEntity];
    const extras = proposed.filter((q) => !q.entity || !targets.some((t) => sameEntity(t, q.entity!)));
    const reserve = targets.length > 0 && result.length + extras.length >= budget ? 1 : 0;
    for (const q of extras) if (result.length < budget - reserve) result.push(q);
    if (!result.length) result.push({ query: fallbackTopic.slice(0, 120), entity: null, purpose: 'answer the question' });
  }
  const seen = new Set<string>();
  return result.filter((q) => {
    const k = normalizeQuery(q.query);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export const entityKey = canonicalEntityName;
