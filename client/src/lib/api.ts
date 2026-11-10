import type { Conversation, Message, ServerConfig } from './types';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listConversations: (q?: string) =>
    fetch(`/api/conversations${q ? `?q=${encodeURIComponent(q)}` : ''}`).then((r) => json<{ conversations: Conversation[] }>(r)),
  getConversation: (id: string) =>
    fetch(`/api/conversations/${id}`).then((r) => json<{ conversation: Conversation; messages: Message[]; active: boolean }>(r)),
  rename: (id: string, title: string) =>
    fetch(`/api/conversations/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) }).then((r) =>
      json<{ conversation: Conversation }>(r),
    ),
  remove: async (id: string) => {
    const r = await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
    if (!r.ok && r.status !== 404) throw new Error('Delete failed');
  },
  config: () => fetch('/api/config').then((r) => json<ServerConfig>(r)),
  health: () => fetch('/api/health').then((r) => json<{ status: string }>(r)),
};

export interface SSEEvent {
  event: string;
  data: any;
}

/** POSTs to /api/chat and yields Server-Sent Events as they arrive. */
export async function* streamChat(body: { conversationId: string | null; message: string; timezone: string }, signal: AbortSignal): AsyncGenerator<SSEEvent> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({ error: `Request failed (${res.status})` }));
    throw new Error((err as { error?: string }).error ?? 'Request failed');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data.push(line.slice(6));
      }
      if (data.length) yield { event, data: JSON.parse(data.join('\n')) };
    }
  }
}
