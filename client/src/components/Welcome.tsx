import { History, RefreshCcw, Tag, CalendarCheck } from 'lucide-react';

const PROMPTS = [
  { icon: History, text: 'What has changed since our last discussion?' },
  { icon: RefreshCcw, text: 'Recheck my previous research.' },
  { icon: Tag, text: 'Find the latest pricing for these tools.' },
  { icon: CalendarCheck, text: 'What did we decide last week?' },
];

export function Welcome({ onPick }: { onPick: (t: string) => void }) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center px-4 py-10">
      <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-signal">Research with memory</p>
      <h1 className="mt-3 font-serif text-[34px] leading-tight text-ink-100 sm:text-[40px]">
        You don't have to remember what you asked yesterday.
      </h1>
      <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-ink-300">
        ECHO keeps your conversations, checks what has changed on the web since then, and shows the evidence behind every claim — including what it could not verify.
      </p>
      <div className="mt-8 grid gap-2 sm:grid-cols-2">
        {PROMPTS.map((p) => (
          <button
            key={p.text}
            onClick={() => onPick(p.text)}
            className="group flex items-start gap-3 rounded-xl border border-ink-700 bg-ink-850 px-4 py-3 text-left text-[14px] text-ink-200 transition-colors hover:border-ink-500 hover:text-white"
          >
            <p.icon size={16} className="mt-0.5 shrink-0 text-ink-400 group-hover:text-signal" />
            {p.text}
          </button>
        ))}
      </div>
    </div>
  );
}
