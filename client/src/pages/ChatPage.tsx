import { useEffect, useRef, useState } from 'react';
import { Menu } from 'lucide-react';
import { useChat } from '../hooks/useChat';
import { useConversations } from '../hooks/useConversations';
import { Sidebar } from '../components/Sidebar';
import { Composer } from '../components/Composer';
import { Welcome } from '../components/Welcome';
import { AssistantMessage, UserBubble } from '../components/MessageItem';
import { ResearchActivity } from '../components/ResearchActivity';
import { Markdown } from '../components/Markdown';
import { ChangeTable } from '../components/ChangeTable';
import { EchoMark } from '../components/Logo';
import { SettingsDialog } from '../components/SettingsDialog';

export function ChatPage() {
  const convs = useConversations();
  const chat = useChat({ onConversationCreated: () => void convs.refresh(), onFinished: () => void convs.refresh() });
  const [settings, setSettings] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Keep the URL hash in sync so a refresh reopens the same conversation.
  useEffect(() => {
    const id = location.hash.slice(1);
    if (id) void chat.load(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const next = chat.conversationId ? `#${chat.conversationId}` : '';
    if (location.hash !== next) history.replaceState(null, '', next || location.pathname);
  }, [chat.conversationId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat.messages, chat.live]);

  const select = (id: string | null) => {
    setSidebarOpen(false);
    stick.current = true;
    void chat.load(id);
  };
  const empty = !chat.messages.length && !chat.live && !chat.loading;

  return (
    <div className="flex h-full">
      <div className={`fixed inset-y-0 left-0 z-40 transition-transform md:static md:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <Sidebar
          conversations={convs.conversations}
          activeId={chat.conversationId}
          query={convs.query}
          onQuery={convs.setQuery}
          onSelect={select}
          onNew={() => select(null)}
          onRename={convs.rename}
          onDelete={async (id) => {
            await convs.remove(id);
            if (id === chat.conversationId) select(null);
          }}
          onSettings={() => setSettings(true)}
          error={convs.error}
        />
      </div>
      {sidebarOpen && <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setSidebarOpen(false)} />}

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-ink-700/60 px-4 py-2.5 md:hidden">
          <button onClick={() => setSidebarOpen(true)} aria-label="Open sidebar" className="text-ink-300">
            <Menu size={18} />
          </button>
          <span className="truncate text-[13.5px] text-ink-200">{convs.conversations.find((c) => c.id === chat.conversationId)?.title ?? 'New conversation'}</span>
        </header>

        <div
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
          className="flex flex-1 flex-col overflow-y-auto"
        >
          {empty ? (
            <Welcome onPick={(t) => void chat.send(t)} />
          ) : (
            <div className="mx-auto w-full max-w-3xl space-y-7 px-4 py-8">
              {chat.messages.map((m) => (m.role === 'user' ? <UserBubble key={m.id} text={m.content} time={m.createdAt} /> : <AssistantMessage key={m.id} message={m} />))}
              {chat.live && (
                <>
                  <UserBubble text={chat.live.userText} />
                  <div className="flex gap-3">
                    <EchoMark className="mt-1 h-6 w-6 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <ResearchActivity stages={chat.live.stages} searches={chat.live.searches} live />
                      {chat.live.text ? (
                        <div className="caret">
                          <Markdown text={chat.live.text} sources={chat.live.sources} />
                        </div>
                      ) : (
                        !chat.live.stages.length && <p className="text-[13px] text-ink-500">Connecting…</p>
                      )}
                      {chat.live.changes.length > 0 && <ChangeTable changes={chat.live.changes} sources={chat.live.sources} />}
                    </div>
                  </div>
                </>
              )}
              {chat.error && <p className="rounded-lg border border-up/30 bg-up/5 px-3 py-2 text-[13px] text-up">{chat.error}</p>}
            </div>
          )}
        </div>

        <div className="mx-auto w-full max-w-3xl px-4 pb-4">
          <Composer onSend={(t) => { stick.current = true; void chat.send(t); }} onStop={chat.stop} streaming={chat.streaming} focusKey={chat.conversationId} />
          <p className="mt-2 text-center text-[11px] text-ink-500">ECHO searches the web with one tool and cites what it finds. Check important figures at the source.</p>
        </div>
      </main>
      {settings && <SettingsDialog onClose={() => setSettings(false)} />}
    </div>
  );
}
