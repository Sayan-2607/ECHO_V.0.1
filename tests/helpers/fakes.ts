import type { z } from 'zod';
import type { LLMClient } from '../../server/llm/client.js';
import type { RawSearchResult } from '../../server/search/normalization.js';
import { SearchProviderError, type SearchProvider } from '../../server/search/provider.js';
import { heuristicUnderstanding } from '../../server/agent/understand.js';
import { resolveTimeReferences } from '../../server/utils/timeResolver.js';
import { normalizeUrl } from '../../server/search/normalization.js';

/**
 * Deterministic stand-ins for the LLM and the search provider.
 * They let the full pipeline (retrieval, budgets, verification, change detection, persistence,
 * streaming, cancellation) run without network access. They do NOT measure model quality.
 */

export interface FixtureClaim {
  url: string; // which search result supports it (mapped to S<n> at extraction time)
  entity: string;
  category: 'price' | 'plan' | 'feature' | 'launch' | 'api' | 'policy' | 'availability' | 'announcement' | 'other';
  plan?: string | null;
  billingPeriod?: 'monthly' | 'annual' | 'one_time' | 'usage' | null;
  unit?: string | null;
  region?: string | null;
  value: string;
  numericValue?: number | null;
  currency?: string | null;
  quote: string;
  eventDate?: string | null;
  status?: 'released' | 'announced' | 'beta' | 'deprecated' | 'removed' | 'available' | null;
  direct?: boolean;
}

type Handler = (args: { system: string; user: string }) => unknown | Promise<unknown>;

export interface ScriptedLLMOptions {
  understand?: Record<string, unknown> | Handler;
  plan?: Record<string, unknown> | Handler;
  claims?: FixtureClaim[];
  extract?: Record<string, unknown> | Handler;
  synthesize?: string | ((user: string) => string);
  tokenDelayMs?: number;
  failStages?: string[];
}

export class ScriptedLLM implements LLMClient {
  calls: Array<{ stage: string; user: string }> = [];
  constructor(private o: ScriptedLLMOptions = {}) {}

  async completeJSON<T>(args: { stage: string; system: string; user: string; schema: z.ZodType<T>; signal?: AbortSignal }): Promise<T> {
    this.calls.push({ stage: args.stage, user: args.user });
    if (args.signal?.aborted) throw new Error('aborted');
    if (this.o.failStages?.includes(args.stage)) throw new Error(`scripted failure in ${args.stage}`);
    let out: unknown;
    switch (args.stage) {
      case 'understand':
        out = await resolve(this.o.understand, args, () => defaultUnderstand(args.user));
        break;
      case 'plan':
        out = await resolve(this.o.plan, args, () => defaultPlan(args.user));
        break;
      case 'evidence':
        out = { claims: mapClaims(this.o.claims ?? [], args.user) };
        break;
      case 'extract':
        out = await resolve(this.o.extract, args, () => ({ summary: '', entities: [], facts: [], statedValues: [] }));
        break;
      default:
        throw new Error(`unexpected stage ${args.stage}`);
    }
    return args.schema.parse(out);
  }

  async streamText(args: { stage: string; system: string; user: string; signal?: AbortSignal; onToken: (t: string) => void }): Promise<string> {
    this.calls.push({ stage: args.stage, user: args.user });
    const text = typeof this.o.synthesize === 'function' ? this.o.synthesize(args.user) : this.o.synthesize ?? templateAnswer(args.user);
    let out = '';
    for (const tok of text.match(/\S+\s*/g) ?? []) {
      if (args.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (this.o.tokenDelayMs) await new Promise((r) => setTimeout(r, this.o.tokenDelayMs));
      out += tok;
      args.onToken(tok);
    }
    return out;
  }

  stageCount(stage: string): number {
    return this.calls.filter((c) => c.stage === stage).length;
  }
}

async function resolve(v: Record<string, unknown> | Handler | undefined, args: { system: string; user: string }, dflt: () => unknown) {
  if (!v) return dflt();
  return typeof v === 'function' ? v(args) : v;
}

function latestMessage(user: string): string {
  return user.match(/Latest user message:\n"""([\s\S]*?)"""/)?.[1] ?? user;
}

/** Default UNDERSTAND: the rule-based heuristic (deterministic). */
function defaultUnderstand(user: string) {
  const msg = latestMessage(user);
  const now = new Date(user.match(/Current time: (\S+)/)?.[1] ?? Date.now());
  const tz = user.match(/user timezone ([^)\s]+)\)/)?.[1] ?? 'UTC';
  const h = heuristicUnderstanding(msg, resolveTimeReferences(msg, now, tz), now.getTime(), tz);
  const { timeRefs: _t, now: _n, timezone: _z, source: _s, ...rest } = h;
  return rest;
}

