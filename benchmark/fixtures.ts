/**
 * SYNTHETIC FIXTURE DATA for offline tests and benchmarks.
 * Prices, plan names, dates and page text below are invented test data shaped like real pages.
 * They are NOT real vendor prices and must not be read as such. Real URLs are used only so that
 * source classification (official vs third-party) can be exercised.
 */
import type { RawSearchResult } from '../server/search/normalization.js';
import type { FixtureClaim } from '../tests/helpers/fakes.js';
import type { SeedExchange } from '../tests/helpers/harness.js';

// ── CRM shortlist (Benchmark A) ───────────────────────────────────────────
export const CRM_MONDAY: SeedExchange = {
  at: '2026-11-09 11:00',
  user: 'We need a CRM for a 20-person sales team. Shortlist the best options with pricing.',
  assistant:
    'Here is a shortlist of 5 CRMs for a 20-person sales team:\n1. HubSpot Sales Hub — Professional $100/user/month (annual)\n2. Salesforce Sales Cloud — Enterprise $175/user/month (annual)\n3. Pipedrive — Professional $49/user/month (annual)\n4. Zoho CRM — Professional $23/user/month (annual)\n5. Freshsales — Pro $39/user/month (annual)',
  entities: [
    { name: 'HubSpot', relation: 'shortlisted' },
    { name: 'Salesforce', relation: 'shortlisted' },
    { name: 'Pipedrive', relation: 'shortlisted' },
    { name: 'Zoho CRM', relation: 'shortlisted' },
    { name: 'Freshsales', relation: 'shortlisted' },
  ],
  snapshots: [
    { entity: 'HubSpot', category: 'price', plan: 'Professional', billingPeriod: 'annual', unit: 'per user', currency: 'USD', value: '$100/user/month billed annually', numericValue: 100, sourceUrl: 'https://www.hubspot.com/pricing/sales' },
    { entity: 'Salesforce', category: 'price', plan: 'Enterprise', billingPeriod: 'annual', unit: 'per user', currency: 'USD', value: '$175/user/month billed annually', numericValue: 175, sourceUrl: 'https://www.salesforce.com/sales/pricing' },
    { entity: 'Pipedrive', category: 'price', plan: 'Professional', billingPeriod: 'annual', unit: 'per user', currency: 'USD', value: '$49/user/month billed annually', numericValue: 49, sourceUrl: 'https://www.pipedrive.com/en/pricing' },
    { entity: 'Zoho CRM', category: 'price', plan: 'Professional', billingPeriod: 'annual', unit: 'per user', currency: 'USD', value: '$23/user/month billed annually', numericValue: 23, sourceUrl: 'https://www.zoho.com/crm/zohocrm-pricing.html' },
    { entity: 'Freshsales', category: 'price', plan: 'Pro', billingPeriod: 'annual', unit: 'per user', currency: 'USD', value: '$39/user/month billed annually', numericValue: 39, sourceUrl: 'https://www.freshworks.com/crm/pricing' },
  ],
};

export const CRM_SEARCH: Record<string, RawSearchResult[]> = {
  hubspot: [{ url: 'https://www.hubspot.com/pricing/sales', title: 'HubSpot Sales Hub pricing', content: 'Sales Hub Professional: $100 per seat/month, billed annually. Starter: $20 per seat/month.' }],
  salesforce: [{ url: 'https://www.salesforce.com/sales/pricing', title: 'Sales Cloud pricing', content: 'Enterprise: $190 USD/user/month (billed annually). Unlimited: $350 USD/user/month.' }],
  pipedrive: [
    { url: 'https://www.pipedrive.com/en/pricing', title: 'Pipedrive pricing', content: 'Professional $49 per seat/month billed annually.' },
    { url: 'https://www.pipedrive.com/en/blog/ai-sales-assistant-2', title: 'Introducing AI Sales Assistant 2.0', content: 'On 10 November 2026 we launched AI Sales Assistant 2.0 for all paid plans.', published_date: '2026-11-10' },
  ],
  // "Zoho CRM vs Freshsales" shared query: only Zoho evidence comes back.
  zoho: [{ url: 'https://www.zoho.com/crm/zohocrm-pricing.html', title: 'Zoho CRM pricing', content: 'Professional: $23/user/month billed annually.' }],
};

