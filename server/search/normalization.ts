import type { SearchResult } from '../types.js';
import { truncate } from '../utils/text.js';

/** Raw result shape from a provider before normalization. */
export interface RawSearchResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  raw_content?: unknown;
  published_date?: unknown;
  score?: unknown;
}

const TRACKING_PARAMS = /^(utm_[a-z]+|ref|ref_src|fbclid|gclid|mc_cid|mc_eid)$/i;

/** Canonical URL form used for deduplication and for matching claims to sources. */
export function normalizeUrl(input: string): string {
  try {
    const u = new URL(input.trim());
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
    let s = u.toString();
    if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
    return s.replace(/^http:\/\//, 'https://');
  } catch {
    return input.trim();
  }
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export function normalizeQuery(q: string): string {
  return q.toLowerCase().replace(/\s+/g, ' ').trim();
}

function toIsoDate(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Converts provider output into ECHO's SearchResult. Drops non-http(s) URLs, duplicates
 * (by canonical URL) and empty content. Page content is truncated to bound prompt size.
 */
export function normalizeResults(raw: RawSearchResult[], maxResults: number, retrievedAt: number, maxContentChars = 6000): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of raw) {
    if (typeof r.url !== 'string' || !isHttpUrl(r.url)) continue;
    const url = normalizeUrl(r.url);
    if (seen.has(url)) continue;
    const snippet = typeof r.content === 'string' ? r.content.trim() : '';
    const page = typeof r.raw_content === 'string' ? r.raw_content.trim() : '';
    const content = page && page.length > snippet.length ? `${snippet}\n\n${truncate(page, maxContentChars)}` : snippet;
    if (!content) continue;
    seen.add(url);
    out.push({
      title: typeof r.title === 'string' && r.title.trim() ? r.title.trim() : domainOf(url),
      url,
      content,
      publishedDate: toIsoDate(r.published_date),
      domain: domainOf(url),
      retrievedAt,
      score: typeof r.score === 'number' ? r.score : undefined,
    });
    if (out.length >= maxResults) break;
  }
  return out;
}
