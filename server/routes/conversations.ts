import { Router } from 'express';
import { z } from 'zod';
import type { Repositories } from '../database/repositories/index.js';
import type { ConversationLocks } from '../services/conversationLocks.js';

const IdParam = z.string().uuid();
const RenameBody = z.object({ title: z.string().trim().min(1, 'title must not be empty').max(120) });

export function conversationsRouter(deps: { repos: Repositories; locks: ConversationLocks }): Router {
  const r = Router();
  const { repos } = deps;

  r.get('/conversations', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q) {
      res.json({ conversations: repos.conversations.search(q) });
      return;
    }
    res.json({ conversations: repos.conversations.list() });
  });

  r.get('/conversations/:id', (req, res) => {
    const id = IdParam.safeParse(req.params.id);
    if (!id.success) return void res.status(400).json({ error: 'invalid conversation id' });
    const conversation = repos.conversations.get(id.data);
    if (!conversation) return void res.status(404).json({ error: 'conversation not found' });
    res.json({ conversation, messages: repos.messages.listByConversation(id.data), active: deps.locks.isActive(id.data) });
  });

  r.patch('/conversations/:id', (req, res) => {
    const id = IdParam.safeParse(req.params.id);
    if (!id.success) return void res.status(400).json({ error: 'invalid conversation id' });
    const body = RenameBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: body.error.issues.map((i) => i.message).join('; ') });
    const conv = repos.conversations.rename(id.data, body.data.title);
    if (!conv) return void res.status(404).json({ error: 'conversation not found' });
    res.json({ conversation: conv });
  });

  r.delete('/conversations/:id', (req, res) => {
    const id = IdParam.safeParse(req.params.id);
    if (!id.success) return void res.status(400).json({ error: 'invalid conversation id' });
    deps.locks.abort(id.data);
    const ok = repos.conversations.delete(id.data);
    if (!ok) return void res.status(404).json({ error: 'conversation not found' });
    res.status(204).end();
  });

  return r;
}
