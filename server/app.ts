import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from './config.js';
import type { DB } from './database/connection.js';
import { createRepositories, type Repositories } from './database/repositories/index.js';
import type { LLMClient } from './llm/client.js';
import type { SearchProvider } from './search/provider.js';
import { SearchCache } from './search/cache.js';
import { WebSearchService } from './search/webSearch.js';
import { Orchestrator } from './agent/orchestrator.js';
import { ConversationLocks } from './services/conversationLocks.js';
import { chatRouter } from './routes/chat.js';
import { conversationsRouter } from './routes/conversations.js';
import type { Logger } from './utils/logger.js';
import { AGENT_TOOLS } from './agent/tools.js';

export interface AppDeps {
  config: AppConfig;
  db: DB;
  llm: LLMClient;
  searchProvider: SearchProvider;
  logger: Logger;
  clock?: () => Date;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  staticDir?: string;
}

export interface EchoApp {
  app: express.Express;
  repos: Repositories;
  orchestrator: Orchestrator;
  locks: ConversationLocks;
  search: WebSearchService;
}

/** Composition root. All external dependencies are injected so tests run without network or secrets. */
export function createApp(deps: AppDeps): EchoApp {
  const repos = createRepositories(deps.db);
  const cache = new SearchCache(deps.db, deps.config.searchCacheTtlSeconds);
  const search = new WebSearchService(
    deps.searchProvider,
    cache,
    { timeoutMs: deps.config.searchTimeoutMs, maxRetries: deps.config.searchMaxRetries, maxResults: deps.config.searchMaxResults },
    deps.logger,
    deps.sleep,
  );
  const orchestrator = new Orchestrator({ repos, llm: deps.llm, search, config: deps.config, logger: deps.logger, clock: deps.clock });
  const locks = new ConversationLocks();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = randomUUID();
    res.locals.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    const started = Date.now();
    res.on('finish', () => {
      if (req.path.startsWith('/api')) deps.logger.info('http', { requestId, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started });
    });
    next();
  });

  app.get('/api/health', (_req, res) => {
    let dbOk = true;
    try {
      deps.db.prepare('SELECT 1').get();
    } catch {
      dbOk = false;
    }
    res.status(dbOk ? 200 : 503).json({ status: dbOk ? 'ok' : 'degraded', database: dbOk ? 'ok' : 'error', activeRuns: locks.size, time: new Date().toISOString() });
  });

  // Non-secret runtime settings for the Settings panel.
  app.get('/api/config', (_req, res) => {
    res.json({
      model: deps.config.openaiModel,
      modelEndpoint: deps.config.openaiBaseUrl ? 'custom OpenAI-compatible endpoint' : 'OpenAI',
      searchProvider: deps.searchProvider.name,
      tools: AGENT_TOOLS.map((t) => t.name),
      maxToolCalls: deps.config.maxToolCalls,
      searchCacheTtlSeconds: deps.config.searchCacheTtlSeconds,
      defaultTimezone: deps.config.appTimezone,
      requestTimeoutMs: deps.config.requestTimeoutMs,
    });
  });

  app.use('/api', chatRouter({ orchestrator, locks, requestTimeoutMs: deps.config.requestTimeoutMs, logger: deps.logger }));
  app.use('/api', conversationsRouter({ repos, locks }));
  app.use('/api', (_req, res) => void res.status(404).json({ error: 'not found' }));

  if (deps.staticDir && existsSync(deps.staticDir)) {
    app.use(express.static(deps.staticDir));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(join(deps.staticDir!, 'index.html')));
  }

  app.use((err: Error & { type?: string; status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === 'entity.parse.failed') return void res.status(400).json({ error: 'request body is not valid JSON' });
    if (err.type === 'entity.too.large') return void res.status(413).json({ error: 'request body too large' });
    deps.logger.error('unhandled error', { error: err.message, requestId: res.locals.requestId });
    if (!res.headersSent) res.status(500).json({ error: 'internal error', requestId: res.locals.requestId });
  });

  return { app, repos, orchestrator, locks, search };
}
