import type { Snapshot } from '../database/repositories/snapshots.js';
import type { ChangeRecord, ChangeType, VerifiedClaim, Verdict } from '../types.js';
import { canonicalEntityName, sameEntity } from '../utils/entityNames.js';
import { isoDateInZone } from '../utils/timeResolver.js';
import { nearlyEqual, normalizeForMatch } from '../utils/text.js';
import { normalizePlan } from '../agent/verifier.js';

export const BASELINE_UNAVAILABLE = 'Historical baseline unavailable';
export const NOT_VERIFIED = 'Current status not verified';

const EVENT_TYPE: Record<string, ChangeType> = {
  launch: 'product_launch',
  feature: 'feature_added',
  api: 'api_change',
  announcement: 'announcement',
  policy: 'policy_change',
  availability: 'availability_change',
  other: 'announcement',
};
const RANK = { low: 0, medium: 1, high: 2 } as const;
const minConf = (...xs: Array<'high' | 'medium' | 'low'>) => xs.reduce((a, b) => (RANK[a] <= RANK[b] ? a : b));
const label = (x: number): 'high' | 'medium' | 'low' => (x >= 0.8 ? 'high' : x >= 0.55 ? 'medium' : 'low');

function describe(k: { category: string; plan?: string | null; billingPeriod?: string | null; unit?: string | null; region?: string | null; value?: string }): string {
  if (k.category === 'price' || k.category === 'plan' || k.category === 'availability') {
    return [k.category, k.plan, k.billingPeriod, k.unit, k.region].filter(Boolean).join(' · ');
  }
  return k.category;
}

/** Parses the components back out of an attribute key (see verifier.attributeKey). */
function keyParts(key: string): Record<string, string> {
  const parts = key.split('|');
  const out: Record<string, string> = { entity: parts[0] ?? '', category: parts[1] ?? '' };
  for (const p of parts.slice(2)) {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i)] = p.slice(i + 1);
  }
  return out;
}

/** Same plan/unit/region/currency; billing differs only because one side did not state it. */
function nearMatch(histKey: string, currKey: string): boolean {
  const h = keyParts(histKey);
  const c = keyParts(currKey);
  if (h.entity !== c.entity || h.category !== 'price' || c.category !== 'price') return false;
  if (h.plan !== c.plan || h.unit !== c.unit || h.region !== c.region || h.cur !== c.cur) return false;
  return h.billing !== c.billing && (h.billing === 'unspecified' || c.billing === 'unspecified');
}

export interface ChangeInput {
  baseline: Snapshot[];
  current: VerifiedClaim[];
  targets: string[];
  baselineTime: number | null; // when the referenced discussion happened
  timezone: string;
  searchFailedFor?: string[]; // entities whose searches failed (timeout/rate limit)
}

/**
 * Change Intelligence Engine: compares historical snapshots with current verified evidence.
 * Changes are reported only when supported by evidence on both sides of a comparable key.
 */
