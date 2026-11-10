import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { Repositories } from '../database/repositories/index.js';
import type { LLMClient } from '../llm/client.js';
import type { Logger } from '../utils/logger.js';
import type {
  AgentEvent,
  ChangeRecord,
  Conversation,
  Message,
  MessageMetadata,
  ProposedClaim,
  SearchResponse,
  StageName,
  StageRecord,
  Verdict,
  VerifiedClaim,
} from '../types.js';
import { WebSearchTool, type WebSearchService } from '../search/webSearch.js';
import { understand, type Understanding } from './understand.js';
import { retrieveContext, type RetrievedContext } from '../memory/retrieval.js';
import { planResearch, type ResearchPlan } from './planner.js';
import { collectSources, extractClaims, type SourceDoc } from './evidence.js';
import { verifyClaims } from './verifier.js';
import { detectChanges, verdictFrom } from '../comparison/changeDetector.js';
import { buildCitations, synthesize } from './synthesizer.js';
import { postProcessAnswer } from './postprocess.js';
import { extractAndStoreMemory, persistEvidenceSnapshots } from '../memory/extraction.js';
import { formatInZone, isoDateInZone } from '../utils/timeResolver.js';
import { sameEntity } from '../utils/entityNames.js';
import { extractMoneyAmounts, extractNumbers, truncate } from '../utils/text.js';

export interface OrchestratorDeps {
  repos: Repositories;
  llm: LLMClient;
  search: WebSearchService;
  config: AppConfig;
  logger: Logger;
  clock?: () => Date;
}

export interface RunInput {
  conversationId: string | null;
  message: string;
  timezone?: string;
  requestId: string;
  signal: AbortSignal;
  emit: (e: AgentEvent) => void;
}

export interface RunResult {
  conversation: Conversation;
  userMessage: Message;
  assistantMessage: Message;
  toolCalls: number;
  plan: ResearchPlan | null;
  understanding: Understanding | null;
  context: RetrievedContext | null;
  claims: VerifiedClaim[];
  rejected: number;
  changes: ChangeRecord[];
  verdict: Verdict | null;
}

export class CancelledError extends Error {
  constructor() {
    super('request cancelled');
  }
}

