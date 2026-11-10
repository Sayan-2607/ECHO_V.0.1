import 'dotenv/config';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig } from './config.js';
import { openDatabase } from './database/connection.js';
import { createLogger } from './utils/logger.js';
import { OpenAICompatibleLLM } from './llm/client.js';
import { TavilyProvider } from './search/provider.js';
import { createApp } from './app.js';
import { SearchCache } from './search/cache.js';

function main() {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`\n${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
  const logger = createLogger(config.logLevel, { service: 'echo' });
  const db = openDatabase(config.databasePath);
  const llm = new OpenAICompatibleLLM({ apiKey: config.openaiApiKey, model: config.openaiModel, baseURL: config.openaiBaseUrl }, logger);
  const searchProvider = new TavilyProvider(config.tavilyApiKey);
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const { app } = createApp({ config, db, llm, searchProvider, logger, staticDir: join(root, 'client', 'dist') });

  const cache = new SearchCache(db, config.searchCacheTtlSeconds);
  const purge = setInterval(() => cache.purgeExpired(), 10 * 60 * 1000);
  purge.unref();

  const server = app.listen(config.port, () => {
    logger.info('ECHO server listening', { port: config.port, model: config.openaiModel, db: config.databasePath, maxToolCalls: config.maxToolCalls });
  });
  const shutdown = (sig: string) => {
    logger.info('shutting down', { signal: sig });
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