export function detectChanges(input: ChangeInput): ChangeRecord[] {
  const { timezone: tz } = input;
  const records: ChangeRecord[] = [];
  const entities: string[] = [];
  for (const n of [...input.targets, ...input.baseline.map((s) => s.entityName)]) if (!entities.some((e) => sameEntity(e, n))) entities.push(n);

  for (const entity of entities) {
    // Latest snapshot per key (snapshots sorted ascending by observedAt in the repo).
    const hist = new Map<string, Snapshot>();
    for (const s of input.baseline.filter((s) => sameEntity(s.entityName, entity)).sort((a, b) => a.observedAt - b.observedAt)) hist.set(s.attributeKey, s);
    const curr = new Map<string, VerifiedClaim>();
    for (const c of input.current.filter((c) => sameEntity(c.entity, entity))) {
      const key = c.attributeKey.replace(/^[^|]*/, canonicalEntityName(entity));
      curr.set(key, c);
    }
    const histKeyed = new Map([...hist].map(([k, v]) => [k.replace(/^[^|]*/, canonicalEntityName(entity)), v]));
    const searchFailed = input.searchFailedFor?.some((e) => sameEntity(e, entity)) ?? false;
    const usedCurr = new Set<string>();
    const baselineDate = input.baselineTime !== null ? isoDateInZone(input.baselineTime, tz) : null;

    if (!histKeyed.size && !curr.size) {
      records.push({
        entity,
        attribute: 'pricing & announcements',
        attributeKey: `${canonicalEntityName(entity)}|summary`,
        historicalValue: null,
        historicalDate: null,
        historicalSource: null,
        currentValue: null,
        currentSource: null,
        currentSourceDate: null,
        changeType: 'not_verified',
        confidence: 'low',
        explanation: `${BASELINE_UNAVAILABLE}: no values were recorded for ${entity} in the earlier conversation. ${NOT_VERIFIED}${searchFailed ? ' (search failed)' : ': no supporting evidence was found'}.`,
      });
      continue;
    }

    for (const [key, s] of histKeyed) {
      const histDate = isoDateInZone(s.observedAt, tz);
      const histSource = s.sourceUrl ?? `conversation:${s.messageId}`;
      const histConf = label(s.confidence);
      let c = curr.get(key);
      let near = false;
      if (!c) {
        const k2 = [...curr.keys()].find((k) => !usedCurr.has(k) && nearMatch(key, k));
        if (k2) {
          c = curr.get(k2);
          near = true;
          usedCurr.add(k2);
        }
      } else usedCurr.add(key);

      const base = {
        entity,
        attribute: describe({ ...s, category: s.attribute }),
        attributeKey: key,
        historicalValue: s.value,
        historicalDate: histDate,
        historicalSource: histSource,
      };

      if (!c) {
        // Explicit removal evidence for this plan?
        const removal = [...curr.values()].find(
          (x) => (x.category === 'plan' || x.category === 'price') && (x.status === 'removed' || x.status === 'deprecated') && normalizePlan(x.plan) === normalizePlan(s.plan),
        );
        if (removal) {
          usedCurr.add(removal.attributeKey);
          records.push({ ...base, currentValue: removal.value, currentSource: removal.sourceUrl, currentSourceDate: removal.sourceDate, changeType: 'plan_removed', confidence: minConf(histConf, removal.confidenceLabel), explanation: `Current source states the ${s.plan ?? ''} plan was ${removal.status}.` });
          continue;
        }
        const otherBilling = [...curr.entries()].find(([k]) => {
          const h = keyParts(key);
          const x = keyParts(k);
          return h.category === 'price' && x.category === 'price' && h.plan === x.plan && h.billing !== x.billing;
        });
        records.push({
          ...base,
          currentValue: null,
          currentSource: null,
          currentSourceDate: null,
          changeType: 'not_verified',
          confidence: 'low',
          explanation: otherBilling
            ? `${NOT_VERIFIED}: current evidence covers a different billing period (${otherBilling[1].value}), which is not comparable.`
            : `${NOT_VERIFIED}${searchFailed ? ' (search failed)' : ''}. Absence of evidence is not evidence of no change.`,
        });
        continue;
      }

      const common = { currentValue: c.value, currentSource: c.sourceUrl, currentSourceDate: c.sourceDate };
      let conf = minConf(histConf, c.confidenceLabel);
      if (near) conf = 'low';
      if (c.contested) conf = minConf(conf, 'medium');
      const caveat = [near ? 'One side did not state the billing period; compared with low confidence.' : '', c.contested ? 'Sources disagree on the current value.' : '', c.stale ? 'Current source may be outdated.' : ''].filter(Boolean).join(' ');

      if (c.promotional) {
        records.push({ ...base, ...common, changeType: 'not_verified', confidence: 'low', explanation: `Only a promotional price was found; the list price is not verified. ${caveat}`.trim() });
        continue;
      }
      if (s.numericValue !== null && c.numericValue != null) {
        const t: ChangeType = nearlyEqual(s.numericValue, c.numericValue) ? 'unchanged' : c.numericValue > s.numericValue ? 'price_increase' : 'price_decrease';
        const delta = c.numericValue - s.numericValue;
        const pct = s.numericValue !== 0 ? ` (${delta > 0 ? '+' : ''}${((delta / s.numericValue) * 100).toFixed(1)}%)` : '';
        records.push({
          ...base,
          ...common,
          changeType: t,
          confidence: conf,
          explanation: (t === 'unchanged' ? 'Same value for the same plan, billing period and unit.' : `Changed from ${s.value} to ${c.value}${pct}.`) + (caveat ? ' ' + caveat : ''),
        });
      } else {
        const same = normalizeForMatch(s.value) === normalizeForMatch(c.value);
        records.push({ ...base, ...common, changeType: same ? 'unchanged' : 'changed', confidence: conf, explanation: (same ? 'Same as recorded.' : `Recorded "${s.value}", now "${c.value}".`) + (caveat ? ' ' + caveat : '') });
      }
    }

    // Current evidence without a matching historical record.
    for (const [key, c] of curr) {
      if (usedCurr.has(key)) continue;
      const common = {
        entity,
        attribute: describe(c),
        attributeKey: key,
        currentValue: c.value,
        currentSource: c.sourceUrl,
        currentSourceDate: c.sourceDate,
      };
      if (c.category === 'price' || c.category === 'plan') {
        const eventDate = c.eventDate ?? null;
        const isFree = normalizePlan(c.plan) === 'free' || (c.category === 'price' && c.numericValue === 0);
        const afterBaseline = !!(eventDate && baselineDate && eventDate > baselineDate);
        if (c.status === 'removed' || c.status === 'deprecated') {
          records.push({ ...common, historicalValue: null, historicalDate: null, historicalSource: null, changeType: 'plan_removed', confidence: c.confidenceLabel, explanation: `Source states this plan was ${c.status}${eventDate ? ` on ${eventDate}` : ''}; no earlier record to compare.` });
        } else if (isFree && afterBaseline && histKeyed.size > 0) {
          records.push({ ...common, historicalValue: null, historicalDate: baselineDate, historicalSource: null, changeType: 'new_free_tier', confidence: c.confidenceLabel, explanation: `Free tier introduced on ${eventDate}, after the earlier discussion.` });
        } else if (histKeyed.size > 0 && afterBaseline) {
          records.push({ ...common, historicalValue: null, historicalDate: baselineDate, historicalSource: null, changeType: 'plan_added', confidence: c.confidenceLabel, explanation: `Plan introduced on ${eventDate}, after the earlier discussion.` });
        } else {
          records.push({ ...common, historicalValue: null, historicalDate: null, historicalSource: null, changeType: 'baseline_unavailable', confidence: c.confidenceLabel, explanation: `${BASELINE_UNAVAILABLE} for this exact plan/billing/unit, so no change can be computed.` });
        }
        continue;
      }
      // Events: launches, features, API, policy, availability, announcements.
      const date = c.eventDate ?? c.sourceDate;
      if (date && baselineDate && date <= baselineDate) continue; // predates the earlier discussion → not a change
      let type: ChangeType = EVENT_TYPE[c.category] ?? 'announcement';
      if ((c.status === 'removed' || c.status === 'deprecated') && c.category === 'feature') type = 'feature_removed';
      if (c.status === 'announced') type = 'announcement';
      const dateNote = date
        ? `Dated ${date}${c.eventDate ? '' : ' (publication date)'}${baselineDate ? `, after ${baselineDate}` : ''}.`
        : `No date stated; may predate ${baselineDate ?? 'the earlier discussion'}.`;
      const statusNote = c.status === 'announced' ? ' Announced, not confirmed as released.' : c.status === 'beta' ? ' In beta/preview.' : '';
      records.push({ ...common, historicalValue: null, historicalDate: baselineDate, historicalSource: null, changeType: type, confidence: date ? c.confidenceLabel : 'low', explanation: dateNote + statusNote });
    }
  }
  return records;
}

const INVALIDATING: ChangeType[] = ['price_increase', 'price_decrease', 'plan_removed', 'feature_removed', 'changed', 'availability_change', 'policy_change'];

/** Deterministic verdict on whether an earlier answer still holds, from the change records. */
export function verdictFrom(records: ChangeRecord[]): { verdict: Verdict; changed: number; unchanged: number; unverified: number } {
  const changed = records.filter((r) => INVALIDATING.includes(r.changeType)).length;
  const unchanged = records.filter((r) => r.changeType === 'unchanged').length;
  const unverified = records.filter((r) => r.changeType === 'not_verified').length;
  let verdict: Verdict;
  if (changed === 0 && unchanged === 0) verdict = 'cannot_verify';
  else if (changed === 0) verdict = 'still_correct';
  else if (unchanged === 0) verdict = 'outdated';
  else verdict = 'partially_correct';
  return { verdict, changed, unchanged, unverified };
}
