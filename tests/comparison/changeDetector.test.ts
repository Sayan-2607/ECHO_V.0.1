import { describe, expect, it } from 'vitest';
import { detectChanges, verdictFrom } from '../../server/comparison/changeDetector.js';
import { attributeKey } from '../../server/agent/verifier.js';
import type { Snapshot } from '../../server/database/repositories/snapshots.js';
import type { VerifiedClaim } from '../../server/types.js';

const BASE_T = Date.parse('2026-11-03T05:00:00Z');

function snap(p: Partial<Snapshot> & { entityName: string; value: string; attribute: string }): Snapshot {
  const s = {
    id: 'h' + Math.random(),
    conversationId: 'c',
    messageId: 'm1',
    entityId: 'e',
    plan: null,
    billingPeriod: null,
    unit: null,
    region: null,
    currency: 'USD',
    numericValue: null,
    status: null,
    quote: null,
    sourceUrl: 'https://neon.tech/pricing',
    sourceType: 'official_pricing',
    observedAt: BASE_T,
    sourceDate: null,
    confidence: 0.92,
    origin: 'web_evidence',
    attributeKey: '',
    ...p,
  } as Snapshot;
  s.attributeKey = attributeKey({ entity: s.entityName, category: s.attribute, plan: s.plan, billingPeriod: s.billingPeriod, unit: s.unit, region: s.region, currency: s.currency, value: s.value });
  return s;
}

function claim(p: Partial<VerifiedClaim> & { entity: string; value: string; category: VerifiedClaim['category'] }): VerifiedClaim {
  const c = {
    id: 'c' + Math.random(),
    plan: null,
    billingPeriod: null,
    unit: null,
    region: null,
    currency: 'USD',
    numericValue: null,
    sourceId: 'S1',
    quote: p.value,
    eventDate: null,
    status: null,
    direct: true,
    sourceUrl: 'https://neon.tech/pricing',
    sourceTitle: 'Pricing',
    sourceDomain: 'neon.tech',
    sourceType: 'official_pricing',
    sourceDate: null,
    retrievedAt: Date.now(),
    confidence: 0.92,
    confidenceLabel: 'high',
    promotional: false,
    stale: false,
    contested: false,
    notes: [],
    attributeKey: '',
    ...p,
  } as VerifiedClaim;
  c.attributeKey = attributeKey(c);
  return c;
}

