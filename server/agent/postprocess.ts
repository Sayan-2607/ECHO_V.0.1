import { extractMoneyAmounts, nearlyEqual, splitSentences } from '../utils/text.js';
import { normalizeUrl } from '../search/normalization.js';

export interface PostProcessResult {
  content: string;
  removed: string[]; // human-readable descriptions of what was removed and why
}

/**
 * Final guard before an answer is stored/shown:
 *  - citation markers must refer to a real source in this answer;
 *  - links must point to known sources (blocks links injected via web content);
 *  - money amounts must be grounded in verified evidence, stored memory or the user's message —
 *    sentences with ungrounded amounts are removed (this is the "unsupported claim" filter).
 */
export function postProcessAnswer(text: string, opts: { citationCount: number; allowedUrls: string[]; allowedAmounts: number[] }): PostProcessResult {
  const removed: string[] = [];
  const allowed = new Set(opts.allowedUrls.map(normalizeUrl));

  // 1. Citations [n] or [n, m]
  let out = text.replace(/\[(\d+(?:\s*,\s*\d+)*)\](?!\()/g, (m, inner: string) => {
    const nums = inner.split(',').map((x) => Number(x.trim()));
    const ok = nums.filter((n) => Number.isInteger(n) && n >= 1 && n <= opts.citationCount);
    if (ok.length !== nums.length) removed.push(`citation ${m} does not match a source`);
    return ok.length ? `[${ok.join(', ')}]` : '';
  });

  // 2. Markdown links and bare URLs
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, label: string, url: string) => {
    if (allowed.has(normalizeUrl(url))) return m;
    removed.push(`link to unverified URL ${url}`);
    return label;
  });
  out = out.replace(/(?<!\]\()(?<!<)\bhttps?:\/\/[^\s)>\]]+/g, (url) => {
    if (allowed.has(normalizeUrl(url))) return url;
    removed.push(`unverified URL ${url}`);
    return '[link removed]';
  });

  // 3. Ungrounded money amounts
  const lines = out.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    if (!extractMoneyAmounts(line).length) {
      kept.push(line);
      continue;
    }
    const isTableRow = /^\s*\|/.test(line);
    const units = isTableRow ? [line] : splitSentences(line);
    const keptUnits = units.filter((u) => {
      const bad = extractMoneyAmounts(u).filter((a) => !opts.allowedAmounts.some((b) => nearlyEqual(a, b)));
      if (bad.length) removed.push(`statement with unsupported amount(s) ${bad.join(', ')}: "${u.trim().slice(0, 120)}"`);
      return bad.length === 0;
    });
    if (keptUnits.length) kept.push(isTableRow ? keptUnits[0]! : keptUnits.join(' '));
  }
  out = kept.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { content: out, removed };
}
