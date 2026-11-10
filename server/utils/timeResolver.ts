import { DateTime } from 'luxon';

/**
 * Deterministic resolution of natural-language time references into concrete
 * [start, end) epoch-ms ranges in the conversation's timezone.
 *
 * Dates are resolved in code, never by the LLM: models are unreliable at
 * calendar arithmetic and timezone boundaries, and these ranges drive SQL filters.
 *
 * Conventions (documented in DESIGN.md):
 *  - "last <weekday>"  → the most recent such weekday strictly before today.
 *  - "on <weekday>" / "<weekday>" → the most recent such weekday, today included only
 *    if it is today and the phrase is "this <weekday>"; otherwise strictly before today.
 *  - "last week"       → previous ISO week (Mon 00:00 → Mon 00:00).
 *  - "earlier this week" → this Monday 00:00 → today 00:00 (falls back to now if today is Monday).
 *  - "3 November" with no year → this year, or last year if that date is in the future.
 *  - "since we last spoke" → kind 'since_last'; resolved against the DB by the retriever.
 */

export type TimeRefKind = 'day' | 'range' | 'since_last';

export interface TimeReference {
  kind: TimeRefKind;
  expression: string; // the text that matched
  label: string; // human readable, e.g. "Tue 3 Nov 2026"
  start: number; // epoch ms inclusive
  end: number; // epoch ms exclusive
  timezone: string;
}

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

function dayRef(expression: string, day: DateTime, tz: string): TimeReference {
  const start = day.startOf('day');
  return {
    kind: 'day',
    expression,
    label: start.toFormat('ccc d LLL yyyy'),
    start: start.toMillis(),
    end: start.plus({ days: 1 }).toMillis(),
    timezone: tz,
  };
}

function rangeRef(expression: string, start: DateTime, end: DateTime, tz: string, label?: string): TimeReference {
  return {
    kind: 'range',
    expression,
    label: label ?? `${start.toFormat('d LLL')} – ${end.minus({ milliseconds: 1 }).toFormat('d LLL yyyy')}`,
    start: start.toMillis(),
    end: end.toMillis(),
    timezone: tz,
  };
}

function monthNum(token: string): number | undefined {
  return MONTHS[token.toLowerCase().slice(0, token.toLowerCase().startsWith('sept') ? 4 : 3)] ?? MONTHS[token.toLowerCase().slice(0, 3)];
}

function calendarDate(expression: string, today: DateTime, month: number, dayNum: number, year: number | undefined, tz: string): TimeReference | null {
  let y = year ?? today.year;
  let d = DateTime.fromObject({ year: y, month, day: dayNum }, { zone: tz });
  if (!d.isValid) return null;
  if (year === undefined && d.startOf('day') > today.startOf('day')) {
    y -= 1;
    d = DateTime.fromObject({ year: y, month, day: dayNum }, { zone: tz });
    if (!d.isValid) return null;
  }
  return dayRef(expression, d, tz);
}

