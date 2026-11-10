import { ArrowDownRight, ArrowUpRight, Equal, HelpCircle, Plus, Minus, Sparkles, Megaphone } from 'lucide-react';
import type { ChangeRecord, ChangeType, Citation } from '../lib/types';

const TYPE: Record<ChangeType, { label: string; cls: string; icon: typeof Equal }> = {
  price_increase: { label: 'Price up', cls: 'text-up bg-up/10', icon: ArrowUpRight },
  price_decrease: { label: 'Price down', cls: 'text-down bg-down/10', icon: ArrowDownRight },
  unchanged: { label: 'Unchanged', cls: 'text-ink-300 bg-ink-700/60', icon: Equal },
  new_free_tier: { label: 'New free tier', cls: 'text-down bg-down/10', icon: Plus },
  plan_added: { label: 'Plan added', cls: 'text-info bg-info/10', icon: Plus },
  plan_removed: { label: 'Plan removed', cls: 'text-up bg-up/10', icon: Minus },
  feature_added: { label: 'Feature added', cls: 'text-info bg-info/10', icon: Plus },
  feature_removed: { label: 'Feature removed', cls: 'text-up bg-up/10', icon: Minus },
  api_change: { label: 'API change', cls: 'text-info bg-info/10', icon: Sparkles },
  product_launch: { label: 'Launch', cls: 'text-info bg-info/10', icon: Sparkles },
  policy_change: { label: 'Policy change', cls: 'text-signal bg-signal/10', icon: Megaphone },
  availability_change: { label: 'Availability', cls: 'text-signal bg-signal/10', icon: Megaphone },
  announcement: { label: 'Announced', cls: 'text-signal bg-signal/10', icon: Megaphone },
  changed: { label: 'Changed', cls: 'text-signal bg-signal/10', icon: ArrowUpRight },
  baseline_unavailable: { label: 'No baseline', cls: 'text-ink-400 bg-ink-700/60', icon: HelpCircle },
  not_verified: { label: 'Not verified', cls: 'text-ink-400 bg-ink-700/60', icon: HelpCircle },
};

function SourceLink({ url, sources }: { url: string | null; sources: Citation[] }) {
  if (!url || !/^https?:/.test(url)) return null;
  const s = sources.find((x) => x.url === url);
  return (
    <a className="cite" href={url} target="_blank" rel="noopener noreferrer" title={s ? `${s.title} — ${s.domain}` : url}>
      {s ? s.n : '↗'}
    </a>
  );
}

/** Deterministic historical-vs-current table rendered from server change records (not model text). */
export function ChangeTable({ changes, sources }: { changes: ChangeRecord[]; sources: Citation[] }) {
  if (!changes.length) return null;
  const order = (c: ChangeRecord) => (['unchanged', 'not_verified', 'baseline_unavailable'].includes(c.changeType) ? 1 : 0);
  const sorted = [...changes].sort((a, b) => order(a) - order(b));
  return (
    <div className="mt-5 overflow-hidden rounded-xl border border-ink-700 bg-ink-850">
      <div className="flex items-center justify-between border-b border-ink-700 px-4 py-2.5">
        <span className="text-[13px] font-medium text-ink-200">Historical vs current</span>
        <span className="font-mono text-[11px] text-ink-500">{changes.length} comparisons</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-[13px]">
          <thead>
            <tr className="text-left text-ink-400">
              <th className="px-4 py-2 font-medium">Item</th>
              <th className="px-3 py-2 font-medium">Before</th>
              <th className="px-3 py-2 font-medium">Now</th>
              <th className="px-3 py-2 font-medium">Change</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((c, i) => {
              const t = TYPE[c.changeType];
              return (
                <tr key={i} className="border-t border-ink-700/70 align-top">
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-ink-100">{c.entity}</div>
                    <div className="text-[12px] text-ink-400">{c.attribute}</div>
                  </td>
                  <td className="px-3 py-2.5">
                    {c.historicalValue ? (
                      <>
                        <span className="text-ink-200">{c.historicalValue}</span> <SourceLink url={c.historicalSource} sources={sources} />
                        {c.historicalDate && <div className="font-mono text-[11px] text-ink-500">{c.historicalDate}</div>}
                      </>
                    ) : (
                      <span className="italic text-ink-500">Historical baseline unavailable</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {c.currentValue ? (
                      <>
                        <span className="text-ink-100">{c.currentValue}</span> <SourceLink url={c.currentSource} sources={sources} />
                        {c.currentSourceDate && <div className="font-mono text-[11px] text-ink-500">{c.currentSourceDate}</div>}
                      </>
                    ) : (
                      <span className="italic text-ink-500">Current status not verified</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] ${t.cls}`}>
                      <t.icon size={12} />
                      {t.label}
                    </span>
                    <div className="mt-1 max-w-[260px] text-[12px] leading-snug text-ink-400">
                      {c.explanation}
                      {c.changeType !== 'baseline_unavailable' && c.changeType !== 'not_verified' && <span className="text-ink-500"> · {c.confidence} confidence</span>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
