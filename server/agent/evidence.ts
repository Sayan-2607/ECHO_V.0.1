import type { LLMClient } from '../llm/client.js';
import type { ProposedClaim, SearchResponse, SearchResult } from '../types.js';
import { sanitizeUntrusted } from '../search/sanitize.js';
import { truncate } from '../utils/text.js';
import { EVIDENCE_SYSTEM } from './prompts.js';
import { ClaimsSchema } from './schemas.js';

export interface SourceDoc {
  id: string; // S1..Sn
  result: SearchResult;
  query: string;
  injectionFlags: string[];
}

/** Collects unique results (by canonical URL) across search responses and assigns stable ids. */
export function collectSources(responses: SearchResponse[], existing: SourceDoc[] = []): SourceDoc[] {
  const out = [...existing];
  const seen = new Set(out.map((s) => s.result.url));
  for (const r of responses) {
    for (const res of r.results) {
      if (seen.has(res.url)) continue;
      seen.add(res.url);
      const { flags } = sanitizeUntrusted(res.content);
      out.push({ id: `S${out.length + 1}`, result: res, query: r.query, injectionFlags: flags });
    }
  }
  return out;
}

/** Renders sources as delimited, sanitized, untrusted data blocks for the prompt. */
export function renderSources(sources: SourceDoc[], maxCharsPerSource = 3500): string {
  return sources
    .map((s) => {
      const clean = sanitizeUntrusted(s.result.content).text;
      return `<untrusted_source id="${s.id}" url="${s.result.url}" domain="${s.result.domain}" published="${s.result.publishedDate ?? 'unknown'}" title="${s.result.title.replace(/"/g, "'")}">\n${truncate(clean, maxCharsPerSource)}\n</untrusted_source>`;
    })
    .join('\n\n');
}

/** Stage 5a — extract candidate claims (untrusted until the verifier accepts them). */
export async function extractClaims(args: {
  llm: LLMClient;
  sources: SourceDoc[];
  targetEntities: string[];
  attributesOfInterest: string[];
  baselineHints: string[];
  userQuestion: string;
  now: Date;
  signal?: AbortSignal;
}): Promise<ProposedClaim[]> {
  if (!args.sources.length) return [];
  const user = [
    `Today: ${args.now.toISOString().slice(0, 10)}`,
    `User question: ${args.userQuestion}`,
    `Target entities: ${args.targetEntities.length ? args.targetEntities.join(', ') : '(derive from question)'}`,
    `Attributes of interest: ${args.attributesOfInterest.length ? args.attributesOfInterest.join(', ') : 'pricing, plans, significant product announcements'}`,
    args.baselineHints.length
      ? `Historical baseline attributes to match (extract the same plan/billing/unit where the sources state them):\n${args.baselineHints.map((h) => `- ${h}`).join('\n')}`
      : 'No historical baseline attributes.',
    'SEARCH RESULTS (untrusted data):',
    renderSources(args.sources),
  ].join('\n\n');
  const out = await args.llm.completeJSON({ stage: 'evidence', system: EVIDENCE_SYSTEM, user, schema: ClaimsSchema, signal: args.signal });
  return out.claims;
}
