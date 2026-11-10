import { useState } from 'react';
import { Brain, Check, ChevronRight, Database, GitCompare, Globe, ListChecks, PenLine, Save, ShieldCheck, TriangleAlert, Search, Waypoints } from 'lucide-react';
import type { StageRecord } from '../lib/types';
import type { SearchActivity } from '../hooks/useChat';

const META: Record<string, { label: string; icon: typeof Brain }> = {
  understand: { label: 'Understanding', icon: Brain },
  retrieve: { label: 'Memory', icon: Database },
  plan: { label: 'Planning', icon: Waypoints },
  search: { label: 'Web search', icon: Globe },
  evaluate: { label: 'Reading sources', icon: ListChecks },
  gaps: { label: 'Gaps', icon: Search },
  verify: { label: 'Verifying', icon: ShieldCheck },
  compare: { label: 'Comparing', icon: GitCompare },
  synthesize: { label: 'Writing', icon: PenLine },
  persist: { label: 'Saving', icon: Save },
};

/** Collapses start/done pairs into one row per stage occurrence; search rows stay one per query. */
function rows(stages: StageRecord[]) {
  const out: Array<{ stage: string; status: StageRecord['status']; detail?: string }> = [];
  for (const s of stages) {
    if (s.stage === 'search') {
      const q = s.detail?.split(' — ')[0];
      const existing = out.find((r) => r.stage === 'search' && r.detail?.split(' — ')[0] === q && r.status === 'start');
      if (existing && s.status !== 'start') {
        existing.status = s.status;
        existing.detail = s.detail;
      } else if (!existing) out.push({ ...s });
      continue;
    }
    const open = [...out].reverse().find((r) => r.stage === s.stage && r.status === 'start');
    if (open && s.status !== 'start') {
      open.status = s.status;
      open.detail = s.detail ?? open.detail;
    } else out.push({ ...s });
  }
  return out;
}

/** Shows only stages the server actually executed (from SSE events / stored metadata). */
export function ResearchActivity({ stages, searches = [], live = false }: { stages: StageRecord[]; searches?: SearchActivity[]; live?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!stages.length) return null;
  const list = rows(stages);
  const current = live ? list.findLast((r) => r.status === 'start') : undefined;
  const searchCount = list.filter((r) => r.stage === 'search').length || searches.length;
  const expanded = live || open;

  return (
    <div className="mb-3 text-[13px]">
      {!live && (
        <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 text-ink-400 hover:text-ink-200 transition-colors">
          <ChevronRight size={14} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
          Research trail
          <span className="text-ink-500">· {list.length} steps{searchCount ? ` · ${searchCount} web search${searchCount === 1 ? '' : 'es'}` : ''}</span>
        </button>
      )}
      {expanded && (
        <ol className={`${live ? '' : 'mt-2'} space-y-1.5 border-l border-ink-700 pl-3`}>
          {list.map((r, i) => {
            const m = META[r.stage] ?? { label: r.stage, icon: Check };
            const Icon = r.status === 'error' ? TriangleAlert : m.icon;
            const active = r === current;
            return (
              <li key={i} className="fade-up flex items-start gap-2">
                <span className={`relative mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${active ? 'pulse-ring text-signal' : r.status === 'error' ? 'text-up' : 'text-ink-400'}`}>
                  <Icon size={13} />
                </span>
                <span className={active ? 'text-ink-100' : 'text-ink-300'}>
                  {m.label}
                  {r.detail && <span className="text-ink-500"> — {r.detail}</span>}
                  {r.status === 'skipped' && !r.detail && <span className="text-ink-500"> — skipped</span>}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
