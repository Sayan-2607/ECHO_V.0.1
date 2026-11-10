import { describe, expect, it } from 'vitest';
import { verifyClaims } from '../../server/agent/verifier.js';
import { collectSources } from '../../server/agent/evidence.js';
import { postProcessAnswer } from '../../server/agent/postprocess.js';
import { classifySource } from '../../server/agent/sourceRank.js';
import { allocateQueries } from '../../server/agent/planner.js';
import { AGENT_TOOLS } from '../../server/agent/tools.js';
import type { ProposedClaim, SearchResponse } from '../../server/types.js';

const NOW = new Date('2026-11-10T14:36:00Z');
const resp = (results: Array<{ url: string; content: string; title?: string; publishedDate?: string | null }>): SearchResponse => ({
  query: 'q',
  outcome: 'ok',
  cached: false,
  attempts: 1,
  durationMs: 1,
  results: results.map((r) => ({ title: r.title ?? 'T', url: r.url, content: r.content, publishedDate: r.publishedDate ?? null, domain: new URL(r.url).hostname, retrievedAt: 1 })),
});
const base = (p: Partial<ProposedClaim>): ProposedClaim => ({ entity: 'Neon', category: 'price', plan: 'Launch', billingPeriod: 'monthly', value: '$19/month', numericValue: 19, currency: 'USD', sourceId: 'S1', quote: 'Launch $19/month', direct: true, ...p });

describe('evidence verification (test 7: rejection of unsupported claims)', () => {
  const sources = collectSources([
    resp([
      { url: 'https://neon.tech/pricing', content: 'Plans. Launch $19/month. Scale $69/month. Business $700/month.' },
      { url: 'https://randomblog.example/neon-review', content: 'I think Neon Launch costs around $15/month, not sure.', publishedDate: '2024-01-02' },
    ]),
  ]);

  it('accepts a claim whose quote and number are in the cited source', () => {
    const v = verifyClaims([base({})], sources, { now: NOW, targetEntities: ['Neon'] });
    expect(v.accepted).toHaveLength(1);
    expect(v.accepted[0]).toMatchObject({ sourceUrl: 'https://neon.tech/pricing', sourceType: 'official_pricing', confidenceLabel: 'high' });
  });

  it('rejects a fabricated quote', () => {
    const v = verifyClaims([base({ quote: 'Launch is now $9/month', value: '$9/month', numericValue: 9 })], sources, { now: NOW, targetEntities: ['Neon'] });
    expect(v.accepted).toHaveLength(0);
    expect(v.rejected[0]!.reason).toBe('quote not found in cited source');
  });

  it('rejects a price that is not in the quote', () => {
    const v = verifyClaims([base({ value: '$29/month', numericValue: 29 })], sources, { now: NOW, targetEntities: ['Neon'] });
    expect(v.rejected[0]!.reason).toMatch(/does not appear in the quoted text/);
  });

  it('rejects claims citing a source that was never returned', () => {
    const v = verifyClaims([base({ sourceId: 'S9' })], sources, { now: NOW, targetEntities: ['Neon'] });
    expect(v.rejected[0]!.reason).toMatch(/unknown source/);
  });

  it('rejects claims about entities that are not research targets', () => {
    const v = verifyClaims([base({ entity: 'Supabase' })], sources, { now: NOW, targetEntities: ['Neon'] });
    expect(v.rejected[0]!.reason).toMatch(/not one of the target entities/);
  });

  it('prefers the official source on conflicts and lowers confidence for stale non-official sources', () => {
    const v = verifyClaims(
      [base({}), base({ sourceId: 'S2', quote: 'Neon Launch costs around $15/month', value: '$15/month', numericValue: 15 })],
      sources,
      { now: NOW, targetEntities: ['Neon'] },
    );
    expect(v.accepted).toHaveLength(1);
    expect(v.accepted[0]!.sourceUrl).toBe('https://neon.tech/pricing');
    expect(v.accepted[0]!.contested).toBe(true);
    expect(v.conflicts).toHaveLength(1);
  });

  it('flags announced-but-not-released and promotional claims', () => {
    const s = collectSources([resp([{ url: 'https://neon.tech/blog/x', content: 'Branch restore will be available later this year. Launch: 50% off for the first 3 months ($9.50).' }])]);
    const v = verifyClaims(
      [
        { entity: 'Neon', category: 'feature', value: 'Branch restore', sourceId: 'S1', quote: 'Branch restore will be available later this year', direct: true, status: 'released' },
        base({ quote: 'Launch: 50% off for the first 3 months ($9.50)', value: '$9.50 promo', numericValue: 9.5 }),
      ],
      s,
      { now: NOW, targetEntities: ['Neon'] },
    );
    expect(v.accepted.find((c) => c.category === 'feature')!.status).toBe('announced');
    expect(v.accepted.find((c) => c.category === 'price')!.promotional).toBe(true);
  });
});

describe('citations and output guard (test 6: citation URL preservation)', () => {
  it('keeps valid citations and source links, strips invented ones', () => {
    const out = postProcessAnswer('Neon Launch is $19/month [1]. See [pricing](https://neon.tech/pricing) and [evil](https://evil.example/x) or https://evil.example/y. Fake cite [7].', {
      citationCount: 1,
      allowedUrls: ['https://neon.tech/pricing'],
      allowedAmounts: [19],
    });
    expect(out.content).toContain('[1]');
    expect(out.content).toContain('[pricing](https://neon.tech/pricing)');
    expect(out.content).not.toContain('evil.example');
    expect(out.content).not.toContain('[7]');
    expect(out.removed.length).toBe(3);
  });

  it('removes sentences with ungrounded amounts but keeps grounded ones', () => {
    const out = postProcessAnswer('Launch is $19/month [1]. Scale is probably $49/month. For 20 users that is $380.', { citationCount: 1, allowedUrls: [], allowedAmounts: [19, 380] });
    expect(out.content).toContain('$19/month');
    expect(out.content).toContain('$380');
    expect(out.content).not.toContain('$49');
  });
});

describe('source classification and planning', () => {
  it('classifies official pricing, changelogs, community and publications', () => {
    expect(classifySource('https://www.hubspot.com/pricing/sales', 'HubSpot')).toBe('official_pricing');
    expect(classifySource('https://neon.tech/docs/changelog', 'Neon')).toBe('official_changelog');
    expect(classifySource('https://supabase.com/blog/launch-week', 'Supabase')).toBe('official_announcement');
    expect(classifySource('https://reddit.com/r/x', 'Neon')).toBe('community');
    expect(classifySource('https://techcrunch.com/2026/x', 'Neon')).toBe('reputable_publication');
    expect(classifySource('https://www.g2.com/products/hubspot', 'HubSpot')).toBe('review_aggregator');
  });

  it('allocates one query per entity within the budget and shares the last query when over budget', () => {
    const q = allocateQueries([], ['A', 'B', 'C', 'D', 'E'], 4, ['pricing'], 2026, 'x');
    expect(q).toHaveLength(4);
    expect(q[3]!.query).toContain('D vs E');
    const q2 = allocateQueries([{ query: 'neon pricing', entity: 'Neon', purpose: '' }, { query: 'neon pricing', entity: null, purpose: '' }], ['Neon'], 4, [], 2026, 'x');
    expect(q2.map((x) => x.query)).toEqual(['neon pricing']);
  });

  it('exposes exactly one external tool: web_search', () => {
    expect(AGENT_TOOLS.map((t) => t.name)).toEqual(['web_search']);
  });
});
