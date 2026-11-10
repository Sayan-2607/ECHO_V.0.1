import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { AgentEvent } from '../types.js';
import { NotFoundError, newRequestId, type Orchestrator } from '../agent/orchestrator.js';
import type { ConversationLocks } from '../services/conversationLocks.js';
import type { Logger } from '../utils/logger.js';

const ChatBody = z.object({
  conversationId: z.string().uuid().nullish(),
  message: z.string().trim().min(1, 'message must not be empty').max(8000, 'message is too long (max 8000 characters)'),
  timezone: z.string().max(64).optional(),
});

/**
 * POST /api/chat — streams the agent run as Server-Sent Events.
 * Events: conversation, stage, search, sources, changes, token, final, error, done.
 * Closing the connection cancels the run (searches and model calls are aborted).
 */
export function chatRouter(deps: { orchestrator: Orchestrator; locks: ConversationLocks; requestTimeoutMs: number; logger: Logger }): Router {
  const r = Router();
  r.post('/chat', async (req: Request, res: Response) => {
    const requestId = (res.locals.requestId as string) ?? newRequestId();
    const parsed = ChatBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join('; '), requestId });
      return;
    }
    const { conversationId, message, timezone } = parsed.data;
    const controller = new AbortController();
    const lockKey = conversationId ?? `new:${requestId}`;
    if (!deps.locks.tryAcquire(lockKey, controller)) {
      res.status(409).json({ error: 'A response is already being generated in this conversation. Stop it or wait for it to finish.', requestId });
      return;
    }

    res.status(200).set({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-request-id': requestId,
    });
    res.flushHeaders();

    let open = true;
    const send = (event: string, data: unknown) => {
      if (!open || res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const heartbeat = setInterval(() => open && res.write(': ping\n\n'), 15000);
    res.on('close', () => {
      open = false;
      if (!res.writableFinished) controller.abort(new Error('client disconnected'));
    });
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(deps.requestTimeoutMs)]);

    try {
      await deps.orchestrator.run({
        conversationId: conversationId ?? null,
        message,
        timezone,
        requestId,
        signal,
        emit: (e: AgentEvent) => send(e.type, e),
      });
      send('done', { requestId });
    } catch (err) {
      if (err instanceof NotFoundError) send('error', { type: 'error', error: 'Conversation not found', code: 'not_found' });
      else {
        deps.logger.error('chat failed', { requestId, error: (err as Error).message });
        send('error', { type: 'error', error: 'Internal error', code: 'internal' });
      }
      send('done', { requestId });
    } finally {
      clearInterval(heartbeat);
      deps.locks.release(lockKey, controller);
      open = false;
      if (!res.writableEnded) res.end();
    }
  });
  return r;
}
