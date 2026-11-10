import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { resolveTimeReferences } from '../../server/utils/timeResolver.js';

const TZ = 'Asia/Kolkata';
const NOW = new Date('2026-11-10T14:36:00Z'); // Tue 10 Nov 2026 20:06 IST
const local = (ms: number, tz = TZ) => DateTime.fromMillis(ms, { zone: tz }).toFormat('yyyy-MM-dd HH:mm');

describe('time resolution (test 1)', () => {
  it('resolves "yesterday" to the previous local calendar day', () => {
    const [r] = resolveTimeReferences('What did I ask you yesterday?', NOW, TZ);
    expect(r?.kind).toBe('day');
    expect(local(r!.start)).toBe('2026-11-09 00:00');
    expect(local(r!.end)).toBe('2026-11-10 00:00');
  });

  it('resolves "last Tuesday" on a Tuesday to one week earlier', () => {
    const [r] = resolveTimeReferences('Last Tuesday I asked you about Postgres hosting', NOW, TZ);
    expect(local(r!.start)).toBe('2026-11-03 00:00');
    expect(r!.label).toBe('Tue 3 Nov 2026');
  });

  it('resolves "last Tuesday" on a Thursday to two days earlier', () => {
    const thu = new Date('2026-11-12T06:00:00Z');
    const [r] = resolveTimeReferences('last tuesday', thu, TZ);
    expect(local(r!.start)).toBe('2026-11-10 00:00');
  });

  it('uses the conversation timezone, not UTC, at day boundaries', () => {
    // 20:00 UTC on 10 Nov is already 01:30 on 11 Nov in India.
    const lateUtc = new Date('2026-11-10T20:00:00Z');
    const [ist] = resolveTimeReferences('yesterday', lateUtc, TZ);
    const [utc] = resolveTimeReferences('yesterday', lateUtc, 'UTC');
    expect(local(ist!.start)).toBe('2026-11-10 00:00');
    expect(local(utc!.start, 'UTC')).toBe('2026-11-09 00:00');
  });

  it('resolves "On Monday" to the most recent Monday', () => {
    const [r] = resolveTimeReferences('On Monday we shortlisted 5 CRM tools', NOW, TZ);
    expect(local(r!.start)).toBe('2026-11-09 00:00');
  });

  it('resolves "on 3 November" and "November 3rd" to the same day of this year', () => {
    const [a] = resolveTimeReferences('What did I ask you on 3 November?', NOW, TZ);
    const [b] = resolveTimeReferences('what about November 3rd', NOW, TZ);
    expect(local(a!.start)).toBe('2026-11-03 00:00');
    expect(b!.start).toBe(a!.start);
  });

  it('a date later in the year without a year means last year', () => {
    const [r] = resolveTimeReferences('on 20 December', NOW, TZ);
    expect(local(r!.start)).toBe('2025-12-20 00:00');
  });

  it('resolves "earlier this week" and "last week" as ranges', () => {
    const [e] = resolveTimeReferences('what did we discuss earlier this week', NOW, TZ);
    expect(local(e!.start)).toBe('2026-11-09 00:00');
    expect(local(e!.end)).toBe('2026-11-10 00:00');
    const [w] = resolveTimeReferences('what did we decide last week?', NOW, TZ);
    expect(local(w!.start)).toBe('2026-11-02 00:00');
    expect(local(w!.end)).toBe('2026-11-09 00:00');
  });

  it('detects "since we last spoke" as a memory-relative reference', () => {
    const [r] = resolveTimeReferences('What has changed since we last spoke?', NOW, TZ);
    expect(r?.kind).toBe('since_last');
  });

  it('returns nothing for messages without time references', () => {
    expect(resolveTimeReferences('Explain what PostgreSQL is', NOW, TZ)).toEqual([]);
  });
});
