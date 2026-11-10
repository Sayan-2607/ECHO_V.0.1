import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../server/config.js';

describe('configuration validation', () => {
  it('lists every missing required variable with a fix hint', () => {
    try {
      loadConfig({});
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as Error).message;
      expect(msg).toContain('OPENAI_API_KEY is required');
      expect(msg).toContain('OPENAI_MODEL is required');
      expect(msg).toContain('TAVILY_API_KEY is required');
      expect(msg).toContain('cp .env.example .env');
    }
  });

  it('rejects invalid numbers and timezones, applies defaults', () => {
    expect(() => loadConfig({ OPENAI_API_KEY: 'k', OPENAI_MODEL: 'm', TAVILY_API_KEY: 't', MAX_TOOL_CALLS: '0' })).toThrow(/MAX_TOOL_CALLS must be an integer/);
    expect(() => loadConfig({ OPENAI_API_KEY: 'k', OPENAI_MODEL: 'm', TAVILY_API_KEY: 't', APP_TIMEZONE: 'Mars/Base' })).toThrow(/valid IANA timezone/);
    const c = loadConfig({ OPENAI_API_KEY: 'k', OPENAI_MODEL: 'm', TAVILY_API_KEY: 't' });
    expect(c).toMatchObject({ port: 3000, maxToolCalls: 4, searchCacheTtlSeconds: 900, appTimezone: 'Asia/Kolkata', databasePath: './data/echo.db' });
  });
});
