import type { RawSearchResult } from './normalization.js';

/** Error from a search provider. `transient` errors are retried with backoff. */
export class SearchProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: 'timeout' | 'rate_limited' | 'server' | 'client' | 'network' | 'cancelled',
    public readonly status?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
  }
  get transient(): boolean {
    return this.kind === 'timeout' || this.kind === 'rate_limited' || this.kind === 'server' || this.kind === 'network';
  }
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, opts: { maxResults: number; signal: AbortSignal }): Promise<RawSearchResult[]>;
}

/** Tavily Search API (https://docs.tavily.com). */
export class TavilyProvider implements SearchProvider {
  readonly name = 'tavily';
  constructor(
    private apiKey: string,
    private endpoint = 'https://api.tavily.com/search',
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async search(query: string, opts: { maxResults: number; signal: AbortSignal }): Promise<RawSearchResult[]> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          query,
          search_depth: 'advanced',
          max_results: opts.maxResults,
          include_answer: false, // never use a provider-generated answer as evidence
          include_raw_content: true, // page text lets the verifier check quotes beyond the snippet
          topic: 'general',
        }),
        signal: opts.signal,
      });
    } catch (err) {
      if (opts.signal.aborted) {
        const reason = opts.signal.reason;
        if (reason instanceof SearchProviderError) throw reason;
        throw new SearchProviderError('search aborted', 'cancelled');
      }
      throw new SearchProviderError(`network error: ${(err as Error).message}`, 'network');
    }
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'));
      throw new SearchProviderError('rate limited by search provider', 'rate_limited', 429, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
    }
    if (res.status >= 500) throw new SearchProviderError(`search provider error ${res.status}`, 'server', res.status);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new SearchProviderError(`search request rejected (${res.status}): ${body.slice(0, 200)}`, 'client', res.status);
    }
    const json = (await res.json()) as { results?: RawSearchResult[] };
    return Array.isArray(json.results) ? json.results : [];
  }
}
