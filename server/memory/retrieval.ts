import type { Repositories } from '../database/repositories/index.js';
import { dedupeLinked, type LinkedEntity } from '../database/repositories/entities.js';
import type { Snapshot } from '../database/repositories/snapshots.js';
import type { MemoryFact } from '../database/repositories/memory.js';
import type { Conversation, Message } from '../types.js';
import type { TimeReference } from '../utils/timeResolver.js';
import { formatInZone, isoDateInZone } from '../utils/timeResolver.js';
import { estimateTokens, truncate } from '../utils/text.js';
import { canonicalEntityName } from '../utils/entityNames.js';
import type { Understanding } from '../agent/understand.js';

export interface RetrievedExchange {
  userMessage: Message;
  assistantMessage: Message | null;
  matched: boolean;
}

export interface ReferencedConversation {
  conversation: Conversation;
  exchanges: RetrievedExchange[];
  entities: LinkedEntity[];
  snapshots: Snapshot[];
  facts: MemoryFact[];
  summary: string | null;
  referenceTime: number; // when the referenced discussion happened (latest exchange time)
}

export interface RetrievedContext {
  recentTurns: Message[];
  timeRef: TimeReference | null;
  historical: boolean;
  referenced: ReferencedConversation[];
  candidateQuestions: Array<{ message: Message; conversationTitle: string }>;
  needsDisambiguation: boolean;
  notes: string[];
  tokenEstimate: number;
}

const MAX_REFERENCED_CONVERSATIONS = 3;
const MAX_EXCHANGES_PER_CONVERSATION = 4;

/**
 * Stage 2 — RETRIEVE CONTEXT. Targeted retrieval, never the whole history:
 *  - recent turns of the current conversation;
 *  - if the message refers to the past: SQL date-range filter (from the resolved time reference),
 *    narrowed by FTS5 keyword match and entity overlap; or, without a date, FTS + entity search.
 */
