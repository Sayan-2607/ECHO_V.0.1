/**
 * E2E TEST SERVER — not the product server.
 * Runs the real app (routes, orchestrator, SQLite, built client) with the deterministic
 * ScriptedLLM and MockSearchProvider so browser tests need no API keys or network.
 */
import { join } from 'node:path';
import { openDatabase } from '../../server/database/connection.js';
import { createApp } from '../../server/app.js';
import { testConfig } from '../../server/config.js';
import { silentLogger } from '../../server/utils/logger.js';
import { MockSearchProvider, routeByKeyword, ScriptedLLM } from '../helpers/fakes.js';
import { NOW, seedConversation } from '../helpers/harness.js';
import { PG_CLAIMS, PG_SEARCH, PG_TUESDAY, CRM_MONDAY } from '../../benchmark/fixtures.js';

const db = openDatabase(':memory:');
const { app, repos } = createApp({
  config: testConfig({ requestTimeoutMs: 60000 }),
  db,
  llm: new ScriptedLLM({ claims: PG_CLAIMS, tokenDelayMs: 8 }),
  searchProvider: new MockSearchProvider(routeByKeyword(PG_SEARCH)),
  logger: silentLogger,
  clock: () => NOW,
  staticDir: join(process.cwd(), 'client', 'dist'),
});
seedConversation(repos, { title: 'Postgres hosting for a small SaaS', exchanges: [PG_TUESDAY] });
seedConversation(repos, { title: 'CRM shortlist for sales team', exchanges: [CRM_MONDAY] });
const port = Number(process.env.E2E_PORT ?? 4319);
app.listen(port, () => console.log(`e2e server on ${port}`));
