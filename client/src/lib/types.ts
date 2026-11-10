// Mirrors server/types.ts (presentation subset).

export interface Conversation {
  id: string;
  title: string;
  timezone: string;
  createdAt: number;
  updatedAt: number;
  snippet?: string;
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
  | 'other'
  | 'historical_record';

export interface Citation {
  n: number;
  url: string;
  title: string;
  domain: string;
  sourceType: SourceType;
  publishedDate: string | null;
  retrievedAt: number;
}

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
  attribute: string;
  attributeKey: string;
  historicalValue: string | null;
  historicalDate: string | null;
  historicalSource: string | null;
  currentValue: string | null;
  currentSource: string | null;
  currentSourceDate: string | null;
  changeType: ChangeType;
  confidence: 'high' | 'medium' | 'low';
  explanation: string;
}

export interface StageRecord {
  stage: string;
  status: 'start' | 'done' | 'skipped' | 'error';
  detail?: string;
  at: number;
}

export type Verdict = 'still_correct' | 'partially_correct' | 'outdated' | 'cannot_verify';

export interface MessageMetadata {
  sources?: Citation[];
  changes?: ChangeRecord[];
  stages?: StageRecord[];
  verdict?: Verdict | null;
  searchQueries?: string[];
  removedUnsupported?: string[];
  rejectedClaims?: number;
  cancelled?: boolean;
  error?: string;
  disambiguation?: boolean;
}

export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'complete' | 'cancelled' | 'error';
  createdAt: number;
  metadata: MessageMetadata;
}

export interface ServerConfig {
  model: string;
  modelEndpoint: string;
  searchProvider: string;
  tools: string[];
  maxToolCalls: number;
  searchCacheTtlSeconds: number;
  defaultTimezone: string;
  requestTimeoutMs: number;
}
