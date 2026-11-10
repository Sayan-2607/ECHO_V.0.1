import OpenAI from 'openai';
import type { z } from 'zod';
import type { Logger } from '../utils/logger.js';

/**
 * Provider-neutral LLM interface. Each call names its pipeline `stage` so calls can be
 * logged, budgeted and (in tests) scripted deterministically.
 */
export interface LLMClient {
  completeJSON<T>(args: {
    stage: string;
    system: string;
    user: string;
    schema: z.ZodType<T>;
    signal?: AbortSignal;
    temperature?: number;
  }): Promise<T>;
  streamText(args: {
    stage: string;
    system: string;
    user: string;
    signal?: AbortSignal;
    onToken: (t: string) => void;
    temperature?: number;
  }): Promise<string>;
}

export class LLMError extends Error {
  constructor(message: string, public readonly stage: string) {
    super(message);
  }
}

/** Any OpenAI-compatible chat-completions endpoint (OpenAI, OpenRouter, vLLM, Together, …). */
export class OpenAICompatibleLLM implements LLMClient {
  private client: OpenAI;
  constructor(
    opts: { apiKey: string; model: string; baseURL?: string; timeoutMs?: number },
    private logger: Logger,
  ) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL, maxRetries: 2, timeout: opts.timeoutMs ?? 60000 });
    this.model = opts.model;
  }
  private model: string;

  async completeJSON<T>(args: {
    stage: string;
    system: string;
    user: string;
    schema: z.ZodType<T>;
    signal?: AbortSignal;
    temperature?: number;
  }): Promise<T> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: args.system },
      { role: 'user', content: args.user },
    ];
    for (let attempt = 1; attempt <= 2; attempt++) {
      const started = Date.now();
      const res = await this.client.chat.completions.create(
        { model: this.model, messages, temperature: args.temperature ?? 0, response_format: { type: 'json_object' } },
        { signal: args.signal },
      );
      const text = res.choices[0]?.message?.content ?? '';
      this.logger.debug('llm json', { stage: args.stage, attempt, ms: Date.now() - started, usage: res.usage });
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      const result = args.schema.safeParse(parsed);
      if (result.success) return result.data;
      const issues = parsed === undefined ? 'Output was not valid JSON.' : JSON.stringify(result.error.issues.slice(0, 5));
      this.logger.warn('llm json validation failed', { stage: args.stage, attempt, issues });
      messages.push({ role: 'assistant', content: text });
      messages.push({ role: 'user', content: `Your output did not match the required JSON schema: ${issues}. Return corrected JSON only.` });
    }
    throw new LLMError('model returned invalid structured output twice', args.stage);
  }

  async streamText(args: {
    stage: string;
    system: string;
    user: string;
    signal?: AbortSignal;
    onToken: (t: string) => void;
    temperature?: number;
  }): Promise<string> {
    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        stream: true,
        temperature: args.temperature ?? 0.2,
        messages: [
          { role: 'system', content: args.system },
          { role: 'user', content: args.user },
        ],
      },
      { signal: args.signal },
    );
    let full = '';
    for await (const chunk of stream) {
      const t = chunk.choices[0]?.delta?.content ?? '';
      if (t) {
        full += t;
        args.onToken(t);
      }
    }
    return full;
  }
}