describe('change detection', () => {
  it('reports a price increase for the same plan, billing period and unit (test 5)', () => {
    const out = detectChanges({
      baseline: [snap({ entityName: 'Neon', attribute: 'price', plan: 'Launch', billingPeriod: 'monthly', value: '$19/month', numericValue: 19 })],
      current: [claim({ entity: 'Neon', category: 'price', plan: 'Launch', billingPeriod: 'monthly', value: '$25/month', numericValue: 25 })],
      targets: ['Neon'],
      baselineTime: BASE_T,
      timezone: 'Asia/Kolkata',
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ changeType: 'price_increase', historicalValue: '$19/month', currentValue: '$25/month', historicalDate: '2026-11-03', confidence: 'high' });
    expect(out[0]!.explanation).toContain('+31.6%');
  });

  it('reports unchanged when values match', () => {
    const out = detectChanges({
      baseline: [snap({ entityName: 'Neon', attribute: 'price', plan: 'Scale', billingPeriod: 'monthly', value: '$69', numericValue: 69 })],
      current: [claim({ entity: 'Neon', category: 'price', plan: 'Scale plan', billingPeriod: 'monthly', value: '$69 / month', numericValue: 69 })],
      targets: ['Neon'],
      baselineTime: BASE_T,
      timezone: 'Asia/Kolkata',
    });
    expect(out[0]!.changeType).toBe('unchanged');
  });

  it('never compares different tiers or billing periods as equivalent', () => {
    const out = detectChanges({
      baseline: [snap({ entityName: 'HubSpot', attribute: 'price', plan: 'Professional', billingPeriod: 'monthly', unit: 'per user', value: '$100/user/month', numericValue: 100, sourceUrl: 'https://hubspot.com/pricing' })],
      current: [
        claim({ entity: 'HubSpot', category: 'price', plan: 'Starter', billingPeriod: 'monthly', unit: 'per user', value: '$20/user/month', numericValue: 20, sourceUrl: 'https://hubspot.com/pricing' }),
        claim({ entity: 'HubSpot', category: 'price', plan: 'Professional', billingPeriod: 'annual', unit: 'per user', value: '$90/user/month billed annually', numericValue: 90, sourceUrl: 'https://hubspot.com/pricing' }),
      ],
      targets: ['HubSpot'],
      baselineTime: BASE_T,
      timezone: 'Asia/Kolkata',
    });
    const types = out.map((r) => r.changeType);
    expect(types).not.toContain('price_decrease');
    const pro = out.find((r) => r.historicalValue === '$100/user/month')!;
    expect(pro.changeType).toBe('not_verified');
    expect(pro.explanation).toMatch(/different billing period/);
    expect(out.filter((r) => r.changeType === 'baseline_unavailable')).toHaveLength(2);
  });

  it('detects a missing historical baseline (test 4)', () => {
    const out = detectChanges({
      baseline: [],
      current: [claim({ entity: 'Supabase', category: 'price', plan: 'Pro', billingPeriod: 'monthly', value: '$25/month', numericValue: 25, sourceUrl: 'https://supabase.com/pricing' })],
      targets: ['Supabase', 'Render'],
      baselineTime: BASE_T,
      timezone: 'Asia/Kolkata',
    });
    const supa = out.find((r) => r.entity === 'Supabase')!;
    expect(supa.changeType).toBe('baseline_unavailable');
    expect(supa.historicalValue).toBeNull();
    expect(supa.explanation).toContain('Historical baseline unavailable');
    const render = out.find((r) => r.entity === 'Render')!;
    expect(render.changeType).toBe('not_verified');
    expect(render.explanation).toContain('Historical baseline unavailable');
    expect(render.explanation).toContain('Current status not verified');
  });

  it('marks a recorded value with no current evidence as not verified (absence ≠ no change)', () => {
    const out = detectChanges({
      baseline: [snap({ entityName: 'Neon', attribute: 'price', plan: 'Launch', billingPeriod: 'monthly', value: '$19', numericValue: 19 })],
      current: [],
      targets: ['Neon'],
      baselineTime: BASE_T,
      timezone: 'Asia/Kolkata',
    });
    expect(out[0]!.changeType).toBe('not_verified');
    expect(out[0]!.currentValue).toBeNull();
  });

  it('reports dated launches after the baseline and ignores ones before it', () => {
    const out = detectChanges({
      baseline: [snap({ entityName: 'Pipedrive', attribute: 'price', plan: 'Advanced', value: '$39', numericValue: 39, sourceUrl: 'https://pipedrive.com/pricing' })],
      current: [
        claim({ entity: 'Pipedrive', category: 'launch', value: 'Launched AI Sales Assistant 2.0', eventDate: '2026-11-06', sourceUrl: 'https://pipedrive.com/blog/x' }),
        claim({ entity: 'Pipedrive', category: 'feature', value: 'Added email sync', eventDate: '2026-09-01', sourceUrl: 'https://pipedrive.com/blog/y' }),
        claim({ entity: 'Pipedrive', category: 'announcement', value: 'Will launch voice calling', status: 'announced', eventDate: '2026-11-07', sourceUrl: 'https://pipedrive.com/blog/z' }),
      ],
      targets: ['Pipedrive'],
      baselineTime: BASE_T,
      timezone: 'Asia/Kolkata',
    });
    expect(out.find((r) => r.changeType === 'product_launch')?.currentValue).toContain('AI Sales Assistant');
    expect(out.some((r) => r.currentValue === 'Added email sync')).toBe(false);
    expect(out.find((r) => r.currentValue?.includes('voice'))?.explanation).toContain('not confirmed as released');
  });

  it('does not treat a promotional price as a list-price change', () => {
    const out = detectChanges({
      baseline: [snap({ entityName: 'Neon', attribute: 'price', plan: 'Launch', billingPeriod: 'monthly', value: '$19', numericValue: 19 })],
      current: [claim({ entity: 'Neon', category: 'price', plan: 'Launch', billingPeriod: 'monthly', value: '$9 for first 3 months', numericValue: 9, promotional: true })],
      targets: ['Neon'],
      baselineTime: BASE_T,
      timezone: 'Asia/Kolkata',
    });
    expect(out[0]!.changeType).toBe('not_verified');
    expect(out[0]!.explanation).toMatch(/promotional/);
  });

  it('computes re-check verdicts', () => {
    const mk = (changeType: any) => ({ changeType }) as any;
    expect(verdictFrom([mk('unchanged')]).verdict).toBe('still_correct');
    expect(verdictFrom([mk('price_increase')]).verdict).toBe('outdated');
    expect(verdictFrom([mk('price_increase'), mk('unchanged')]).verdict).toBe('partially_correct');
    expect(verdictFrom([mk('not_verified'), mk('baseline_unavailable')]).verdict).toBe('cannot_verify');
  });
});
