import { CircleSlash, TriangleAlert, ShieldAlert } from 'lucide-react';
import type { Message, Verdict } from '../lib/types';
import { Markdown } from './Markdown';
import { ChangeTable } from './ChangeTable';
import { SourcesPanel } from './SourcesPanel';
import { ResearchActivity } from './ResearchActivity';
import { EchoMark } from './Logo';

const VERDICT: Record<Verdict, { label: string; cls: string }> = {
  still_correct: { label: 'Still correct', cls: 'border-down/40 text-down' },
  partially_correct: { label: 'Partially correct', cls: 'border-signal/40 text-signal' },
  outdated: { label: 'Outdated', cls: 'border-up/40 text-up' },
  cannot_verify: { label: 'Cannot verify', cls: 'border-ink-500 text-ink-300' },
};

export function UserBubble({ text, time }: { text: string; time?: number }) {
  return (
    <div className="fade-up flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-ink-700/70 px-4 py-2.5 text-[15px] leading-relaxed text-ink-100 whitespace-pre-wrap" title={time ? new Date(time).toLocaleString() : undefined}>
        {text}
      </div>
    </div>
  );
}

export function AssistantMessage({ message }: { message: Message }) {
  const md = message.metadata;
  return (
    <div className="fade-up flex gap-3">
      <EchoMark className="mt-1 h-6 w-6 shrink-0" />
      <div className="min-w-0 flex-1">
        {md.stages && <ResearchActivity stages={md.stages} />}
        {md.verdict && (
          <span className={`mb-3 inline-flex items-center rounded-full border px-2.5 py-0.5 text-[12px] ${VERDICT[md.verdict].cls}`}>{VERDICT[md.verdict].label}</span>
        )}
        <Markdown text={message.content} sources={md.sources} />
        {md.changes && md.changes.length > 0 && <ChangeTable changes={md.changes} sources={md.sources ?? []} />}
        {md.sources && <SourcesPanel sources={md.sources} />}
        {message.status === 'cancelled' && (
          <p className="mt-3 flex items-center gap-1.5 text-[12.5px] text-ink-400">
            <CircleSlash size={13} /> Stopped
          </p>
        )}
        {message.status === 'error' && (
          <p className="mt-3 flex items-center gap-1.5 text-[12.5px] text-up">
            <TriangleAlert size={13} /> {md.error ?? 'Error'}
          </p>
        )}
        {md.removedUnsupported && md.removedUnsupported.length > 0 && (
          <details className="mt-3 text-[12.5px] text-ink-400">
            <summary className="flex cursor-pointer items-center gap-1.5 hover:text-ink-200">
              <ShieldAlert size={13} /> {md.removedUnsupported.length} unsupported statement{md.removedUnsupported.length === 1 ? '' : 's'} removed by verification
            </summary>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-6 text-ink-500">
              {md.removedUnsupported.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