export function retrieveContext(args: {
  repos: Repositories;
  conversationId: string;
  currentMessageId: string;
  understanding: Understanding;
  recentLimit?: number;
  forcedUserMessageIds?: string[];
}): RetrievedContext {
  const { repos, conversationId, currentMessageId, understanding: u } = args;
  const recentTurns = repos.messages.recent(conversationId, args.recentLimit ?? 8, currentMessageId);
  const notes: string[] = [];
  const timeRef = u.timeRefs[0] ?? null;
  const historical =
    u.referencesPast || timeRef !== null || u.intent === 'recall' || u.intent === 'recheck' || u.intent === 'historical_comparison';

  const base: RetrievedContext = {
    recentTurns,
    timeRef,
    historical,
    referenced: [],
    candidateQuestions: [],
    needsDisambiguation: false,
    notes,
    tokenEstimate: 0,
  };
  if (!historical) return finalize(base);

  const terms = [...u.searchTerms, ...u.entities.map((e) => e.name)].join(' ');
  let selected: Message[] = []; // user messages selected as the referenced exchanges

  const forced = (args.forcedUserMessageIds ?? []).map((id) => repos.messages.get(id)).filter((m): m is Message => !!m && m.role === 'user');
  if (forced.length) {
    selected = forced;
  } else if (timeRef) {
    let start = timeRef.start;
    let end = timeRef.end;
    if (timeRef.kind === 'since_last') {
      const prev = repos.messages.previousConversationId(conversationId, u.now);
      if (!prev) {
        notes.push('No earlier conversation is stored, so there is no "last time" to compare against.');
        return finalize(base);
      }
      const prevMsgs = repos.messages.listByConversation(prev);
      start = prevMsgs[0]?.createdAt ?? 0;
      end = (prevMsgs.at(-1)?.createdAt ?? 0) + 1;
    }
    const candidates = repos.messages.userMessagesInRange(start, end, currentMessageId).filter((m) => m.id !== currentMessageId);
    base.candidateQuestions = candidates.map((m) => ({
      message: m,
      conversationTitle: repos.conversations.get(m.conversationId)?.title ?? 'Untitled',
    }));
    if (!candidates.length) {
      notes.push(`No stored messages from ${timeRef.label}.`);
      const nearby = nearbyActiveDays(repos, timeRef, u.timezone);
      if (nearby.length) notes.push(`Days with stored conversations near that date: ${nearby.join(', ')}.`);
      return finalize(base);
    }
    const matchedIds = terms.trim() ? matchWithin(repos, candidates, terms, u.entities.map((e) => e.name)) : new Set<string>();
    const matched = candidates.filter((c) => matchedIds.has(c.id));
    if (matched.length) {
      selected = matched;
    } else if (candidates.length === 1) {
      selected = candidates;
    } else {
      // Several questions that day and nothing in the message singles one out → ask the user.
      // If the message names a topic that matched nothing, say so rather than guess.
      if (terms.trim()) notes.push(`None of the ${candidates.length} questions from ${timeRef.label} matched "${terms.trim()}".`);
      base.needsDisambiguation = true;
      return finalize(base);
    }
  } else {
    // No explicit date: keyword + entity search across other conversations.
    const hits = repos.messages.searchText(terms || '', { excludeConversationId: conversationId, limit: 20 });
    const byUserMsg = new Map<string, Message>();
    for (const h of hits) {
      const userMsg = h.role === 'user' ? h : h.replyTo ? repos.messages.get(h.replyTo) : null;
      if (userMsg && !byUserMsg.has(userMsg.id)) byUserMsg.set(userMsg.id, userMsg);
    }
    const entityConvs = repos.entities.conversationsMentioning(u.entities.map((e) => e.name), conversationId);
    for (const ec of entityConvs.slice(0, 2)) {
      for (const m of repos.messages.listByConversation(ec.conversationId)) {
        if (m.role === 'user' && !byUserMsg.has(m.id)) byUserMsg.set(m.id, m);
      }
    }
    selected = [...byUserMsg.values()];
    if (!selected.length) notes.push('No earlier conversation matched this topic.');
  }

  // Group selected exchanges by conversation (most recent first) and attach structured memory.
  const byConv = new Map<string, Message[]>();
  for (const m of selected.sort((a, b) => b.createdAt - a.createdAt)) {
    const arr = byConv.get(m.conversationId) ?? [];
    if (arr.length < MAX_EXCHANGES_PER_CONVERSATION) arr.push(m);
    byConv.set(m.conversationId, arr);
  }
  for (const [convId, userMsgs] of [...byConv.entries()].slice(0, MAX_REFERENCED_CONVERSATIONS)) {
    const conversation = repos.conversations.get(convId);
    if (!conversation) continue;
    const exchanges = userMsgs
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((um) => ({ userMessage: um, assistantMessage: repos.messages.replyTo(um.id), matched: true }));
    const referenceTime = Math.max(...exchanges.map((e) => e.assistantMessage?.createdAt ?? e.userMessage.createdAt));
    base.referenced.push({
      conversation,
      exchanges,
      entities: dedupeLinked(repos.entities.forConversation(convId)),
      snapshots: repos.snapshots.forConversation(convId).filter((s) => s.observedAt <= referenceTime + 1),
      facts: repos.facts.forConversation(convId),
      summary: repos.summaries.get(convId),
      referenceTime,
    });
  }
  return finalize(base);
}

/**
 * Scores the candidate questions of a date range against the topic terms and entities.
 * An exchange (question + stored answer) scores 1 per distinct term found and 2 per linked entity.
 * Only the top-scoring exchanges are returned, so an incidental word match does not pull in
 * an unrelated conversation from the same day.
 */
function matchWithin(repos: Repositories, candidates: Message[], terms: string, entityNames: string[]): Set<string> {
  const termList = [...new Set((terms.toLowerCase().match(/[a-z0-9][a-z0-9+.-]*/g) ?? []).filter((t) => t.length >= 2 && !STOP.has(t)))];
  const canonEntities = new Set(entityNames.map(canonicalEntityName));
  const scores = new Map<string, number>();
  for (const c of candidates) {
    const reply = repos.messages.replyTo(c.id);
    const text = `${c.content}\n${reply?.content ?? ''}`.toLowerCase();
    let score = termList.filter((t) => new RegExp(`\\b${escapeRe(t)}`, 'i').test(text)).length;
    const linked = repos.entities.forMessages([c.id, ...(reply ? [reply.id] : [])]);
    score += 2 * new Set(linked.filter((e) => canonEntities.has(e.canonicalName)).map((e) => e.id)).size;
    if (score > 0) scores.set(c.id, score);
  }
  const best = Math.max(0, ...scores.values());
  return new Set([...scores.entries()].filter(([, s]) => s === best && best > 0).map(([id]) => id));
}

