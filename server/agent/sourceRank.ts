import type { SourceType } from '../types.js';
import { entityDomainTokens } from '../utils/entityNames.js';

const REPUTABLE = new Set([
  'techcrunch.com', 'theverge.com', 'reuters.com', 'bloomberg.com', 'zdnet.com', 'infoq.com', 'arstechnica.com', 'wired.com',
  'venturebeat.com', 'theregister.com', 'cnbc.com', 'ft.com', 'wsj.com', 'nytimes.com', 'forbes.com', 'businessinsider.com',
  'siliconangle.com', 'thenewstack.io', 'lwn.net', 'engadget.com', 'geekwire.com', 'axios.com', 'theinformation.com',
]);
const AGGREGATORS = new Set(['g2.com', 'capterra.com', 'trustradius.com', 'getapp.com', 'softwareadvice.com', 'gartner.com', 'saasworthy.com']);
const COMMUNITY = new Set(['reddit.com', 'news.ycombinator.com', 'stackoverflow.com', 'dev.to', 'medium.com', 'quora.com', 'x.com', 'twitter.com', 'github.com', 'community.hubspot.com']);

const matchesSet = (domain: string, set: Set<string>) => [...set].some((d) => domain === d || domain.endsWith('.' + d));

/** Classifies a source URL relative to the entity the claim is about. */
export function classifySource(url: string, entity: string): SourceType {
  let host = '';
  let path = '';
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase().replace(/^www\./, '');
    path = u.pathname.toLowerCase();
  } catch {
    return 'other';
  }
  if (matchesSet(host, COMMUNITY)) return 'community';
  if (matchesSet(host, AGGREGATORS)) return 'review_aggregator';
  const hostCompact = host.replace(/[^a-z0-9.]/g, '');
  const labels = hostCompact.split('.');
  const official = entityDomainTokens(entity).some((t) => labels.some((l) => l === t || l.startsWith(t) || (t.length >= 5 && l.includes(t))));
  if (official) {
    if (/pric|plans|billing|cost/.test(path) || /^pricing\./.test(host)) return 'official_pricing';
    if (/changelog|release-?notes|releases|whats-?new|updates|product-updates/.test(path)) return 'official_changelog';
    if (/blog|news|press|newsroom|announc|launch/.test(path) || /^(blog|news|press)\./.test(host)) return 'official_announcement';
    if (/docs|documentation|developer|reference|guide|help|support|kb/.test(path) || /^(docs|developer|developers|help|support)\./.test(host)) return 'official_docs';
    return 'official_other';
  }
  if (matchesSet(host, REPUTABLE)) return 'reputable_publication';
  return 'other';
}

/** Lower number = preferred. Mirrors the priority order in the spec. */
export const SOURCE_PRIORITY: Record<SourceType, number> = {
  official_docs: 1,
  official_pricing: 1,
  official_changelog: 2,
  official_announcement: 3,
  official_other: 4,
  reputable_publication: 5,
  review_aggregator: 6,
  community: 7,
  other: 8,
};

const BASE_CONFIDENCE: Record<SourceType, number> = {
  official_pricing: 0.92,
  official_docs: 0.88,
  official_changelog: 0.88,
  official_announcement: 0.85,
  official_other: 0.75,
  reputable_publication: 0.7,
  review_aggregator: 0.5,
  community: 0.4,
  other: 0.45,
};

export interface ConfidenceInput {
  sourceType: SourceType;
  direct: boolean;
  category: string;
  stale: boolean;
  promotional: boolean;
}

/** Deterministic confidence. The LLM never assigns confidence. */
export function computeConfidence(c: ConfidenceInput): number {
  let x = BASE_CONFIDENCE[c.sourceType];
  if (!c.direct) x *= 0.8;
  if ((c.category === 'price' || c.category === 'plan') && !c.sourceType.startsWith('official')) x = Math.min(x, 0.55);
  if (c.stale) x *= 0.7;
  if (c.promotional) x *= 0.85;
  return Math.round(x * 100) / 100;
}

export const confidenceLabel = (x: number): 'high' | 'medium' | 'low' => (x >= 0.8 ? 'high' : x >= 0.55 ? 'medium' : 'low');