/** Default PLAN: search when told fresh info is needed, one query per target entity. */
function defaultPlan(user: string) {
  const needs = /needsFreshInfo: true/.test(user);
  const targets = user.match(/Target entities[^:]*: (.*)/)?.[1] ?? '';
  const ents = targets.includes('none identified') ? [] : targets.split(',').map((s) => s.trim()).filter(Boolean);
  return {
    needsSearch: needs,
    rationale: needs ? 'fresh facts required' : 'no fresh facts required',
    queries: ents.map((e) => ({ query: `${e} pricing 2026`, entity: e, purpose: 'pricing' })),
    timeSensitiveClaims: [],
  };
}

/** Maps fixture claims (keyed by URL) to the S-ids actually shown in the prompt. Unknown URLs keep a bogus id. */
function mapClaims(claims: FixtureClaim[], user: string) {
  const ids = new Map<string, string>();
  for (const m of user.matchAll(/<untrusted_source id="(S\d+)" url="([^"]+)"/g)) ids.set(normalizeUrl(m[2]!), m[1]!);
  return claims
    .filter((c) => ids.has(normalizeUrl(c.url)) || c.url.startsWith('bogus:'))
    .map(({ url, ...c }) => ({ direct: true, ...c, sourceId: ids.get(normalizeUrl(url)) ?? 'S99' }));
}

/** Writes a plain answer from the EVIDENCE/CHANGES sections of the synthesis prompt. */
export function templateAnswer(user: string): string {
  const ev = user.split('EVIDENCE (verified; cite with [n]):\n')[1]?.split('\n\nCHANGES')[0] ?? '';
  const lines: string[] = [];
  let current = 0;
  for (const l of ev.split('\n')) {
    const head = l.match(/^\[(\d+)\]/);
    if (head) current = Number(head[1]);
    const claim = l.match(/^\s+- (.+?): (.+?)(?: \[status.*| \[date.*| \(confidence.*)$/);
    if (claim && current) lines.push(`- ${claim[1]}: ${claim[2]} [${current}]`);
  }
  const verdict = user.match(/VERDICT computed from the changes: ([a-z ]+)\./)?.[1];
  return [verdict ? `**Direct answer** Your earlier answer is ${verdict}.` : '**Direct answer**', ...lines, lines.length ? '' : 'No verified current evidence was found.'].join('\n');
}

// ── Search provider fake ──────────────────────────────────────────────────

export type SearchBehaviour =
  | { kind: 'results'; results: RawSearchResult[] }
  | { kind: 'error'; error: SearchProviderError }
  | { kind: 'hang' }; // never resolves until aborted (timeout simulation)

export class MockSearchProvider implements SearchProvider {
  readonly name = 'mock';
  calls: string[] = [];
  constructor(private route: (query: string, callIndex: number) => SearchBehaviour = () => ({ kind: 'results', results: [] })) {}

  async search(query: string, opts: { maxResults: number; signal: AbortSignal }): Promise<RawSearchResult[]> {
    const idx = this.calls.length;
    this.calls.push(query);
    const b = this.route(query, idx);
    if (b.kind === 'results') return b.results;
    if (b.kind === 'error') throw b.error;
    return new Promise((_res, rej) => {
      opts.signal.addEventListener('abort', () => rej(opts.signal.reason ?? new SearchProviderError('aborted', 'cancelled')), { once: true });
    });
  }
}

/** Route searches by keyword: the first key contained in the (lowercased) query wins. */
export function routeByKeyword(table: Record<string, RawSearchResult[]>): (q: string) => SearchBehaviour {
  return (q) => {
    const lower = q.toLowerCase();
    const key = Object.keys(table).find((k) => lower.includes(k.toLowerCase()));
    return { kind: 'results', results: key ? table[key]! : [] };
  };
}

export const noSleep = async () => {};
