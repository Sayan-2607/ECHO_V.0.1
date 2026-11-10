import { useState } from 'react';
import { Check, MessageSquarePlus, Pencil, Search, Settings, Trash2, X } from 'lucide-react';
import type { Conversation } from '../lib/types';
import { EchoLogo } from './Logo';

function groupLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(d)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'Previous 7 days';
  if (days < 30) return 'Previous 30 days';
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

interface Props {
  conversations: Conversation[];
  activeId: string | null;
  query: string;
  onQuery: (q: string) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onSettings: () => void;
  error: string | null;
}

export function Sidebar(p: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const groups = new Map<string, Conversation[]>();
  for (const c of p.conversations) {
    const k = p.query ? 'Matches' : groupLabel(c.updatedAt);
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }

  const saveRename = async (id: string) => {
    const t = draft.trim();
    if (t) await p.onRename(id, t).catch(() => undefined);
    setEditing(null);
  };

  return (
    <aside className="flex h-full w-[272px] flex-col border-r border-ink-700/80 bg-ink-950">
      <div className="px-4 pt-4 pb-3">
        <EchoLogo />
      </div>
      <div className="px-3">
        <button onClick={p.onNew} className="flex w-full items-center gap-2 rounded-lg border border-ink-700 px-3 py-2 text-[13.5px] text-ink-200 transition-colors hover:border-ink-500 hover:text-white">
          <MessageSquarePlus size={15} /> New conversation
        </button>
        <label className="mt-2 flex items-center gap-2 rounded-lg bg-ink-850 px-3 py-1.5 text-ink-400 focus-within:ring-1 focus-within:ring-ink-600">
          <Search size={14} />
          <input
            value={p.query}
            onChange={(e) => p.onQuery(e.target.value)}
            placeholder="Search history"
            aria-label="Search conversation history"
            className="w-full bg-transparent text-[13px] text-ink-100 placeholder:text-ink-500 focus:outline-none"
          />
          {p.query && (
            <button onClick={() => p.onQuery('')} aria-label="Clear search">
              <X size={13} />
            </button>
          )}
        </label>
      </div>

      <nav className="mt-3 flex-1 overflow-y-auto px-2 pb-3">
        {p.error && <p className="px-2 py-2 text-[12.5px] text-up">{p.error}</p>}
        {!p.conversations.length && !p.error && (
          <p className="px-2 py-2 text-[12.5px] text-ink-500">{p.query ? 'No conversations match.' : 'No conversations yet.'}</p>
        )}
        {[...groups.entries()].map(([label, items]) => (
          <div key={label} className="mb-3">
            <p className="px-2 pb-1 font-mono text-[10.5px] uppercase tracking-wider text-ink-500">{label}</p>
            {items.map((c) => (
              <div
                key={c.id}
                className={`group relative rounded-lg ${c.id === p.activeId ? 'bg-ink-800 text-white' : 'text-ink-300 hover:bg-ink-850 hover:text-ink-100'}`}
              >
                {editing === c.id ? (
                  <div className="flex items-center gap-1 px-2 py-1.5">
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveRename(c.id);
                        if (e.key === 'Escape') setEditing(null);
                      }}
                      maxLength={120}
                      aria-label="Conversation title"
                      className="min-w-0 flex-1 rounded bg-ink-700 px-1.5 py-0.5 text-[13px] text-white focus:outline-none"
                    />
                    <button onClick={() => void saveRename(c.id)} aria-label="Save title" className="p-1 text-ink-300 hover:text-white">
                      <Check size={14} />
                    </button>
                  </div>
                ) : confirmDelete === c.id ? (
                  <div className="flex items-center justify-between gap-2 px-2.5 py-2 text-[12.5px]">
                    <span className="text-ink-200">Delete permanently?</span>
                    <span className="flex gap-2">
                      <button onClick={() => void p.onDelete(c.id).finally(() => setConfirmDelete(null))} className="text-up hover:underline">
                        Delete
                      </button>
                      <button onClick={() => setConfirmDelete(null)} className="text-ink-400 hover:text-ink-200">
                        Cancel
                      </button>
                    </span>
                  </div>
                ) : (
                  <>
                    <button onClick={() => p.onSelect(c.id)} className="block w-full truncate px-2.5 py-2 pr-14 text-left text-[13.5px]" title={c.title}>
                      {c.title}
                      {c.snippet && <span className="mt-0.5 block truncate text-[11.5px] text-ink-500">{c.snippet.replace(/[«»]/g, '')}</span>}
                    </button>
                    <span className="absolute top-1.5 right-1.5 hidden gap-0.5 group-hover:flex group-focus-within:flex">
                      <button
                        onClick={() => {
                          setDraft(c.title);
                          setEditing(c.id);
                        }}
                        aria-label="Rename conversation"
                        className="rounded p-1 text-ink-400 hover:bg-ink-700 hover:text-white"
                      >
                        <Pencil size={13} />
                      </button>
                      <button onClick={() => setConfirmDelete(c.id)} aria-label="Delete conversation" className="rounded p-1 text-ink-400 hover:bg-ink-700 hover:text-up">
                        <Trash2 size={13} />
                      </button>
                    </span>
                  </>
                )}
              </div>
            ))}
          </div>
        ))}
      </nav>

      <div className="border-t border-ink-700/80 p-2">
        <button onClick={p.onSettings} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-ink-300 hover:bg-ink-850 hover:text-white">
          <Settings size={15} /> Settings
        </button>
      </div>
    </aside>
  );
}
