import { useState } from 'react';
import { ChevronRight, ExternalLink } from 'lucide-react';
import type { Citation, SourceType } from '../lib/types';

const TYPE_LABEL: Record<SourceType, string> = {
  official_pricing: 'Official pricing',
  official_docs: 'Official docs',
  official_changelog: 'Official changelog',
  official_announcement: 'Official announcement',
  official_other: 'Official site',
  reputable_publication: 'Publication',
  review_aggregator: 'Review site',
  community: 'Community',
  other: 'Web',
  historical_record: 'Earlier source',
};

/** Expandable list of the sources cited in an answer, with type and dates. */
export function SourcesPanel({ sources }: { sources: Citation[] }) {
  const [open, setOpen] = useState(false);
  if (!sources.length) return null;
  return (
    <div className="mt-4">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 text-[13px] text-ink-400 hover:text-ink-200 transition-colors">
        <ChevronRight size={14} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
        <span>Sources</span>
        <span className="flex -space-x-1">
          {sources.slice(0, 5).map((s) => (
            <span key={s.n} className="flex h-4 w-4 items-center justify-center rounded-full border border-ink-800 bg-ink-700 font-mono text-[9px] uppercase text-ink-200">
              {s.domain.charAt(0)}
            </span>
          ))}
        </span>
        <span className="text-ink-500">{sources.length}</span>
      </button>
      {open && (
        <ol className="mt-2 grid gap-1.5">
          {sources.map((s) => (
            <li key={s.n} className="fade-up">
              <a href={s.url} target="_blank" rel="noopener noreferrer" className="group flex items-start gap-3 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 hover:border-ink-600">
                <span className="cite mt-0.5 shrink-0">{s.n}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-ink-100 group-hover:text-white">{s.title}</span>
                  <span className="flex flex-wrap gap-x-2 text-[11.5px] text-ink-400">
                    <span>{s.domain}</span>
                    <span className="text-ink-500">· {TYPE_LABEL[s.sourceType]}</span>
                    {s.publishedDate && <span className="text-ink-500">· published {s.publishedDate}</span>}
                    {s.retrievedAt > 0 && <span className="text-ink-500">· retrieved {new Date(s.retrievedAt).toLocaleDateString()}</span>}
                  </span>
                </span>
                <ExternalLink size={13} className="mt-1 shrink-0 text-ink-500 group-hover:text-ink-300" />
              </a>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
