/** Rough token estimate (≈4 chars/token for English). Used only for budgeting, never for billing. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

export function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, Math.max(0, maxChars - 14)).trimEnd() + ' …[truncated]';
}

/** Lowercase, strip punctuation and collapse whitespace — for fuzzy containment checks. */
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^a-z0-9$€£₹%.'/\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True if `needle` (after normalization) occurs in `haystack`. */
export function containsNormalized(haystack: string, needle: string): boolean {
  const n = normalizeForMatch(needle);
  if (!n) return false;
  return normalizeForMatch(haystack).includes(n);
}

/** Extracts numbers from text, e.g. "$1,299.50/mo" -> [1299.5]. */
export function extractNumbers(s: string): number[] {
  const out: number[] = [];
  for (const m of s.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ''));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** Money amounts like "$25", "€1,200.00", "₹999", "USD 30". */
export function extractMoneyAmounts(s: string): number[] {
  const out: number[] = [];
  const re = /(?:[$€£₹]\s?|\b(?:USD|EUR|GBP|INR)\s?)(\d[\d,]*(?:\.\d+)?)/g;
  for (const m of s.matchAll(re)) {
    const n = Number((m[1] ?? '').replace(/,/g, ''));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

export const nearlyEqual = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.005, Math.abs(b) * 0.0005);

/** Splits markdown text into sentence-ish units while keeping line structure (tables, lists). */
export function splitSentences(line: string): string[] {
  return line.split(/(?<=[.!?])\s+(?=[A-Z0-9*_\[(])/);
}

export function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
