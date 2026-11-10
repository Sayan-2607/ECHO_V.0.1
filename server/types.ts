/** Shared domain types for the ECHO server. */

export type Role = 'user' | 'assistant';
export type MessageStatus = 'complete' | 'cancelled' | 'error';

export interface Conversation {
  id: string;
  title: string;
  timezone: string;
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  replyTo: string | null;
  status: MessageStatus;
  createdAt: number;
  metadata: MessageMetadata;
}

export interface MessageMetadata {
  sources?: Citation[];
  changes?: ChangeRecord[];
  stages?: StageRecord[];
  verdict?: Verdict | null;
  searchQueries?: string[];
  removedUnsupported?: string[];
  rejectedClaims?: number;
  requestId?: string;
  cancelled?: boolean;
  error?: string;
  timezone?: string;
  disambiguation?: boolean;
  disambiguationCandidates?: string[];
  originalRequest?: string;
  memoryNotes?: string[];
}

export type EntityRelation = 'mentioned' | 'shortlisted' | 'decided' | 'researched';

export interface Entity {
  id: string;
  canonicalName: string;
  displayName: string;
  entityType: string;
}

// ── Web search ────────────────────────────────────────────────────────────

export interface SearchResult {
  title: string;
  url: string;
  content: string; // snippet (+ truncated page content when available)
  publishedDate: string | null;
  domain: string;
  retrievedAt: number;
  score?: number;
}

export type SearchOutcome = 'ok' | 'empty' | 'timeout' | 'rate_limited' | 'error' | 'budget_exhausted' | 'cancelled';

export interface SearchResponse {
  query: string;
  outcome: SearchOutcome;
  results: SearchResult[];
  cached: boolean;
  attempts: number;
  durationMs: number;
  error?: string;
}

// ── Evidence ──────────────────────────────────────────────────────────────

export type ClaimCategory =
  | 'price'
  | 'plan'
  | 'feature'
  | 'launch'
  | 'api'
  | 'policy'
  | 'availability'
  | 'announcement'
  | 'other';

export type BillingPeriod = 'monthly' | 'annual' | 'one_time' | 'usage' | null;
export type ClaimStatus = 'released' | 'announced' | 'beta' | 'deprecated' | 'removed' | 'available' | null;

/** A claim proposed by the evidence extractor (LLM). Untrusted until verified. */
export interface ProposedClaim {
  entity: string;
  category: ClaimCategory;
  plan?: string | null;
  billingPeriod?: BillingPeriod;
  unit?: string | null;
  region?: string | null;
  value: string;
  numericValue?: number | null;
  currency?: string | null;
  sourceId: string; // "S1".."Sn"
  quote: string;
  eventDate?: string | null;
  status?: ClaimStatus;
  direct: boolean;
}

export type SourceType =
  | 'official_pricing'
  | 'official_docs'
  | 'official_changelog'
  | 'official_announcement'
  | 'official_other'
  | 'reputable_publication'
  | 'review_aggregator'
  | 'community'
  | 'other';

export interface VerifiedClaim extends ProposedClaim {
  id: string;
  sourceUrl: string;
  sourceTitle: string;
  sourceDomain: string;
  sourceType: SourceType;
  sourceDate: string | null; // publication date if known
  retrievedAt: number;
  confidence: number; // 0..1, computed deterministically
  confidenceLabel: 'high' | 'medium' | 'low';
  attributeKey: string; // comparability key
  promotional: boolean;
  stale: boolean;
  contested: boolean;
  notes: string[];
}

export interface RejectedClaim {
  claim: ProposedClaim;
  reason: string;
}

// ── Change intelligence ───────────────────────────────────────────────────

export type ChangeType =
  | 'price_increase'
  | 'price_decrease'
  | 'unchanged'
  | 'new_free_tier'
  | 'plan_added'
  | 'plan_removed'
  | 'feature_added'
  | 'feature_removed'
  | 'api_change'
  | 'product_launch'
  | 'policy_change'
  | 'availability_change'
  | 'announcement'
  | 'changed'
  | 'baseline_unavailable'
  | 'not_verified';

export interface ChangeRecord {
  entity: string;
  attribute: string; // human readable, e.g. "price · Pro · monthly · per user"
  attributeKey: string;
  historicalValue: string | null; // null → "Historical baseline unavailable"
  historicalDate: string | null; // ISO date in conversation timezone
  historicalSource: string | null; // URL or "conversation:<messageId>"
  currentValue: string | null; // null → "Current status not verified"
  currentSource: string | null;
  currentSourceDate: string | null;
  changeType: ChangeType;
  confidence: 'high' | 'medium' | 'low';
  explanation: string;
}

export type Verdict = 'still_correct' | 'partially_correct' | 'outdated' | 'cannot_verify';

// ── Streaming / presentation ──────────────────────────────────────────────

export interface Citation {
  n: number;
  url: string;
  title: string;
  domain: string;
  sourceType: SourceType | 'historical_record';
  publishedDate: string | null;
  retrievedAt: number;
}

export type StageName =
  | 'understand'
  | 'retrieve'
  | 'plan'
  | 'search'
  | 'evaluate'
  | 'gaps'
  | 'verify'
  | 'compare'
  | 'synthesize'
  | 'persist';

export interface StageRecord {
  stage: StageName;
  status: 'start' | 'done' | 'skipped' | 'error';
  detail?: string;
  at: number;
}

export type AgentEvent =
  | { type: 'conversation'; conversation: Conversation; userMessageId: string }
  | { type: 'stage'; stage: StageRecord }
  | { type: 'search'; query: string; outcome: SearchOutcome; resultCount: number; cached: boolean }
  | { type: 'token'; text: string }
  | { type: 'sources'; sources: Citation[] }
  | { type: 'changes'; changes: ChangeRecord[] }
  | { type: 'final'; message: Message }
  | { type: 'error'; error: string; code: string };
