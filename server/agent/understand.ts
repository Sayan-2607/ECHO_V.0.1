import type { LLMClient } from '../llm/client.js';
import type { Message } from '../types.js';
import { resolveTimeReferences, type TimeReference } from '../utils/timeResolver.js';
import { truncate } from '../utils/text.js';
import { UNDERSTAND_SYSTEM } from './prompts.js';
import { UnderstandSchema, type UnderstandOutput } from './schemas.js';
import type { Logger } from '../utils/logger.js';

export interface Understanding extends UnderstandOutput {
  timeRefs: TimeReference[];
  now: number;
  timezone: string;
  source: 'llm' | 'heuristic';
}

/** Stage 1 — UNDERSTAND. Dates are resolved deterministically; intent/entities come from the LLM. */
export async function understand(args: {
  llm: LLMClient;
  message: string;
  recentTurns: Message[];
  now: Date;
  timezone: string;
  signal?: AbortSignal;
  logger: Logger;
}): Promise<Understanding> {
  const timeRefs = resolveTimeReferences(args.message, args.now, args.timezone);
  const recent = args.recentTurns
    .slice(-4)
    .map((m) => `${m.role.toUpperCase()}: ${truncate(m.content, 600)}`)
    .join('\n');
  const user = [
    `Current time: ${args.now.toISOString()} (user timezone ${args.timezone}).`,
    timeRefs.length
      ? `Resolved time references (authoritative): ${timeRefs.map((t) => `"${t.expression}" → ${t.label}`).join('; ')}`
      : 'No explicit time references.',
    recent ? `Recent turns in this conversation:\n${recent}` : 'No earlier turns in this conversation.',
    `Latest user message:\n"""${args.message}"""`,
  ].join('\n\n');

  try {
    const out = await args.llm.completeJSON({ stage: 'understand', system: UNDERSTAND_SYSTEM, user, schema: UnderstandSchema, signal: args.signal });
    return reconcile({ ...out, timeRefs, now: args.now.getTime(), timezone: args.timezone, source: 'llm' });
  } catch (err) {
    if (args.signal?.aborted) throw err;
    args.logger.warn('understand: LLM failed, using heuristic fallback', { error: (err as Error).message });
    return heuristicUnderstanding(args.message, timeRefs, args.now.getTime(), args.timezone);
  }
}

/** Deterministic guards on top of the LLM's classification. */
function reconcile(u: Understanding): Understanding {
  if (u.timeRefs.length && !u.referencesPast && (u.intent === 'recall' || u.intent === 'recheck' || u.intent === 'historical_comparison')) {
    u.referencesPast = true;
  }
  if (u.intent === 'recheck' || u.intent === 'historical_comparison') u.needsFreshInfo = true;
  return u;
}

const PAST_RE = /\b(we|you|i)\s+(discussed|talked|shortlisted|decided|asked|said|compared|chose|picked|looked at)\b|\b(earlier|previous|last time|you told me|your (answer|recommendation))\b/i;

export function heuristicUnderstanding(message: string, timeRefs: TimeReference[], now: number, timezone: string): Understanding {
  const m = message.toLowerCase();
  const referencesPast = timeRefs.length > 0 || PAST_RE.test(message);
  const recheck = /\b(still (correct|true|valid|accurate)|is (that|it|your answer) still|re-?check|verify (that|your))\b/.test(m);
  const changed = /\b(changed|updated|any (news|change)|since then|since we|shipped|launched|what's new|anything new)\b/.test(m);
  const recall = /\bwhat did (i|we|you)\b|\bwhat was (i|my)\b|\bremind me\b/.test(m);
  const fresh = /\b(price|pricing|cost|latest|current|today|now|new|release|launch|announce|policy|version)\b/.test(m);
  const intent: Understanding['intent'] = recheck
    ? 'recheck'
    : referencesPast && changed
      ? 'historical_comparison'
      : recall
        ? 'recall'
        : fresh
          ? 'current_facts'
          : /^(hi|hello|hey|thanks|thank you)\b/.test(m)
            ? 'chit_chat'
            : 'general_knowledge';
  const terms = (message.match(/\b[A-Z][a-zA-Z0-9+.]{2,}\b/g) ?? []).filter((t) => !/^(What|Has|Have|Is|On|Last|Since|The|Did|Can|Could|Should|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|November|October|December|January|February|March|April|May|June|July|August|September)$/.test(t));
  return {
    intent,
    entities: [],
    searchTerms: terms,
    referencesPast,
    needsFreshInfo: fresh || recheck || changed,
    comparison: changed || /\bcompare|vs\.?|versus\b/.test(m),
    answerFormat: changed || recheck ? 'report' : 'brief',
    attributesOfInterest: /pric|cost/.test(m) ? ['pricing'] : [],
    expectedEntityCount: Number(m.match(/\b(\d{1,2})\s+(tools|products|providers|options|vendors|crms?|services)\b/)?.[1]) || null,
    timeRefs,
    now,
    timezone,
    source: 'heuristic',
  };
}
