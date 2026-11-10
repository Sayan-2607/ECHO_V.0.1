import type { Logger } from '../utils/logger.js';
import type { SearchResponse, SearchResult } from '../types.js';
import type { SearchCache } from './cache.js';
import { normalizeQuery, normalizeResults } from './normalization.js';
import { SearchProviderError, type SearchProvider } from './provider.js';
import type { SearchLogRepository } from '../database/repositories/memory.js';

export interface WebSearchOptions {
  timeoutMs: number;
  maxRetries: number;
  maxResults: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

export const abortableSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new SearchProviderError('aborted', 'cancelled'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new SearchProviderError('aborted', 'cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Shared (process-wide) search service: provider calls with timeout, bounded exponential
 * backoff for transient failures only, a short-lived cache and in-flight deduplication.
 */
export class WebSearchService {
  private inflight = new Map<string, Promise<SearchResponse>>();

  constructor(
    private provider: SearchProvider,
    private cache: SearchCache,
    private opts: WebSearchOptions,
    private logger: Logger,
    private sleep: (ms: number, signal?: AbortSignal) => Promise<void> = abortableSleep,
  ) {}

  async search(query: string, signal: AbortSignal): Promise<SearchResponse> {
    const key = normalizeQuery(query);
    const cached = this.cache.get(key);
    if (cached) return { query, outcome: cached.length ? 'ok' : 'empty', results: cached, cached: true, attempts: 0, durationMs: 0 };

    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = this.execute(query, signal).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async execute(query: string, signal: AbortSignal): Promise<SearchResponse> {
    const started = Date.now();
    const base = this.opts.baseBackoffMs ?? 400;
    const cap = this.opts.maxBackoffMs ?? 4000;
    let attempts = 0;
    let lastErr: SearchProviderError | null = null;

    while (attempts <= this.opts.maxRetries) {
      attempts++;
      if (signal.aborted) return this.fail(query, 'cancelled', 'request cancelled', attempts - 1, started);
      const ctrl = new AbortController();
      const timer = setTimeout(
        () => ctrl.abort(new SearchProviderError(`search timed out after ${this.opts.timeoutMs}ms`, 'timeout')),
        this.opts.timeoutMs,
      );
      const onAbort = () => ctrl.abort(new SearchProviderError('request cancelled', 'cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        const raw = await raceAbort(this.provider.search(query, { maxResults: this.opts.maxResults, signal: ctrl.signal }), ctrl.signal);
        const results: SearchResult[] = normalizeResults(raw, this.opts.maxResults, Date.now());
        this.cache.set(normalizeQuery(query), results);
        return { query, outcome: results.length ? 'ok' : 'empty', results, cached: false, attempts, durationMs: Date.now() - started };
      } catch (e) {
        const err = e instanceof SearchProviderError ? e : new SearchProviderError((e as Error).message ?? 'unknown error', 'network');
        lastErr = err;
        if (err.kind === 'cancelled' || signal.aborted) return this.fail(query, 'cancelled', 'request cancelled', attempts, started);
        this.logger.warn('web_search attempt failed', { query, attempt: attempts, kind: err.kind, status: err.status });
        if (!err.transient || attempts > this.opts.maxRetries) break;
        const backoff =
          err.kind === 'rate_limited' && err.retryAfterMs
            ? Math.min(err.retryAfterMs, cap)
            : Math.min(cap, base * 2 ** (attempts - 1)) * (0.8 + Math.random() * 0.4);
        try {
          await this.sleep(backoff, signal);
        } catch {
          return this.fail(query, 'cancelled', 'request cancelled', attempts, started);
        }
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      }
    }
    const outcome = lastErr?.kind === 'timeout' ? 'timeout' : lastErr?.kind === 'rate_limited' ? 'rate_limited' : 'error';
    return this.fail(query, outcome, lastErr?.message ?? 'search failed', attempts, started);
  }

  private fail(query: string, outcome: SearchResponse['outcome'], error: string, attempts: number, started: number): SearchResponse {
    return { query, outcome, results: [], cached: false, attempts, durationMs: Date.now() - started, error };
  }
}

/** Rejects as soon as the signal aborts, even if the provider ignores the signal. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(signal.reason instanceof SearchProviderError ? signal.reason : new SearchProviderError('aborted', 'cancelled'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/**
 * Per-request handle to ECHO's single external tool, `web_search(query)`.
 * Enforces the tool-call budget and suppresses duplicate queries within the request.
 */
export class WebSearchTool {
  private calls = 0;
  private seen = new Map<string, Promise<SearchResponse>>();
  readonly log: SearchResponse[] = [];

  constructor(
    private service: WebSearchService,
    readonly budget: number,
    private ctx: { requestId: string; conversationId: string | null; signal: AbortSignal; logger: Logger; searchLog?: SearchLogRepository },
  ) {}

  get callsMade(): number {
    return this.calls;
  }
  get remaining(): number {
    return Math.max(0, this.budget - this.calls);
  }

  /** The web_search tool. Never throws for provider failures; failures are returned as outcomes. */
  async web_search(query: string): Promise<SearchResponse> {
    const key = normalizeQuery(query);
    const dup = this.seen.get(key);
    if (dup) return dup; // duplicate-query suppression: no extra budget used
    if (this.calls >= this.budget) {
      return { query, outcome: 'budget_exhausted', results: [], cached: false, attempts: 0, durationMs: 0, error: 'tool-call budget exhausted' };
    }
    this.calls++;
    const p = this.service.search(query, this.ctx.signal).then((r) => {
      this.log.push(r);
      this.ctx.logger.info('web_search', {
        requestId: this.ctx.requestId,
        query,
        outcome: r.outcome,
        results: r.results.length,
        cached: r.cached,
        attempts: r.attempts,
        durationMs: r.durationMs,
      });
      try {
        this.ctx.searchLog?.insert({
          requestId: this.ctx.requestId,
          conversationId: this.ctx.conversationId,
          query,
          outcome: r.outcome,
          resultCount: r.results.length,
          cached: r.cached,
          attempts: r.attempts,
          durationMs: r.durationMs,
        });
      } catch {
        /* logging must never break the request */
      }
      return r;
    });
    this.seen.set(key, p);
    return p;
  }
}
