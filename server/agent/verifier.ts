import { randomUUID } from 'node:crypto';
import type { ProposedClaim, RejectedClaim, VerifiedClaim } from '../types.js';
import { looksLikeInjection } from '../search/sanitize.js';
import { canonicalEntityName, sameEntity } from '../utils/entityNames.js';
import { containsNormalized, extractNumbers, nearlyEqual, normalizeForMatch } from '../utils/text.js';
import type { SourceDoc } from './evidence.js';
import { classifySource, computeConfidence, confidenceLabel, SOURCE_PRIORITY } from './sourceRank.js';

export interface VerificationResult {
  accepted: VerifiedClaim[];
  rejected: RejectedClaim[];
  conflicts: Array<{ attributeKey: string; kept: VerifiedClaim; others: VerifiedClaim[] }>;
}

const PROMO_RE = /\b(promo(tion(al)?)?|discount(ed)?|\d+\s?% off|limited[- ]time|first \d+ (months?|weeks?)|introductory|coupon|sale price|special offer|for a limited)\b/i;
const ANNOUNCED_RE = /\b(coming soon|will (be )?(available|released|launch(ed)?|ship(ped)?|roll(ed)? out)|waitlist|private preview|public preview|early access|later this (year|quarter|month)|plans? to (launch|release))\b/i;
const BETA_RE = /\b(beta|preview)\b/i;
const STALE_DAYS = 365;

export function normalizePlan(p: string | null | undefined): string {
  if (!p) return 'unspecified';
  return p.toLowerCase().replace(/\b(plan|tier|edition|package)\b/g, '').replace(/[^a-z0-9+ ]+/g, ' ').replace(/\s+/g, ' ').trim() || 'unspecified';
}

