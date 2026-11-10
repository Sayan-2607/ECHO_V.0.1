import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';

export function Composer({ onSend, onStop, streaming, initial, focusKey }: { onSend: (t: string) => void; onStop: () => void; streaming: boolean; initial?: string; focusKey?: string | null }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (initial) setText(initial);
  }, [initial]);
  useEffect(() => {
    ref.current?.focus();
  }, [focusKey]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const submit = () => {
    if (streaming || !text.trim()) return;
    onSend(text);
    setText('');
  };

  return (
    <div className="rounded-2xl border border-ink-700 bg-ink-850 shadow-[0_8px_30px_rgba(0,0,0,0.25)] focus-within:border-ink-500 transition-colors">
      <textarea
        ref={ref}
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="Ask anything, or ask what changed since we last spoke…"
        aria-label="Message"
        maxLength={8000}
        className="block w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-relaxed text-ink-100 placeholder:text-ink-500 focus:outline-none"
      />
      <div className="flex items-center justify-between px-3 pb-2.5">
        <span className="hidden pl-1 text-[11.5px] text-ink-500 sm:block">Enter to send · Shift + Enter for a new line</span>
        {streaming ? (
          <button onClick={onStop} aria-label="Stop generating" className="ml-auto flex items-center gap-1.5 rounded-lg border border-ink-600 px-2.5 py-1.5 text-[12.5px] text-ink-200 hover:bg-ink-700">
            <Square size={11} fill="currentColor" /> Stop
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!text.trim()}
            aria-label="Send"
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg bg-signal text-ink-950 transition-opacity disabled:opacity-25"
          >
            <ArrowUp size={17} strokeWidth={2.4} />
          </button>
        )}
      </div>
    </div>
  );
}
