import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Citation } from '../lib/types';

/** Converts [1] / [1, 2] markers into citation links that point at the real source URLs. */
function linkCitations(text: string, sources: Citation[]): string {
  const byN = new Map(sources.map((s) => [s.n, s]));
  return text.replace(/\[(\d+(?:\s*,\s*\d+)*)\](?!\()/g, (m, inner: string) => {
    const nums = inner.split(',').map((x) => Number(x.trim()));
    if (!nums.every((n) => byN.has(n))) return m;
    return nums.map((n) => `[${n}](echo-cite:${n})`).join('');
  });
}

export function Markdown({ text, sources = [] }: { text: string; sources?: Citation[] }) {
  const byN = new Map(sources.map((s) => [s.n, s]));
  return (
    <div className="prose-echo">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => (url.startsWith('echo-cite:') ? url : defaultUrlTransform(url))}
        components={{
          a: ({ href, children }) => {
            if (href?.startsWith('echo-cite:')) {
              const s = byN.get(Number(href.slice(10)));
              if (!s) return <>{children}</>;
              return (
                <a className="cite" href={s.url} target="_blank" rel="noopener noreferrer" title={`${s.title} — ${s.domain}`}>
                  {s.n}
                </a>
              );
            }
            return (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            );
          },
        }}
      >
        {linkCitations(text, sources)}
      </ReactMarkdown>
    </div>
  );
}
