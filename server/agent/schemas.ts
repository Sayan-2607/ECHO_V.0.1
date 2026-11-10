import { z } from 'zod';

/** Structured outputs for each LLM-backed stage. Every LLM output is validated before use. */

const nullableStr = z.string().nullish().transform((v) => (v && v.trim() ? v.trim() : null));

export const UnderstandSchema = z.object({
  intent: z.enum(['chit_chat', 'general_knowledge', 'current_facts', 'recall', 'recheck', 'historical_comparison']),
  entities: z
    .array(z.object({ name: z.string().min(1), type: z.string().default('other') }))
    .default([]),
  searchTerms: z.array(z.string()).default([]),
  referencesPast: z.boolean().default(false),
  needsFreshInfo: z.boolean().default(false),
  comparison: z.boolean().default(false),
  answerFormat: z.enum(['brief', 'report', 'list', 'table']).default('brief'),
  attributesOfInterest: z.array(z.string()).default([]),
  expectedEntityCount: z.number().int().positive().nullish().transform((v) => v ?? null),
});
export type UnderstandOutput = z.infer<typeof UnderstandSchema>;

export const PlanSchema = z.object({
  needsSearch: z.boolean(),
  rationale: z.string().default(''),
  queries: z
    .array(
      z.object({
        query: z.string().min(2).max(200),
        entity: nullableStr,
        purpose: z.string().default(''),
      }),
    )
    .default([]),
  timeSensitiveClaims: z.array(z.string()).default([]),
});
export type PlanOutput = z.infer<typeof PlanSchema>;

export const ClaimSchema = z.object({
  entity: z.string().min(1),
  category: z.enum(['price', 'plan', 'feature', 'launch', 'api', 'policy', 'availability', 'announcement', 'other']),
  plan: nullableStr,
  billingPeriod: z.enum(['monthly', 'annual', 'one_time', 'usage']).nullish().transform((v) => v ?? null),
  unit: nullableStr,
  region: nullableStr,
  value: z.string().min(1),
  numericValue: z.number().nullish().transform((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)),
  currency: nullableStr,
  sourceId: z.string().regex(/^S\d+$/),
  quote: z.string().min(3),
  eventDate: nullableStr,
  status: z
    .enum(['released', 'announced', 'beta', 'deprecated', 'removed', 'available'])
    .nullish()
    .transform((v) => v ?? null),
  direct: z.boolean().default(true),
});

export const ClaimsSchema = z.object({ claims: z.array(ClaimSchema).default([]) });
export type ClaimsOutput = z.infer<typeof ClaimsSchema>;

export const ExtractionSchema = z.object({
  summary: z.string().default(''),
  entities: z
    .array(
      z.object({
        name: z.string().min(1),
        type: z.string().default('other'),
        relation: z.enum(['mentioned', 'shortlisted', 'decided', 'researched']).default('mentioned'),
        sourceRole: z.enum(['user', 'assistant']).default('assistant'),
      }),
    )
    .default([]),
  facts: z
    .array(
      z.object({
        kind: z.enum(['preference', 'decision', 'project', 'shortlist', 'conclusion', 'date', 'requirement', 'other']),
        content: z.string().min(1),
        certainty: z.enum(['stated', 'inferred']),
        sourceRole: z.enum(['user', 'assistant']),
        evidenceText: z.string().min(1),
      }),
    )
    .default([]),
  statedValues: z
    .array(
      z.object({
        entity: z.string().min(1),
        category: z.enum(['price', 'plan', 'feature', 'availability', 'other']),
        plan: nullableStr,
        billingPeriod: z.enum(['monthly', 'annual', 'one_time', 'usage']).nullish().transform((v) => v ?? null),
        unit: nullableStr,
        region: nullableStr,
        currency: nullableStr,
        value: z.string().min(1),
        numericValue: z.number().nullish().transform((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)),
        sourceRole: z.enum(['user', 'assistant']),
        evidenceText: z.string().min(1),
      }),
    )
    .default([]),
});
export type ExtractionOutput = z.infer<typeof ExtractionSchema>;