export const CRM_CLAIMS: FixtureClaim[] = [
  { url: 'https://www.hubspot.com/pricing/sales', entity: 'HubSpot', category: 'price', plan: 'Professional', billingPeriod: 'annual', unit: 'per user', currency: 'USD', value: '$100 per seat/month, billed annually', numericValue: 100, quote: 'Sales Hub Professional: $100 per seat/month, billed annually' },
  { url: 'https://www.salesforce.com/sales/pricing', entity: 'Salesforce', category: 'price', plan: 'Enterprise', billingPeriod: 'annual', unit: 'per user', currency: 'USD', value: '$190/user/month billed annually', numericValue: 190, quote: 'Enterprise: $190 USD/user/month (billed annually)' },
  { url: 'https://www.pipedrive.com/en/pricing', entity: 'Pipedrive', category: 'price', plan: 'Professional', billingPeriod: 'annual', unit: 'per user', currency: 'USD', value: '$49 per seat/month billed annually', numericValue: 49, quote: 'Professional $49 per seat/month billed annually' },
  { url: 'https://www.pipedrive.com/en/blog/ai-sales-assistant-2', entity: 'Pipedrive', category: 'launch', value: 'Launched AI Sales Assistant 2.0', quote: 'we launched AI Sales Assistant 2.0', eventDate: '2026-11-10', status: 'released' },
  { url: 'https://www.zoho.com/crm/zohocrm-pricing.html', entity: 'Zoho CRM', category: 'price', plan: 'Professional', billingPeriod: 'annual', unit: 'per user', currency: 'USD', value: '$23/user/month billed annually', numericValue: 23, quote: 'Professional: $23/user/month billed annually' },
];

// ── Postgres hosting (Benchmark C) ────────────────────────────────────────
export const PG_TUESDAY: SeedExchange = {
  at: '2026-11-03 10:15',
  user: 'Which managed Postgres hosting should I use for a small SaaS? Compare Neon, Supabase and Render.',
  assistant: 'For a small SaaS: Neon Launch is $19/month; Supabase Pro is $25/month. I did not find Render pricing details.',
  entities: [
    { name: 'Neon', relation: 'researched' },
    { name: 'Supabase', relation: 'researched' },
    { name: 'Render', relation: 'mentioned' },
  ],
  snapshots: [
    { entity: 'Neon', category: 'price', plan: 'Launch', billingPeriod: 'monthly', currency: 'USD', value: '$19/month', numericValue: 19, sourceUrl: 'https://neon.tech/pricing' },
    { entity: 'Supabase', category: 'price', plan: 'Pro', billingPeriod: 'monthly', currency: 'USD', value: '$25/month', numericValue: 25, sourceUrl: 'https://supabase.com/pricing' },
  ],
};

export const PG_SEARCH: Record<string, RawSearchResult[]> = {
  neon: [{ url: 'https://neon.tech/pricing', title: 'Neon pricing', content: 'Launch $25/month. Scale $69/month.', published_date: '2026-11-07' }],
  supabase: [{ url: 'https://supabase.com/pricing', title: 'Supabase pricing', content: 'Pro: $25 per month per organization.' }],
  render: [{ url: 'https://render.com/pricing', title: 'Render pricing', content: 'Postgres Basic-256mb: $6/month.' }],
};

export const PG_CLAIMS: FixtureClaim[] = [
  { url: 'https://neon.tech/pricing', entity: 'Neon', category: 'price', plan: 'Launch', billingPeriod: 'monthly', currency: 'USD', value: '$25/month', numericValue: 25, quote: 'Launch $25/month' },
  { url: 'https://supabase.com/pricing', entity: 'Supabase', category: 'price', plan: 'Pro', billingPeriod: 'monthly', currency: 'USD', value: '$25 per month', numericValue: 25, quote: 'Pro: $25 per month' },
  { url: 'https://render.com/pricing', entity: 'Render', category: 'price', plan: 'Basic-256mb', billingPeriod: 'monthly', currency: 'USD', value: '$6/month', numericValue: 6, quote: 'Postgres Basic-256mb: $6/month' },
];

// ── 3 November questions (Benchmark B) ────────────────────────────────────
export const NOV3_QUESTIONS: SeedExchange[] = [
  {
    at: '2026-11-03 09:30',
    user: 'What is the price of the Vercel Pro plan?',
    assistant: 'Vercel Pro costs $20 per user per month.',
    entities: [{ name: 'Vercel', relation: 'researched' }],
    snapshots: [{ entity: 'Vercel', category: 'price', plan: 'Pro', billingPeriod: 'monthly', unit: 'per user', currency: 'USD', value: '$20 per user per month', numericValue: 20, sourceUrl: 'https://vercel.com/pricing' }],
  },
];
export const NOV3_SECOND: SeedExchange = { at: '2026-11-03 16:00', user: 'Explain how B-tree indexes work', assistant: 'A B-tree keeps keys sorted in balanced pages…' };

export const VERCEL_SEARCH: Record<string, RawSearchResult[]> = {
  vercel: [{ url: 'https://vercel.com/pricing', title: 'Vercel pricing', content: 'Pro — $20/user/month. Includes $20 of usage credit.' }],
};
export const VERCEL_CLAIMS: FixtureClaim[] = [
  { url: 'https://vercel.com/pricing', entity: 'Vercel', category: 'price', plan: 'Pro', billingPeriod: 'monthly', unit: 'per user', currency: 'USD', value: '$20/user/month', numericValue: 20, quote: 'Pro — $20/user/month' },
];