const STOP = new Set(['the', 'and', 'for', 'what', 'did', 'you', 'ask', 'asked', 'about', 'with', 'this', 'that', 'has', 'any', 'have', 'since', 'our', 'was', 'were', 'are', 'how', 'tool', 'tools', 'still', 'today', 'changed']);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function nearbyActiveDays(repos: Repositories, ref: TimeReference, tz: string): string[] {
  const days = new Map<string, number>();
  for (const t of repos.messages.activeDays()) {
    const d = isoDateInZone(t, tz);
    if (!days.has(d)) days.set(d, t);
  }
  const mid = (ref.start + ref.end) / 2;
  return [...days.entries()]
    .sort((a, b) => Math.abs(a[1] - mid) - Math.abs(b[1] - mid))
    .slice(0, 3)
    .map(([, t]) => formatInZone(t, tz, 'ccc d LLL yyyy'));
}

function finalize(ctx: RetrievedContext): RetrievedContext {
  ctx.tokenEstimate = estimateTokens(renderMemory(ctx, 'UTC', Number.MAX_SAFE_INTEGER));
  return ctx;
}

/**
 * Renders retrieved memory as prompt text within a token budget. Priority:
 * referenced exchanges > structured memory (entities, snapshots, facts) > summaries > recent turns.
 */
export function renderMemory(ctx: RetrievedContext, tz: string, tokenBudget: number): string {
  const parts: string[] = [];
  let used = 0;
  const add = (s: string) => {
    const t = estimateTokens(s);
    if (used + t > tokenBudget) {
      const remaining = Math.max(0, (tokenBudget - used) * 4);
      if (remaining > 200) {
        parts.push(truncate(s, remaining));
        used = tokenBudget;
      }
      return false;
    }
    parts.push(s);
    used += t;
    return true;
  };

  for (const rc of ctx.referenced) {
    add(`### Stored conversation "${rc.conversation.title}" (id ${rc.conversation.id})`);
    for (const ex of rc.exchanges) {
      add(`[${formatInZone(ex.userMessage.createdAt, tz)}] USER asked: ${truncate(ex.userMessage.content, 1200)}`);
      if (ex.assistantMessage) {
        add(`[${formatInZone(ex.assistantMessage.createdAt, tz)}] ECHO answered: ${truncate(ex.assistantMessage.content, 2400)}`);
      } else {
        add('ECHO answered: (no stored answer for this question)');
      }
    }
    if (rc.entities.length) add(`Entities in that conversation: ${rc.entities.map((e) => `${e.displayName} (${e.relation})`).join(', ')}`);
    const stated = rc.facts.filter((f) => f.certainty === 'stated');
    if (stated.length) add(`User-stated facts: ${stated.map((f) => `${f.kind}: ${f.content}`).join(' | ')}`);
    if (rc.snapshots.length) {
      add(
        'Recorded values at that time:\n' +
          rc.snapshots
            .map(
              (s) =>
                `- ${s.entityName} · ${s.attribute}${s.plan ? ` · ${s.plan}` : ''}${s.billingPeriod ? ` · ${s.billingPeriod}` : ''}: ${s.value} (observed ${isoDateInZone(s.observedAt, tz)}, ${s.origin === 'web_evidence' ? `source ${s.sourceUrl}` : 'stated in conversation'})`,
            )
            .join('\n'),
      );
    } else {
      add('Recorded values at that time: none were recorded.');
    }
    if (rc.summary) add(`Conversation summary: ${rc.summary}`);
  }
  if (ctx.recentTurns.length) {
    add('### Recent turns in the current conversation');
    for (const m of ctx.recentTurns.slice(-6)) add(`${m.role.toUpperCase()}: ${truncate(m.content, 800)}`);
  }
  for (const n of ctx.notes) add(`NOTE: ${n}`);
  return parts.join('\n');
}