export const isValidTimezone = (tz: string | undefined): tz is string => {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export function titleFrom(message: string): string {
  const clean = message.replace(/\s+/g, ' ').trim();
  if (clean.length <= 60) return clean || 'New conversation';
  const cut = clean.slice(0, 60);
  return cut.slice(0, cut.lastIndexOf(' ') > 30 ? cut.lastIndexOf(' ') : 60) + '…';
}

/**
 * The controlled agent pipeline:
 * UNDERSTAND → RETRIEVE → PLAN → (DECIDE) → SEARCH → EVALUATE → GAPS → (SEARCH AGAIN) → VERIFY → COMPARE → SYNTHESIZE → DELIVER
 * Each stage is a separate module; this class only sequences them, enforces budgets and persists results.
 */
export class Orchestrator {
  constructor(private deps: OrchestratorDeps) {}

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  async run(input: RunInput): Promise<RunResult> {
    const { repos, config } = this.deps;
    const logger = this.deps.logger.child({ requestId: input.requestId });
    const stages: StageRecord[] = [];
    const stage = (s: StageName, status: StageRecord['status'], detail?: string) => {
      const rec: StageRecord = { stage: s, status, detail, at: Date.now() };
      stages.push(rec);
      input.emit({ type: 'stage', stage: rec });
    };
    const checkCancelled = () => {
      if (input.signal.aborted) throw new CancelledError();
    };

    // ── Setup: conversation + user message are persisted first, so nothing is lost on cancel.
    const startedAt = this.now();
    let conversation = input.conversationId ? repos.conversations.get(input.conversationId) : null;
    if (input.conversationId && !conversation) throw new NotFoundError('conversation not found');
    const tz = isValidTimezone(input.timezone) ? input.timezone : conversation?.timezone ?? config.appTimezone;
    const userMessage = repos.db.transaction(() => {
      if (!conversation) conversation = repos.conversations.create({ title: titleFrom(input.message), timezone: tz, now: startedAt.getTime() });
      else if (conversation.timezone !== tz) repos.conversations.setTimezone(conversation.id, tz);
      repos.conversations.touch(conversation.id, startedAt.getTime());
      return repos.messages.insert({ conversationId: conversation.id, role: 'user', content: input.message, createdAt: startedAt.getTime() });
    })();
    const conv = conversation!;
    input.emit({ type: 'conversation', conversation: conv, userMessageId: userMessage.id });

    let streamed = '';
    const result: RunResult = {
      conversation: conv,
      userMessage,
      assistantMessage: undefined as unknown as Message,
      toolCalls: 0,
      plan: null,
      understanding: null,
      context: null,
      claims: [],
      rejected: 0,
      changes: [],
      verdict: null,
    };
    const tool = new WebSearchTool(this.deps.search, config.maxToolCalls, {
      requestId: input.requestId,
      conversationId: conv.id,
      signal: input.signal,
      logger,
      searchLog: repos.searchLog,
    });

    try {
      // ── Disambiguation follow-up ("2") resolves to the original request + chosen question.
      let effectiveMessage = input.message;
      let forced: string[] | undefined;
      const prevAssistant = repos.messages.recent(conv.id, 2, userMessage.id).filter((m) => m.role === 'assistant').at(-1);
      const pick = input.message.trim().match(/^(?:#|number\s+|option\s+)?(\d{1,2})\.?$/i);
      if (prevAssistant?.metadata.disambiguation && pick && prevAssistant.metadata.disambiguationCandidates) {
        const chosen = prevAssistant.metadata.disambiguationCandidates[Number(pick[1]) - 1];
        if (chosen) {
          forced = [chosen];
          effectiveMessage = prevAssistant.metadata.originalRequest ?? input.message;
        }
      }

      // ── 1. UNDERSTAND
      stage('understand', 'start');
      const recentForUnderstanding = repos.messages.recent(conv.id, 4, userMessage.id);
      const u = await understand({ llm: this.deps.llm, message: effectiveMessage, recentTurns: recentForUnderstanding, now: startedAt, timezone: tz, signal: input.signal, logger });
      result.understanding = u;
      stage('understand', 'done', [u.intent.replace('_', ' '), ...u.timeRefs.map((t) => `${t.expression} → ${t.label}`)].join(' · '));
      checkCancelled();

      // ── 2. RETRIEVE CONTEXT
      stage('retrieve', 'start');
      const ctx = retrieveContext({ repos, conversationId: conv.id, currentMessageId: userMessage.id, understanding: u, forcedUserMessageIds: forced });
      result.context = ctx;
      stage(
        'retrieve',
        'done',
        ctx.historical
          ? ctx.needsDisambiguation
            ? `${ctx.candidateQuestions.length} questions found for ${ctx.timeRef?.label}`
            : ctx.referenced.length
              ? `found ${ctx.referenced.map((r) => `"${truncate(r.conversation.title, 40)}" (${formatInZone(r.referenceTime, tz, 'ccc d LLL')})`).join(', ')}`
              : 'no matching stored conversation'
          : `${ctx.recentTurns.length} recent turns`,
      );

      // Deterministic answers that must not be improvised by a model.
      if (ctx.needsDisambiguation) {
        return await this.deliverDeterministic(result, input, stages, tz, disambiguationText(ctx, tz), {
          disambiguation: true,
          disambiguationCandidates: ctx.candidateQuestions.map((c) => c.message.id),
          originalRequest: effectiveMessage,
        });
      }
      if (ctx.historical && !ctx.referenced.length && (u.intent === 'recall' || u.intent === 'recheck')) {
        return await this.deliverDeterministic(result, input, stages, tz, noMemoryText(ctx), { memoryNotes: ctx.notes });
      }

      // ── 3/4. PLAN + DECIDE
      stage('plan', 'start');
      const plan = await planResearch({ llm: this.deps.llm, message: effectiveMessage, understanding: u, context: ctx, budget: config.maxToolCalls, now: startedAt, signal: input.signal, logger });
      result.plan = plan;
      stage('plan', 'done', plan.needsSearch ? `${plan.queries.length} quer${plan.queries.length === 1 ? 'y' : 'ies'} planned` : `no web search needed (${plan.rationale || u.intent})`);
      checkCancelled();

      let sources: SourceDoc[] = [];
      let proposed: ProposedClaim[] = [];
      let claims: VerifiedClaim[] = [];
      let rejectedCount = 0;
      const searchFailures: SearchResponse[] = [];
      const conflicts: string[] = [];
      const runSearches = async (queries: string[]) => {
        // Independent queries run in parallel; the budget is enforced inside the tool.
        const responses = await Promise.all(
          queries.map(async (q) => {
            stage('search', 'start', q);
            const r = await tool.web_search(q);
            input.emit({ type: 'search', query: q, outcome: r.outcome, resultCount: r.results.length, cached: r.cached });
            stage('search', r.outcome === 'ok' || r.outcome === 'empty' ? 'done' : 'error', `${q} — ${r.outcome}${r.cached ? ' (cached)' : ''}, ${r.results.length} results`);
            if (r.outcome !== 'ok' && r.outcome !== 'empty') searchFailures.push(r);
            return r;
          }),
        );
        checkCancelled();
        return responses;
      };
      const evaluate = async (responses: SearchResponse[]) => {
        const before = sources.length;
        sources = collectSources(responses, sources);
        const fresh = sources.slice(before);
        stage('evaluate', 'start', `${fresh.length} new sources`);
        if (fresh.length) {
          const extracted = await extractClaims({
            llm: this.deps.llm,
            sources: fresh,
            targetEntities: plan.targetEntities,
            attributesOfInterest: u.attributesOfInterest,
            baselineHints: ctx.referenced.flatMap((r) => r.snapshots.map((s) => `${s.entityName}: ${s.attribute}${s.plan ? ` / plan ${s.plan}` : ''}${s.billingPeriod ? ` / ${s.billingPeriod}` : ''}${s.unit ? ` / ${s.unit}` : ''}`)).slice(0, 40),
            userQuestion: effectiveMessage,
            now: startedAt,
            signal: input.signal,
          });
          proposed = [...proposed, ...extracted];
        }
        stage('evaluate', 'done', `${proposed.length} candidate claims`);
        checkCancelled();
        // ── 6. VERIFY (all claims across rounds, so contradictions are resolved globally)
        stage('verify', 'start');
        const v = verifyClaims(proposed, sources, { now: startedAt, targetEntities: plan.targetEntities });
        claims = v.accepted;
        rejectedCount = v.rejected.length;
        conflicts.splice(0, conflicts.length, ...v.conflicts.map((c) => `${c.kept.entity}: sources disagree on ${c.kept.plan ?? c.kept.category} (${[c.kept, ...c.others].map((x) => `${x.value} at ${x.sourceDomain}`).join(' vs ')})`));
        for (const r of v.rejected) logger.info('claim rejected', { reason: r.reason, entity: r.claim.entity, sourceId: r.claim.sourceId });
        stage('verify', 'done', `${claims.length} verified, ${v.rejected.length} rejected`);
      };

      if (plan.needsSearch) {
        // ── 5. SEARCH (round 1)
        await evaluate(await runSearches(plan.queries.map((q) => q.query)));

        // ── 7. GAPS → SEARCH AGAIN (sequential: depends on round-1 evidence)
        const missing = plan.targetEntities.filter(
          (t) => !claims.some((c) => sameEntity(c.entity, t)) && !searchFailures.some((f) => f.query.toLowerCase().includes(t.toLowerCase())),
        );
        if (missing.length && tool.remaining > 0) {
          const followups = missing.slice(0, tool.remaining).map((t) => `${t} official pricing page`);
          stage('gaps', 'done', `no verified evidence for ${missing.join(', ')} — searching again`);
          await evaluate(await runSearches(followups));
        } else {
          stage('gaps', missing.length ? 'done' : 'skipped', missing.length ? `no verified evidence for ${missing.join(', ')}; search budget exhausted` : 'no gaps');
        }
      }
      result.toolCalls = tool.callsMade;
      result.claims = claims;
      result.rejected = rejectedCount;

      // ── 8. COMPARE (historical snapshot vs current evidence)
      let changes: ChangeRecord[] = [];
      let verdict: Verdict | null = null;
      const comparing = ctx.referenced.length > 0 && (u.intent === 'historical_comparison' || u.intent === 'recheck' || (u.referencesPast && plan.needsSearch));
      if (comparing) {
        stage('compare', 'start');
        const baseline = ctx.referenced.flatMap((r) => r.snapshots);
        const baselineTime = Math.max(...ctx.referenced.map((r) => r.referenceTime));
        const failedEntities = plan.targetEntities.filter((t) => searchFailures.some((f) => f.query.toLowerCase().includes(t.toLowerCase())));
        changes = detectChanges({ baseline, current: claims, targets: plan.targetEntities, baselineTime, timezone: tz, searchFailedFor: failedEntities });
        if (u.intent === 'recheck') verdict = verdictFrom(changes).verdict;
        const n = changes.filter((c) => !['unchanged', 'not_verified', 'baseline_unavailable'].includes(c.changeType)).length;
        stage('compare', 'done', `${n} change${n === 1 ? '' : 's'} detected across ${changes.length} comparisons${baseline.length ? '' : '; historical baseline unavailable'}`);
        input.emit({ type: 'changes', changes });
      }
      result.changes = changes;
      result.verdict = verdict;

      // ── Gaps & limitations, passed explicitly to the writer.
      const gaps: string[] = [...ctx.notes];
      if (plan.entityCountNote) gaps.push(plan.entityCountNote);
      if (comparing && !ctx.referenced.some((r) => r.snapshots.length)) gaps.push('No prices or plan details were recorded in the earlier conversation, so there is no historical baseline to compare against.');
      for (const f of searchFailures) gaps.push(`Search "${f.query}" failed (${f.outcome.replace('_', ' ')}).`);
      if (plan.needsSearch) {
        const unverified = plan.targetEntities.filter((t) => !claims.some((c) => sameEntity(c.entity, t)));
        if (unverified.length) gaps.push(`No verified current evidence for: ${unverified.join(', ')}.`);
        if (plan.targetEntities.length > config.maxToolCalls) gaps.push(`The search budget (${config.maxToolCalls} calls) is smaller than the number of items (${plan.targetEntities.length}); some items shared one query.`);
      }
      if (rejectedCount) gaps.push(`${rejectedCount} extracted claim(s) were discarded because their cited source did not support them.`);
      gaps.push(...conflicts);
      const flagged = sources.filter((s) => s.injectionFlags.length);
      if (flagged.length) gaps.push(`Ignored instruction-like text found in ${flagged.map((s) => s.result.domain).join(', ')} (treated as untrusted data).`);

      // ── 9. SYNTHESIZE (streamed)
      const { citations, byUrl } = buildCitations(claims, changes);
      if (citations.length) input.emit({ type: 'sources', sources: citations });
      stage('synthesize', 'start');
      let raw: string;
      try {
        raw = await synthesize({
          llm: this.deps.llm,
          message: effectiveMessage,
          now: startedAt,
          timezone: tz,
          timeRefs: u.timeRefs,
          intent: u.intent,
          context: ctx,
          memoryBudget: config.memoryTokenBudget,
          claims,
          changes,
          citationsByUrl: byUrl,
          verdict,
          gaps,
          searched: plan.needsSearch,
          signal: input.signal,
          onToken: (t) => {
            streamed += t;
            input.emit({ type: 'token', text: t });
          },
        });
      } catch (err) {
        if (input.signal.aborted) throw err;
        // The model is unavailable: deliver the verified evidence deterministically instead of failing.
        logger.warn('synthesis failed; delivering deterministic evidence summary', { error: (err as Error).message });
        raw = fallbackAnswer(claims, changes, byUrl, gaps, (err as Error).message);
        stage('synthesize', 'error', 'language model unavailable — showing verified evidence only');
        for (const chunk of raw.match(/[\s\S]{1,80}/g) ?? []) input.emit({ type: 'token', text: chunk });
      }
      if (!stages.some((x) => x.stage === 'synthesize' && x.status === 'error')) stage('synthesize', 'done');
      checkCancelled();

      // ── 10. DELIVER: validate citations/links/amounts, persist atomically.
      const allowedAmounts = groundedAmounts(effectiveMessage, ctx, claims, changes);
      const post = postProcessAnswer(raw, { citationCount: citations.length, allowedUrls: citations.map((c) => c.url), allowedAmounts });
      if (post.removed.length) logger.warn('post-processor removed content', { removed: post.removed });
      stage('persist', 'start');
      const metadata: MessageMetadata = {
        sources: citations,
        changes,
        stages,
        verdict,
        searchQueries: tool.log.map((r) => r.query),
        removedUnsupported: post.removed,
        rejectedClaims: rejectedCount,
        requestId: input.requestId,
        timezone: tz,
      };
      const assistant = repos.db.transaction(() => {
        const m = repos.messages.insert({ conversationId: conv.id, role: 'assistant', content: post.content || raw, replyTo: userMessage.id, metadata, createdAt: Math.max(Date.now(), startedAt.getTime() + 1) });
        persistEvidenceSnapshots(repos, { conversationId: conv.id, messageId: m.id, claims, observedAt: m.createdAt });
        repos.conversations.touch(conv.id, m.createdAt);
        return m;
      })();
      stage('persist', 'done');
      assistant.metadata.stages = stages;
      result.assistantMessage = assistant;
      input.emit({ type: 'final', message: assistant });

      // Structured memory extraction runs after delivery with its own deadline (not the client's signal).
      await extractAndStoreMemory({
        llm: this.deps.llm,
        repos,
        conversationId: conv.id,
        userMessage: forced ? { ...userMessage, content: effectiveMessage } : userMessage,
        assistantMessage: assistant,
        verifiedClaims: claims,
        understoodEntities: u.entities,
        signal: AbortSignal.timeout(30000),
        logger,
      }).catch((e) => logger.warn('extraction error', { error: (e as Error).message }));
      return result;
    } catch (err) {
      result.toolCalls = tool.callsMade;
      const cancelled = err instanceof CancelledError || input.signal.aborted;
      const reason = cancelled ? (input.signal.reason instanceof Error && input.signal.reason.name === 'TimeoutError' ? 'timeout' : 'cancelled') : 'error';
      logger[cancelled ? 'info' : 'error'](`request ${reason}`, { error: (err as Error).message });
      const content = cancelled
        ? streamed
          ? `${streamed}\n\n_(Response ${reason === 'timeout' ? 'timed out' : 'stopped'} before completion.)_`
          : `_(Response ${reason === 'timeout' ? 'timed out' : 'stopped'} before an answer was written.)_`
        : `I couldn't complete this request: ${(err as Error).message}. Nothing was guessed. If this persists, check the model and search configuration in .env.`;
      const assistant = repos.messages.insert({
        conversationId: conv.id,
        role: 'assistant',
        content,
        replyTo: userMessage.id,
        status: cancelled ? 'cancelled' : 'error',
        metadata: { stages, cancelled, error: cancelled ? undefined : (err as Error).message, requestId: input.requestId, timezone: tz },
      });
      repos.conversations.touch(conv.id, assistant.createdAt);
      result.assistantMessage = assistant;
      if (!cancelled) input.emit({ type: 'error', error: (err as Error).message, code: 'agent_error' });
      input.emit({ type: 'final', message: assistant });
      return result;
    }
  }

  private async deliverDeterministic(result: RunResult, input: RunInput, stages: StageRecord[], tz: string, content: string, extra: MessageMetadata): Promise<RunResult> {
    const { repos } = this.deps;
    stages.push({ stage: 'synthesize', status: 'skipped', detail: 'answered from memory without a model', at: Date.now() });
    input.emit({ type: 'stage', stage: stages.at(-1)! });
    for (const chunk of content.match(/[\s\S]{1,80}/g) ?? []) input.emit({ type: 'token', text: chunk });
    const m = repos.db.transaction(() => {
      const msg = repos.messages.insert({
        conversationId: result.conversation.id,
        role: 'assistant',
        content,
        replyTo: result.userMessage.id,
        metadata: { ...extra, stages, requestId: input.requestId, timezone: tz },
        createdAt: Math.max(Date.now(), result.userMessage.createdAt + 1),
      });
      repos.conversations.touch(result.conversation.id, msg.createdAt);
      return msg;
    })();
    result.assistantMessage = m;
    input.emit({ type: 'final', message: m });
    return result;
  }
}

export class NotFoundError extends Error {}

function disambiguationText(ctx: RetrievedContext, tz: string): string {
  const lines = ctx.candidateQuestions.map(
    (c, i) => `${i + 1}. "${truncate(c.message.content.replace(/\s+/g, ' '), 140)}" — ${formatInZone(c.message.createdAt, tz, 'HH:mm')}, in "${truncate(c.conversationTitle, 40)}"`,
  );
  const note = ctx.notes.length ? `\n\n${ctx.notes.join(' ')}` : '';
  return `On ${ctx.timeRef?.label ?? 'that day'} you asked ${ctx.candidateQuestions.length} questions:\n\n${lines.join('\n')}\n\nWhich one do you mean? Reply with its number.${note}`;
}

function noMemoryText(ctx: RetrievedContext): string {
  const where = ctx.timeRef ? `from ${ctx.timeRef.label}` : 'matching that description';
  return `I don't have any stored conversation ${where}, so I can't tell you what was asked or re-check it. ${ctx.notes.filter((n) => !n.startsWith('No stored messages')).join(' ')}`.trim() +
    '\n\nIf it happened in another app or before history was kept, paste the question and I will check it against current sources.';
}

/** Amounts the answer may mention: evidence, stored memory, the user's message, and simple derivations. */
export function groundedAmounts(message: string, ctx: RetrievedContext, claims: VerifiedClaim[], changes: ChangeRecord[]): number[] {
  const amounts = new Set<number>();
  const addText = (s: string | null | undefined) => {
    if (!s) return;
    for (const a of extractMoneyAmounts(s)) amounts.add(a);
  };
  addText(message);
  for (const c of claims) {
    if (c.numericValue !== null && c.numericValue !== undefined) amounts.add(c.numericValue);
    addText(c.value);
    addText(c.quote);
  }
  for (const r of ctx.referenced) {
    for (const s of r.snapshots) if (s.numericValue !== null) amounts.add(s.numericValue);
    for (const ex of r.exchanges) {
      addText(ex.userMessage.content);
      addText(ex.assistantMessage?.content);
    }
  }
  for (const m of ctx.recentTurns) addText(m.content);
  for (const ch of changes) {
    const h = ch.historicalValue ? extractNumbers(ch.historicalValue)[0] : undefined;
    const c = ch.currentValue ? extractNumbers(ch.currentValue)[0] : undefined;
    if (h !== undefined && c !== undefined) amounts.add(Math.abs(Math.round((c - h) * 100) / 100));
  }
  // Totals for team sizes or quantities the user stated, e.g. "20-person team" × per-user price.
  const multipliers = extractNumbers(message).filter((n) => Number.isInteger(n) && n > 1 && n <= 1000);
  for (const base of [...amounts]) for (const k of multipliers) amounts.add(Math.round(base * k * 100) / 100);
  for (const base of [...amounts]) amounts.add(Math.round(base * 12 * 100) / 100); // monthly ↔ annual
  return [...amounts];
}

export const newRequestId = () => randomUUID();

/** Deterministic answer used when the model cannot be reached: verified facts and changes only. */
export function fallbackAnswer(claims: VerifiedClaim[], changes: ChangeRecord[], byUrl: Map<string, number>, gaps: string[], reason: string): string {
  const lines = [`_The language model could not be reached (${reason}), so this is an unwritten summary of verified evidence only._`, ''];
  if (changes.length) {
    lines.push('**What changed**');
    for (const c of changes) {
      const cite = c.currentSource && byUrl.has(c.currentSource) ? ` [${byUrl.get(c.currentSource)}]` : '';
      lines.push(`- ${c.entity} · ${c.attribute}: ${c.changeType.replace(/_/g, ' ')} — before: ${c.historicalValue ?? 'historical baseline unavailable'}; now: ${c.currentValue ?? 'current status not verified'}${cite}`);
    }
  } else if (claims.length) {
    lines.push('**Verified facts**');
    for (const c of claims) lines.push(`- ${c.entity} · ${c.category}${c.plan ? ` · ${c.plan}` : ''}: ${c.value} [${byUrl.get(c.sourceUrl)}]`);
  } else {
    lines.push('No verified evidence was gathered for this question.');
  }
  if (gaps.length) lines.push('', '**Limitations**', ...gaps.map((g) => `- ${g}`));
  return lines.join('\n');
}
export { isoDateInZone };
