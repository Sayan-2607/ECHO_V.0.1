import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { Conversation } from '../lib/types';

export function useConversations() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const refresh = useCallback(async (q = query) => {
    const n = ++seq.current;
    try {
      const { conversations } = await api.listConversations(q.trim() || undefined);
      if (n === seq.current) {
        setConversations(conversations);
        setError(null);
      }
    } catch (e) {
      if (n === seq.current) setError((e as Error).message);
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    const t = setTimeout(() => void refresh(query), query ? 200 : 0);
    return () => clearTimeout(t);
  }, [query, refresh]);

  const rename = useCallback(async (id: string, title: string) => {
    const { conversation } = await api.rename(id, title);
    setConversations((cs) => cs.map((c) => (c.id === id ? { ...c, title: conversation.title } : c)));
  }, []);

  const remove = useCallback(async (id: string) => {
    await api.remove(id);
    setConversations((cs) => cs.filter((c) => c.id !== id));
  }, []);

  return { conversations, query, setQuery, loading, error, refresh, rename, remove };
}
