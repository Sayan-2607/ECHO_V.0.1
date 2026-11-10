import { createHash } from 'node:crypto';
import type { DB } from '../database/connection.js';
import type { SearchResult } from '../types.js';
import { normalizeQuery } from './normalization.js';

export const queryHash = (q: string) => createHash('sha256').update(normalizeQuery(q)).digest('hex');

/** Short-lived SQLite-backed cache of search results, keyed by normalized query. */
export class SearchCache {
  constructor(
    private db: DB,
    private ttlSeconds: number,
    private now: () => number = Date.now,
  ) {}

  get(query: string): SearchResult[] | null {
    if (this.ttlSeconds <= 0) return null;
    const r = this.db
      .prepare('SELECT results_json, expires_at FROM search_cache WHERE query_hash = ?')
      .get(queryHash(query)) as { results_json: string; expires_at: number } | undefined;
    if (!r) return null;
    if (r.expires_at <= this.now()) {
      this.db.prepare('DELETE FROM search_cache WHERE query_hash = ?').run(queryHash(query));
      return null;
    }
    try {
      return JSON.parse(r.results_json) as SearchResult[];
    } catch {
      return null;
    }
  }

  set(query: string, results: SearchResult[]): void {
    if (this.ttlSeconds <= 0) return;
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO search_cache (query_hash, query, results_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(query_hash) DO UPDATE SET results_json = excluded.results_json, created_at = excluded.created_at, expires_at = excluded.expires_at`,
      )
      .run(queryHash(query), normalizeQuery(query), JSON.stringify(results), now, now + this.ttlSeconds * 1000);
  }

  purgeExpired(): number {
    return this.db.prepare('DELETE FROM search_cache WHERE expires_at <= ?').run(this.now()).changes;
  }
}
