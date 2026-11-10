import { z } from 'zod';

const intFromEnv = (def: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return def;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: 'custom', message: `must be an integer between ${min} and ${max}` });
        return z.NEVER;
      }
      return n;
    });

const isValidTimezone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const EnvSchema = z.object({
  OPENAI_API_KEY: z.string({ error: 'is required (key for an OpenAI-compatible endpoint)' }).trim().min(1, 'is required (key for an OpenAI-compatible endpoint)'),
  OPENAI_MODEL: z.string({ error: 'is required (e.g. gpt-4.1-mini)' }).trim().min(1, 'is required (e.g. gpt-4.1-mini)'),
  OPENAI_BASE_URL: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined)),
  TAVILY_API_KEY: z.string({ error: 'is required (get one at https://tavily.com)' }).trim().min(1, 'is required (get one at https://tavily.com)'),
  PORT: intFromEnv(3000, 1, 65535),
  DATABASE_PATH: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : './data/echo.db')),
  APP_TIMEZONE: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : 'Asia/Kolkata'))
    .refine(isValidTimezone, 'must be a valid IANA timezone, e.g. Asia/Kolkata'),
  MAX_TOOL_CALLS: intFromEnv(4, 1, 20),
  SEARCH_CACHE_TTL_SECONDS: intFromEnv(900, 0, 86400),
  SEARCH_TIMEOUT_MS: intFromEnv(12000, 1000, 60000),
  SEARCH_MAX_RETRIES: intFromEnv(2, 0, 5),
  SEARCH_MAX_RESULTS: intFromEnv(5, 1, 10),
  REQUEST_TIMEOUT_MS: intFromEnv(120000, 5000, 600000),
  MEMORY_TOKEN_BUDGET: intFromEnv(3000, 500, 20000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).optional().default('info'),
});

export type AppConfig = {
  openaiApiKey: string;
  openaiModel: string;
  openaiBaseUrl?: string;
  tavilyApiKey: string;
  port: number;
  databasePath: string;
  appTimezone: string;
  maxToolCalls: number;
  searchCacheTtlSeconds: number;
  searchTimeoutMs: number;
  searchMaxRetries: number;
  searchMaxResults: number;
  requestTimeoutMs: number;
  memoryTokenBudget: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
};

export class ConfigError extends Error {}

/** Validates environment variables and returns a typed config. Throws ConfigError with a readable report. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  • ${i.path.join('.')} ${i.message}`);
    throw new ConfigError(
      [
        'ECHO cannot start: configuration is invalid.',
        ...lines,
        '',
        'Fix: copy .env.example to .env and fill in the required values:',
        '  cp .env.example .env',
      ].join('\n'),
    );
  }
  const e = parsed.data;
  return {
    openaiApiKey: e.OPENAI_API_KEY,
    openaiModel: e.OPENAI_MODEL,
    openaiBaseUrl: e.OPENAI_BASE_URL,
    tavilyApiKey: e.TAVILY_API_KEY,
    port: e.PORT,
    databasePath: e.DATABASE_PATH,
    appTimezone: e.APP_TIMEZONE,
    maxToolCalls: e.MAX_TOOL_CALLS,
    searchCacheTtlSeconds: e.SEARCH_CACHE_TTL_SECONDS,
    searchTimeoutMs: e.SEARCH_TIMEOUT_MS,
    searchMaxRetries: e.SEARCH_MAX_RETRIES,
    searchMaxResults: e.SEARCH_MAX_RESULTS,
    requestTimeoutMs: e.REQUEST_TIMEOUT_MS,
    memoryTokenBudget: e.MEMORY_TOKEN_BUDGET,
    logLevel: e.LOG_LEVEL,
  };
}

/** Config for tests/benchmarks: no secrets needed because LLM and search are injected fakes. */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    openaiApiKey: 'test',
    openaiModel: 'test-model',
    tavilyApiKey: 'test',
    port: 0,
    databasePath: ':memory:',
    appTimezone: 'Asia/Kolkata',
    maxToolCalls: 4,
    searchCacheTtlSeconds: 900,
    searchTimeoutMs: 2000,
    searchMaxRetries: 2,
    searchMaxResults: 5,
    requestTimeoutMs: 30000,
    memoryTokenBudget: 3000,
    logLevel: 'silent',
    ...overrides,
  };
}
