import { describe, expect, it } from 'vitest';
import { MockSearchProvider, routeByKeyword, ScriptedLLM } from '../helpers/fakes.js';
import { makeApp, runAgent, seedConversation } from '../helpers/harness.js';
import { CRM_CLAIMS, CRM_MONDAY, CRM_SEARCH, NOV3_QUESTIONS, NOV3_SECOND, PG_CLAIMS, PG_SEARCH, PG_TUESDAY, VERCEL_CLAIMS, VERCEL_SEARCH } from '../../benchmark/fixtures.js';

describe('Benchmark A — historical comparison of a CRM shortlist', () => {
  it('retrieves the exact five products, compares like-for-like and reports gaps', async () => {
    const search = new MockSearchProvider(routeByKeyword(CRM_SEARCH));
    const llm = new ScriptedLLM({ claims: CRM_CLAIMS });
    const app = makeApp({ llm, search });
    seedConversation(app.repos, { title: 'CRM shortlist', exchanges: [CRM_MONDAY] });

    const { result, events } = await runAgent(app, 'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?');

    expect(result.understanding?.timeRefs[0]?.label).toBe('Mon 9 Nov 2026');
    expect(result.plan?.targetEntities).toEqual(['HubSpot', 'Salesforce', 'Pipedrive', 'Zoho CRM', 'Freshsales']);
    expect(result.toolCalls).toBeLessThanOrEqual(4);
    const byEntity = (e: string) => result.changes.filter((c) => c.entity === e);
    expect(byEntity('Salesforce')[0]).toMatchObject({ changeType: 'price_increase', historicalValue: '$175/user/month billed annually' });
    expect(byEntity('HubSpot')[0]!.changeType).toBe('unchanged');
    expect(byEntity('Pipedrive').map((c) => c.changeType).sort()).toEqual(['product_launch', 'unchanged']);
    expect(byEntity('Freshsales')[0]!.changeType).toBe('not_verified');
    // every reported change is linked to a source
    for (const c of result.changes.filter((c) => c.currentValue)) expect(c.currentSource).toMatch(/^https:\/\//);
    const final = events.find((e) => e.type === 'final');
    expect(final && final.type === 'final' && final.message.metadata.sources?.length).toBeGreaterThan(0);
    // the synthesis prompt carried the gap for Freshsales
    expect(llm.calls.find((c) => c.stage === 'synthesize')!.user).toContain('No verified current evidence for: Freshsales');
  });
});

describe('Benchmark B — conversational memory with re-check', () => {
  it('lists the questions of that day, then re-checks the chosen answer', async () => {
    const search = new MockSearchProvider(routeByKeyword(VERCEL_SEARCH));
    const llm = new ScriptedLLM({ claims: VERCEL_CLAIMS });
    const app = makeApp({ llm, search });
    seedConversation(app.repos, { title: 'Vercel', exchanges: NOV3_QUESTIONS });
    seedConversation(app.repos, { title: 'Indexes', exchanges: [NOV3_SECOND] });

    const first = await runAgent(app, 'What did I ask you on 3 November? Is your answer still correct today?');
    expect(first.result.assistantMessage.metadata.disambiguation).toBe(true);
    expect(first.result.assistantMessage.content).toContain('1. "What is the price of the Vercel Pro plan?"');
    expect(first.result.assistantMessage.content).toContain('2. "Explain how B-tree indexes work"');
    expect(first.result.toolCalls).toBe(0);
    expect(llm.stageCount('synthesize')).toBe(0); // deterministic, no model improvisation

    const second = await runAgent(app, '1', { conversationId: first.result.conversation.id });
    expect(second.result.context?.referenced[0]?.exchanges[0]?.userMessage.content).toBe('What is the price of the Vercel Pro plan?');
    expect(second.result.changes[0]).toMatchObject({ entity: 'Vercel', changeType: 'unchanged' });
    expect(second.result.verdict).toBe('still_correct');
  });

  it('answers directly when only one question was asked that day', async () => {
    const llm = new ScriptedLLM({ claims: VERCEL_CLAIMS });
    const app = makeApp({ llm, search: new MockSearchProvider(routeByKeyword(VERCEL_SEARCH)) });
    seedConversation(app.repos, { title: 'Vercel', exchanges: NOV3_QUESTIONS });
    const { result } = await runAgent(app, 'What did I ask you on 3 November? Is your answer still correct today?');
    expect(result.verdict).toBe('still_correct');
  });

  it('admits when nothing is stored for that date', async () => {
    const llm = new ScriptedLLM();
    const app = makeApp({ llm });
    const { result } = await runAgent(app, 'What did I ask you on 3 November? Is your answer still correct today?');
    expect(result.assistantMessage.content).toMatch(/don't have any stored conversation from Tue 3 Nov 2026/);
    expect(result.toolCalls).toBe(0);
  });
});

describe('Benchmark C — time-aware research', () => {
  it('compares Postgres pricing since last Tuesday without inventing a baseline', async () => {
    const llm = new ScriptedLLM({ claims: PG_CLAIMS });
    const app = makeApp({ llm, search: new MockSearchProvider(routeByKeyword(PG_SEARCH)) });
    seedConversation(app.repos, { title: 'Postgres hosting', exchanges: [PG_TUESDAY] });
    const { result } = await runAgent(app, 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?');

    expect(result.understanding?.timeRefs[0]?.label).toBe('Tue 3 Nov 2026');
    const neon = result.changes.find((c) => c.entity === 'Neon')!;
    expect(neon).toMatchObject({ changeType: 'price_increase', historicalValue: '$19/month', currentValue: '$25/month', historicalDate: '2026-11-03' });
    expect(result.changes.find((c) => c.entity === 'Supabase')!.changeType).toBe('unchanged');
    const render = result.changes.find((c) => c.entity === 'Render')!;
    expect(render.changeType).toBe('baseline_unavailable');
    expect(render.historicalValue).toBeNull();
  });
});

describe('model outage', () => {
  it('delivers verified evidence deterministically when synthesis fails', async () => {
    const llm = new ScriptedLLM({ claims: PG_CLAIMS });
    llm.streamText = async () => {
      throw new Error('Connection error.');
    };
    const app = makeApp({ llm, search: new MockSearchProvider(routeByKeyword(PG_SEARCH)) });
    seedConversation(app.repos, { title: 'Postgres hosting', exchanges: [PG_TUESDAY] });
    const { result } = await runAgent(app, 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?');
    expect(result.assistantMessage.status).toBe('complete');
    expect(result.assistantMessage.content).toContain('language model could not be reached');
    expect(result.assistantMessage.content).toMatch(/Neon · price · Launch · monthly: price increase — before: \$19\/month; now: \$25\/month \[1\]/);
  });
});
