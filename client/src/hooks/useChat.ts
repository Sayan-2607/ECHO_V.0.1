import { useCallback, useEffect, useRef, useState } from 'react';
import { api, streamChat } from '../lib/api';
import type { ChangeRecord, Citation, Conversation, Message, StageRecord } from '../lib/types';

export interface SearchActivity {
  query: string;
  outcome: string;
  resultCount: number;
  cached: boolean;
}

export interface LiveState {
  userText: string;
  stages: StageRecord[];
  searches: SearchActivity[];
  text: string;
  sources: Citation[];
  changes: ChangeRecord[];
}

export const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export function useChat(opts: { onConversationCreated: (c: Conversation) => void; onFinished: () => void }) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [live, setLive] = useState<LiveState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const convRef = useRef<string | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const load = useCallback(async (id: string | null) => {
    abortRef.current?.abort();
    setLive(null);
    setError(null);
    convRef.current = id;
    setConversationId(id);
    if (!id) {
      setMessages([]);
      return;
    }
    setLoading(true);
    try {
      const { messages } = await api.getConversation(id);
      if (convRef.current === id) setMessages(messages);
    } catch (e) {
      if (convRef.current === id) setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const send = useCallback(async (text: string) => {
    const message = text.trim();
    if (!message || abortRef.current) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setError(null);
    setLive({ userText: message, stages: [], searches: [], text: '', sources: [], changes: [] });
    let activeConv = convRef.current;
    try {
      for await (const ev of streamChat({ conversationId: activeConv, message, timezone: browserTimezone() }, ctrl.signal)) {
        switch (ev.event) {
          case 'conversation':
            if (!activeConv) {
              activeConv = ev.data.conversation.id;
              convRef.current = activeConv;
              setConversationId(activeConv);
              optsRef.current.onConversationCreated(ev.data.conversation);
            }
            break;
          case 'stage':
            setLive((l) => (l ? { ...l, stages: [...l.stages, ev.data.stage] } : l));
            break;
          case 'search':
            setLive((l) => (l ? { ...l, searches: [...l.searches, ev.data] } : l));
            break;
          case 'token':
            setLive((l) => (l ? { ...l, text: l.text + ev.data.text } : l));
            break;
          case 'sources':
            setLive((l) => (l ? { ...l, sources: ev.data.sources } : l));
            break;
          case 'changes':
            setLive((l) => (l ? { ...l, changes: ev.data.changes } : l));
            break;
          case 'error':
            setError(ev.data.error);
            break;
          case 'final':
            break;
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
    } finally {
      abortRef.current = null;
      // The server is the source of truth (it stores the final, validated answer or the cancelled partial).
      if (activeConv && convRef.current === activeConv) {
        // A cancelled run is persisted by the server shortly after the disconnect.
        if (ctrl.signal.aborted) await new Promise((r) => setTimeout(r, 250));
        try {
          const { messages } = await api.getConversation(activeConv);
          if (convRef.current === activeConv) setMessages(messages);
        } catch {
          /* keep what we have */
        }
      }
      setLive(null);
      optsRef.current.onFinished();
    }
  }, []);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  useEffect(() => () => abortRef.current?.abort(), []);

  return { conversationId, messages, live, error, loading, load, send, stop, streaming: live !== null };
}
