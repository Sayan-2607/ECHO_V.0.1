import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { api } from '../lib/api';
import type { ServerConfig } from '../lib/types';
import { browserTimezone } from '../hooks/useChat';

/** Read-only view of the server's (non-secret) runtime configuration. */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [cfg, setCfg] = useState<ServerConfig | null>(null);
  const [health, setHealth] = useState<string>('checking…');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.config().then(setCfg).catch((e: Error) => setErr(e.message));
    api.health().then((h) => setHealth(h.status)).catch(() => setHealth('unreachable'));
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rows: Array<[string, string]> = cfg
    ? [
        ['Server', health],
        ['Model', `${cfg.model} (${cfg.modelEndpoint})`],
        ['External tools', cfg.tools.join(', ')],
        ['Search provider', cfg.searchProvider],
        ['Max web searches per request', String(cfg.maxToolCalls)],
        ['Search cache', `${cfg.searchCacheTtlSeconds}s`],
        ['Request timeout', `${Math.round(cfg.requestTimeoutMs / 1000)}s`],
        ['Your timezone (sent with each message)', browserTimezone()],
        ['Server fallback timezone', cfg.defaultTimezone],
      ]
    : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose} role="dialog" aria-modal="true" aria-label="Settings">
      <div className="w-full max-w-md rounded-2xl border border-ink-700 bg-ink-850 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-medium text-white">Settings</h2>
          <button onClick={onClose} aria-label="Close" className="text-ink-400 hover:text-white">
            <X size={16} />
          </button>
        </div>
        <p className="mt-1 text-[12.5px] text-ink-400">Configured on the server through environment variables (.env). Keys are never sent to the browser.</p>
        {err && <p className="mt-4 text-[13px] text-up">{err}</p>}
        <dl className="mt-4 divide-y divide-ink-700 text-[13px]">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 py-2">
              <dt className="text-ink-400">{k}</dt>
              <dd className="text-right font-mono text-[12px] text-ink-100">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