export function normalizeUnit(u: string | null | undefined): string {
  if (!u) return 'unspecified';
  let s = u.toLowerCase();
  s = s.replace(/\b(billed\s+)?(annually|yearly|monthly|per\s+(month|year)|a\s+month|\/\s*(mo|month|yr|year))\b/g, ' ');
  s = s.replace(/\b(seat|seats|users)\b/g, 'user').replace(/\bper\s+/g, 'per ').replace(/\//g, ' per ');
  s = s.replace(/[^a-z0-9 -]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\buser\b/.test(s)) return 'per user';
  return s || 'unspecified';
}

export function normalizeRegion(r: string | null | undefined): string {
  return r ? r.toLowerCase().replace(/\s+/g, '-') : 'any';
}

const slug = (v: string) => normalizeForMatch(v).split(' ').slice(0, 8).join('-');

/**
 * The comparability key. Two observations are compared only if their keys are equal, which
 * guarantees we never compare different tiers, billing periods, units, regions or currencies.
 */
export function attributeKey(c: {
  entity: string;
  category: string;
  plan?: string | null;
  billingPeriod?: string | null;
  unit?: string | null;
  region?: string | null;
  currency?: string | null;
  value: string;
}): string {
  const e = canonicalEntityName(c.entity);
  if (c.category === 'price') {
    return [e, 'price', `plan=${normalizePlan(c.plan)}`, `billing=${c.billingPeriod ?? 'unspecified'}`, `unit=${normalizeUnit(c.unit)}`, `region=${normalizeRegion(c.region)}`, `cur=${(c.currency ?? 'unspecified').toUpperCase()}`].join('|');
  }
  if (c.category === 'plan' || c.category === 'availability') return [e, c.category, `plan=${normalizePlan(c.plan)}`, `region=${normalizeRegion(c.region)}`].join('|');
  return [e, c.category, slug(c.value)].join('|');
}

function validDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Stage 6 — VERIFY. Deterministic checks; a claim survives only if:
 *  1. it cites a source that was actually returned by web_search in this request;
 *  2. its quote occurs (normalized) in that source's text and is not injected instruction text;
 *  3. for prices, the number appears in the quote;
 *  4. it is about a target entity (or, without targets, an entity named in the source).
 * Confidence, staleness, promotional and announced-vs-released flags are computed here, not by the LLM.
 */
export function verifyClaims(
  proposed: ProposedClaim[],
  sources: SourceDoc[],
  opts: { now: Date; targetEntities: string[] },
): VerificationResult {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const accepted: VerifiedClaim[] = [];
  const rejected: RejectedClaim[] = [];

  for (const claim of proposed) {
    const src = byId.get(claim.sourceId);
    if (!src) {
      rejected.push({ claim, reason: `cites unknown source ${claim.sourceId}` });
      continue;
    }
    const text = `${src.result.title}\n${src.result.content}`;
    if (!containsNormalized(text, claim.quote)) {
      rejected.push({ claim, reason: 'quote not found in cited source' });
      continue;
    }
    if (looksLikeInjection(claim.quote)) {
      rejected.push({ claim, reason: 'quote comes from text addressing an AI assistant (possible prompt injection)' });
      continue;
    }
    let numeric = claim.numericValue ?? null;
    if (claim.category === 'price') {
      if (numeric === null) numeric = extractNumbers(claim.value)[0] ?? null;
      if (numeric === null) {
        rejected.push({ claim, reason: 'price claim without a numeric value' });
        continue;
      }
      if (!extractNumbers(claim.quote).some((n) => nearlyEqual(n, numeric!))) {
        rejected.push({ claim, reason: `price ${numeric} does not appear in the quoted text` });
        continue;
      }
    }
    let entity = claim.entity;
    if (opts.targetEntities.length) {
      const target = opts.targetEntities.find((t) => sameEntity(t, claim.entity));
      if (!target) {
        rejected.push({ claim, reason: `entity "${claim.entity}" is not one of the target entities` });
        continue;
      }
      entity = target;
    } else if (!containsNormalized(text, canonicalEntityName(claim.entity).split(' ')[0] ?? claim.entity)) {
      rejected.push({ claim, reason: `entity "${claim.entity}" not mentioned in source` });
      continue;
    }

    const notes: string[] = [];
    let status = claim.status ?? null;
    let eventDate = validDate(claim.eventDate);
    const quoteAndValue = `${claim.quote} ${claim.value}`;
    if (ANNOUNCED_RE.test(claim.quote) && (status === null || status === 'released' || status === 'available')) {
      status = 'announced';
      notes.push('source describes this as announced/upcoming, not released');
    } else if (status === null && BETA_RE.test(claim.quote) && ['feature', 'launch', 'api'].includes(claim.category)) {
      status = 'beta';
    }
    if (eventDate && new Date(eventDate).getTime() > opts.now.getTime() + 86400000) {
      notes.push(`event date ${eventDate} is in the future; treated as planned`);
      if (status === 'released' || status === null) status = 'announced';
    }
    const promotional = PROMO_RE.test(quoteAndValue);
    if (promotional) notes.push('promotional/discounted price — not treated as the list price');
    const sourceDate = src.result.publishedDate;
    const stale =
      !!sourceDate &&
      (claim.category === 'price' || claim.category === 'plan') &&
      opts.now.getTime() - new Date(sourceDate).getTime() > STALE_DAYS * 86400000;
    if (stale) notes.push(`source published ${sourceDate}; may be outdated`);
    if (!eventDate && ['launch', 'feature', 'api', 'announcement', 'policy'].includes(claim.category)) {
      eventDate = null;
    }

    const sourceType = classifySource(src.result.url, entity);
    const confidence = computeConfidence({ sourceType, direct: claim.direct, category: claim.category, stale, promotional });
    const v: VerifiedClaim = {
      ...claim,
      entity,
      numericValue: numeric,
      status,
      eventDate,
      id: randomUUID(),
      sourceUrl: src.result.url,
      sourceTitle: src.result.title,
      sourceDomain: src.result.domain,
      sourceType,
      sourceDate,
      retrievedAt: src.result.retrievedAt,
      confidence,
      confidenceLabel: confidenceLabel(confidence),
      attributeKey: attributeKey({ ...claim, entity }),
      promotional,
      stale,
      contested: false,
      notes,
    };
    accepted.push(v);
  }

  // Deduplicate and resolve contradictions per comparability key.
  const groups = new Map<string, VerifiedClaim[]>();
  for (const c of accepted) groups.set(c.attributeKey, [...(groups.get(c.attributeKey) ?? []), c]);
  const final: VerifiedClaim[] = [];
  const conflicts: VerificationResult['conflicts'] = [];
  const rank = (c: VerifiedClaim) => [c.promotional ? 1 : 0, SOURCE_PRIORITY[c.sourceType], -c.confidence, -(c.sourceDate ? Date.parse(c.sourceDate) : 0)];
  const cmp = (a: VerifiedClaim, b: VerifiedClaim) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i]! !== rb[i]!) return ra[i]! - rb[i]!;
    return 0;
  };
  for (const [key, group] of groups) {
    const sorted = [...group].sort(cmp);
    const kept = sorted[0]!;
    const disagreeing = sorted.slice(1).filter((o) =>
      kept.numericValue != null && o.numericValue != null
        ? !nearlyEqual(kept.numericValue, o.numericValue) && !o.promotional
        : normalizeForMatch(o.value) !== normalizeForMatch(kept.value) && kept.category !== 'feature' && kept.category !== 'launch' && kept.category !== 'announcement',
    );
    if (disagreeing.length && kept.category === 'price') {
      kept.contested = true;
      kept.notes.push(`other sources state different values: ${disagreeing.map((d) => `${d.value} (${d.sourceDomain})`).join('; ')}`);
      if (disagreeing.some((d) => SOURCE_PRIORITY[d.sourceType] === SOURCE_PRIORITY[kept.sourceType])) {
        kept.confidence = Math.round(kept.confidence * 0.7 * 100) / 100;
        kept.confidenceLabel = confidenceLabel(kept.confidence);
      }
      conflicts.push({ attributeKey: key, kept, others: disagreeing });
    }
    final.push(kept);
  }
  return { accepted: final, rejected, conflicts };
}
