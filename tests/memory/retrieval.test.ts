import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../server/database/connection.js';
import { createRepositories } from '../../server/database/repositories/index.js';
import { retrieveContext } from '../../server/memory/retrieval.js';
import { resolveTargetEntities } from '../../server/agent/planner.js';
import { heuristicUnderstanding, type Understanding } from '../../server/agent/understand.js';
import { resolveTimeReferences } from '../../server/utils/timeResolver.js';
import { NOW, TZ, seedConversation } from '../helpers/harness.js';

function setup() {
  const repos = createRepositories(openDatabase(':memory:'));
  const current = repos.conversations.create({ title: 'today', timezone: TZ, now: NOW.getTime() });
  const msg = repos.messages.insert({ conversationId: current.id, role: 'user', content: 'x', createdAt: NOW.getTime() });
  return { repos, current, msg };
}
const understandOf = (text: string, patch: Partial<Understanding> = {}): Understanding => ({
  ...heuristicUnderstanding(text, resolveTimeReferences(text, NOW, TZ), NOW.getTime(), TZ),
  ...patch,
});

describe('memory retrieval', () => {
  it('retrieves the conversation from a particular date (test 2)', () => {
    const { repos, current, msg } = setup();
    seedConversation(repos, { title: 'Hosting', exchanges: [{ at: '2026-11-02 18:00', user: 'Unrelated Monday question about Kafka', assistant: 'Kafka is…' }] });
    const target = seedConversation(repos, {
      title: 'Postgres hosting',
      exchanges: [{ at: '2026-11-03 10:15', user: 'Compare Postgres hosting: Neon vs Supabase', assistant: 'Neon Launch is $19/month…' }],
    });
    const u = understandOf('Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?', { searchTerms: ['Postgres', 'hosting'] });
    const ctx = retrieveContext({ repos, conversationId: current.id, currentMessageId: msg.id, understanding: u });
    expect(ctx.referenced).toHaveLength(1);
    expect(ctx.referenced[0]!.conversation.id).toBe(target);
    expect(ctx.referenced[0]!.exchanges[0]!.assistantMessage?.content).toContain('$19');
  });

  it('retrieves multiple entities from an earlier discussion, preferring the shortlist (test 3)', () => {
    const { repos, current, msg } = setup();
    seedConversation(repos, {
      title: 'CRM for sales team',
      exchanges: [
        {
          at: '2026-11-09 11:00',
          user: 'We need a CRM for a 20-person sales team',
          assistant: 'Shortlist: HubSpot, Salesforce, Pipedrive, Zoho CRM, Freshsales. Also considered Monday.com.',
          entities: [
            { name: 'HubSpot', relation: 'shortlisted' },
            { name: 'Salesforce', relation: 'shortlisted' },
            { name: 'Pipedrive', relation: 'shortlisted' },
            { name: 'Zoho CRM', relation: 'shortlisted' },
            { name: 'Freshsales', relation: 'shortlisted' },
            { name: 'Monday.com', relation: 'mentioned' },
          ],
        },
      ],
    });
    const u = understandOf('On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing?', { searchTerms: ['CRM', 'sales team'], expectedEntityCount: 5 });
    const ctx = retrieveContext({ repos, conversationId: current.id, currentMessageId: msg.id, understanding: u });
    const { targets, note } = resolveTargetEntities(u, ctx);
    expect(targets).toEqual(['HubSpot', 'Salesforce', 'Pipedrive', 'Zoho CRM', 'Freshsales']);
    expect(note).toBeNull();
  });

  it('flags a mismatch between the stated count and stored entities instead of inventing items', () => {
    const { repos, current, msg } = setup();
    seedConversation(repos, {
      title: 'CRM',
      exchanges: [{ at: '2026-11-09 11:00', user: 'CRM options?', assistant: 'HubSpot and Pipedrive', entities: [{ name: 'HubSpot', relation: 'shortlisted' }, { name: 'Pipedrive', relation: 'shortlisted' }] }],
    });
    const u = understandOf('On Monday we shortlisted 5 CRM tools', { searchTerms: ['CRM'], expectedEntityCount: 5 });
    const ctx = retrieveContext({ repos, conversationId: current.id, currentMessageId: msg.id, understanding: u });
    const { targets, note } = resolveTargetEntities(u, ctx);
    expect(targets).toEqual(['HubSpot', 'Pipedrive']);
    expect(note).toMatch(/5 items.*contains 2/);
  });

  it('asks for disambiguation when several questions were asked that day', () => {
    const { repos, current, msg } = setup();
    seedConversation(repos, { title: 'A', exchanges: [{ at: '2026-11-03 09:00', user: 'What is the capital of Peru?', assistant: 'Lima.' }] });
    seedConversation(repos, { title: 'B', exchanges: [{ at: '2026-11-03 15:00', user: 'Best laptop for ML?', assistant: '…' }] });
    const u = understandOf('What did I ask you on 3 November? Is your answer still correct today?');
    const ctx = retrieveContext({ repos, conversationId: current.id, currentMessageId: msg.id, understanding: u });
    expect(ctx.needsDisambiguation).toBe(true);
    expect(ctx.candidateQuestions.map((c) => c.message.content)).toEqual(['What is the capital of Peru?', 'Best laptop for ML?']);
  });

  it('reports when nothing is stored for the date', () => {
    const { repos, current, msg } = setup();
    const u = understandOf('What did I ask you yesterday?');
    const ctx = retrieveContext({ repos, conversationId: current.id, currentMessageId: msg.id, understanding: u });
    expect(ctx.referenced).toEqual([]);
    expect(ctx.notes[0]).toMatch(/No stored messages from Mon 9 Nov 2026/);
  });

  it('does not load history for questions that do not reference the past', () => {
    const { repos, current, msg } = setup();
    seedConversation(repos, { title: 'A', exchanges: [{ at: '2026-11-03 09:00', user: 'Postgres?', assistant: 'yes' }] });
    const u = understandOf('Explain what PostgreSQL is', { intent: 'general_knowledge', referencesPast: false });
    const ctx = retrieveContext({ repos, conversationId: current.id, currentMessageId: msg.id, understanding: u });
    expect(ctx.historical).toBe(false);
    expect(ctx.referenced).toEqual([]);
  });
});