export function resolveTimeReferences(text: string, now: Date, timezone: string): TimeReference[] {
  const tz = timezone;
  const nowDt = DateTime.fromJSDate(now, { zone: tz });
  const today = nowDt.startOf('day');
  const lower = text.toLowerCase();
  const refs: Array<TimeReference & { index: number }> = [];
  const push = (ref: TimeReference | null, index: number) => {
    if (ref) refs.push({ ...ref, index });
  };
  const consumed: Array<[number, number]> = [];
  const overlaps = (s: number, e: number) => consumed.some(([a, b]) => s < b && e > a);
  const take = (m: RegExpMatchArray) => {
    const s = m.index ?? 0;
    const e = s + m[0].length;
    if (overlaps(s, e)) return false;
    consumed.push([s, e]);
    return true;
  };

  // since-last-spoke family
  for (const m of lower.matchAll(/\b(since (?:we )?last (?:spoke|talked|chatted)|since (?:our|the) last (?:conversation|discussion|chat|session)|since last time)\b/g)) {
    if (!take(m)) continue;
    push({ kind: 'since_last', expression: m[0], label: 'since our last conversation', start: 0, end: nowDt.toMillis(), timezone: tz }, m.index ?? 0);
  }

  // ISO dates
  for (const m of lower.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    if (!take(m)) continue;
    const d = DateTime.fromObject({ year: +m[1]!, month: +m[2]!, day: +m[3]! }, { zone: tz });
    if (d.isValid) push(dayRef(m[0], d, tz), m.index ?? 0);
  }

  // "3 November", "3rd of Nov 2026"
  for (const m of lower.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b(?:,?\\s+(\\d{4}))?`, 'g'))) {
    if (!take(m)) continue;
    const mon = monthNum(m[2]!);
    if (mon) push(calendarDate(m[0], today, mon, +m[1]!, m[3] ? +m[3] : undefined, tz), m.index ?? 0);
  }
  // "November 3", "Nov 3rd, 2026"
  for (const m of lower.matchAll(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, 'g'))) {
    if (!take(m)) continue;
    const mon = monthNum(m[1]!);
    if (mon) push(calendarDate(m[0], today, mon, +m[2]!, m[3] ? +m[3] : undefined, tz), m.index ?? 0);
  }

  for (const m of lower.matchAll(/\bday before yesterday\b/g)) {
    if (take(m)) push(dayRef(m[0], today.minus({ days: 2 }), tz), m.index ?? 0);
  }
  for (const m of lower.matchAll(/\byesterday\b/g)) {
    if (take(m)) push(dayRef(m[0], today.minus({ days: 1 }), tz), m.index ?? 0);
  }
  for (const m of lower.matchAll(/\b(today|this morning|this afternoon|earlier today)\b/g)) {
    if (take(m)) push(dayRef(m[0], today, tz), m.index ?? 0);
  }
  for (const m of lower.matchAll(/\b(\d{1,2}|a|one|two|three|four|five|six|seven)\s+days?\s+ago\b/g)) {
    if (!take(m)) continue;
    const words: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
    const n = words[m[1]!] ?? Number(m[1]);
    push(dayRef(m[0], today.minus({ days: n }), tz), m.index ?? 0);
  }
  for (const m of lower.matchAll(/\bearlier this week\b/g)) {
    if (!take(m)) continue;
    const monday = today.startOf('week');
    const end = today > monday ? today : nowDt;
    push(rangeRef(m[0], monday, end, tz, `earlier this week (${monday.toFormat('d LLL')} – ${end.minus({ milliseconds: 1 }).toFormat('d LLL yyyy')})`), m.index ?? 0);
  }
  for (const m of lower.matchAll(/\blast week\b/g)) {
    if (!take(m)) continue;
    const start = today.startOf('week').minus({ weeks: 1 });
    push(rangeRef(m[0], start, start.plus({ weeks: 1 }), tz, `last week (${start.toFormat('d LLL')} – ${start.plus({ days: 6 }).toFormat('d LLL yyyy')})`), m.index ?? 0);
  }
  for (const m of lower.matchAll(/\bthis week\b/g)) {
    if (!take(m)) continue;
    push(rangeRef(m[0], today.startOf('week'), nowDt, tz, 'this week'), m.index ?? 0);
  }
  for (const m of lower.matchAll(/\blast month\b/g)) {
    if (!take(m)) continue;
    const start = today.startOf('month').minus({ months: 1 });
    push(rangeRef(m[0], start, start.plus({ months: 1 }), tz, `last month (${start.toFormat('LLLL yyyy')})`), m.index ?? 0);
  }

  // weekdays
  const wdRe = new RegExp(`\\b(last|this past|this|on|past)?\\s*(${WEEKDAYS.join('|')})\\b`, 'g');
  for (const m of lower.matchAll(wdRe)) {
    if (!take(m)) continue;
    const qualifier = m[1] ?? '';
    const target = WEEKDAYS.indexOf(m[2]!) + 1; // luxon: Mon=1..Sun=7
    let diff = (today.weekday - target + 7) % 7;
    if (diff === 0 && qualifier !== 'this') diff = 7; // "last Tuesday" said on a Tuesday → a week ago
    push(dayRef(m[0].trim(), today.minus({ days: diff }), tz), m.index ?? 0);
  }

  return refs.sort((a, b) => a.index - b.index).map(({ index: _i, ...r }) => r);
}

/** Formats an epoch ms in the given timezone, e.g. "Tue 3 Nov 2026, 14:05". */
export function formatInZone(ms: number, tz: string, fmt = 'ccc d LLL yyyy, HH:mm'): string {
  return DateTime.fromMillis(ms, { zone: tz }).toFormat(fmt);
}

export function isoDateInZone(ms: number, tz: string): string {
  return DateTime.fromMillis(ms, { zone: tz }).toISODate() ?? '';
}
