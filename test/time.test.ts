import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addDays,
  daysBetween,
  endOfDay,
  formatClock,
  formatDuration,
  formatRangeLabel,
  localIso,
  offsetMinutes,
  parseDateTime,
  previousRange,
  rangeFromDates,
  resolvePreset,
  startOfDay,
  zonedToUtc,
} from '../src/calcom/time.js';
import { ToolInputError } from '../src/errors.js';

const KL = 'Asia/Kuala_Lumpur';
const NY = 'America/New_York';
const LONDON = 'Europe/London';

describe('zonedToUtc', () => {
  it('converts wall time in a fixed-offset zone', () => {
    assert.equal(zonedToUtc({ year: 2026, month: 10, day: 27, hour: 15 }, KL).toISOString(), '2026-10-27T07:00:00.000Z');
    assert.equal(offsetMinutes(new Date('2026-10-27T07:00:00Z'), KL), 480);
  });

  it('refuses times skipped by a DST change', () => {
    // New York springs forward 2026-03-08 02:00 → 03:00; London 2026-03-29 01:00 → 02:00
    assert.throws(() => zonedToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, NY), /does not exist/);
    assert.throws(() => zonedToUtc({ year: 2026, month: 3, day: 29, hour: 1, minute: 30 }, LONDON), /does not exist/);
    assert.equal(zonedToUtc({ year: 2026, month: 3, day: 8, hour: 1, minute: 30 }, NY).toISOString(), '2026-03-08T06:30:00.000Z');
    assert.equal(zonedToUtc({ year: 2026, month: 3, day: 8, hour: 3, minute: 30 }, NY).toISOString(), '2026-03-08T07:30:00.000Z');
  });

  it('resolves ambiguous times (clocks going back) to the earlier occurrence', () => {
    // New York falls back 2026-11-01 02:00 → 01:00; London 2026-10-25 02:00 → 01:00
    assert.equal(zonedToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, NY).toISOString(), '2026-11-01T05:30:00.000Z');
    assert.equal(zonedToUtc({ year: 2026, month: 10, day: 25, hour: 1, minute: 30 }, LONDON).toISOString(), '2026-10-25T00:30:00.000Z');
  });

  it('rejects impossible dates instead of rolling them over', () => {
    assert.throws(() => zonedToUtc({ year: 2026, month: 2, day: 30, hour: 10 }, KL), /not a valid date/);
  });
});

describe('parseDateTime', () => {
  it('accepts ISO with offset, UTC and local wall time', () => {
    assert.equal(parseDateTime('2026-10-27T15:00:00+08:00', NY).toISOString(), '2026-10-27T07:00:00.000Z');
    assert.equal(parseDateTime('2026-10-27T07:00Z', NY).toISOString(), '2026-10-27T07:00:00.000Z');
    assert.equal(parseDateTime('2026-10-27T15:00+0800', NY).toISOString(), '2026-10-27T07:00:00.000Z');
    assert.equal(parseDateTime('2026-10-27 15:00', KL).toISOString(), '2026-10-27T07:00:00.000Z');
    assert.equal(parseDateTime('2026-10-27T9:30', KL).toISOString(), '2026-10-27T01:30:00.000Z');
  });

  it('understands am / pm', () => {
    assert.equal(parseDateTime('2026-10-27 3:00 pm', KL).toISOString(), '2026-10-27T07:00:00.000Z');
    assert.equal(parseDateTime('2026-10-27 12:00 am', KL).toISOString(), '2026-10-26T16:00:00.000Z');
    assert.equal(parseDateTime('2026-10-27 12:15 p.m.', KL).toISOString(), '2026-10-27T04:15:00.000Z');
  });

  it('explains what is wrong with bad input', () => {
    assert.throws(() => parseDateTime('2026-10-27', KL, 'start'), (error: unknown) => error instanceof ToolInputError && /needs a time of day/.test(error.message));
    assert.throws(() => parseDateTime('2026-02-30 10:00', KL), /not a valid date/);
    assert.throws(() => parseDateTime('tomorrow at 3', KL), /Could not read/);
    assert.throws(() => parseDateTime('2026-10-27 15:00 pm', KL), /24-hour time with am\/pm/);
  });
});

describe('days and ranges', () => {
  it('computes day boundaries in the zone', () => {
    assert.equal(startOfDay('2026-10-27', KL).toISOString(), '2026-10-26T16:00:00.000Z');
    assert.equal(endOfDay('2026-10-27', KL).toISOString(), '2026-10-27T15:59:59.999Z');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(daysBetween('2026-10-01', '2026-10-31'), 30);
  });

  it('resolves presets relative to "now" in the zone and the week start', () => {
    const now = new Date('2026-10-24T04:00:00Z'); // Saturday 12:00 in Kuala Lumpur
    const dates = (preset: Parameters<typeof resolvePreset>[0], weekStart = 'Monday') => {
      const range = resolvePreset(preset, KL, { now, weekStart });
      return [range.fromDate, range.toDate];
    };
    assert.deepEqual(dates('today'), ['2026-10-24', '2026-10-24']);
    assert.deepEqual(dates('tomorrow'), ['2026-10-25', '2026-10-25']);
    assert.deepEqual(dates('this_week'), ['2026-10-19', '2026-10-25']);
    assert.deepEqual(dates('this_week', 'Sunday'), ['2026-10-18', '2026-10-24']);
    assert.deepEqual(dates('next_week'), ['2026-10-26', '2026-11-01']);
    assert.deepEqual(dates('next_7_days'), ['2026-10-24', '2026-10-30']);
    assert.deepEqual(dates('past_30_days'), ['2026-09-25', '2026-10-24']);
    assert.deepEqual(dates('this_month'), ['2026-10-01', '2026-10-31']);
    assert.deepEqual(dates('last_month'), ['2026-09-01', '2026-09-30']);
    assert.deepEqual(dates('this_year'), ['2026-01-01', '2026-12-31']);

    const january = resolvePreset('last_month', KL, { now: new Date('2026-01-15T04:00:00Z') });
    assert.deepEqual([january.fromDate, january.toDate], ['2025-12-01', '2025-12-31']);
  });

  it('uses the zone, not UTC, to decide what "today" is', () => {
    // 2026-10-24T20:00Z is already Sunday 25 Oct in Kuala Lumpur but still Saturday in New York
    const now = new Date('2026-10-24T20:00:00Z');
    assert.equal(resolvePreset('today', KL, { now }).fromDate, '2026-10-25');
    assert.equal(resolvePreset('today', NY, { now }).fromDate, '2026-10-24');
  });

  it('builds the previous period of the same length', () => {
    const range = rangeFromDates('2026-10-01', '2026-10-31', KL);
    const previous = previousRange(range, KL);
    assert.deepEqual([previous.fromDate, previous.toDate], ['2026-08-31', '2026-09-30']);
    assert.throws(() => rangeFromDates('2026-10-05', '2026-10-01', KL), /ends .* before it starts/);
  });
});

describe('formatting', () => {
  it('formats clocks, local ISO times, durations and ranges', () => {
    const date = new Date('2026-10-27T07:05:00Z');
    assert.equal(formatClock(date, KL), '15:05');
    assert.equal(formatClock(date, KL, 12), '3:05 pm');
    assert.equal(formatClock(new Date('2026-10-26T16:30:00Z'), KL, 12), '12:30 am');
    assert.equal(localIso(date, KL), '2026-10-27T15:05:00+08:00');
    assert.equal(localIso(new Date('2026-07-01T16:00:00Z'), NY), '2026-07-01T12:00:00-04:00');
    assert.equal(formatDuration(30), '30 min');
    assert.equal(formatDuration(60), '1 h');
    assert.equal(formatDuration(90), '1 h 30 min');
    assert.equal(formatDuration(1500), '1 d 1 h');
    assert.equal(formatRangeLabel('2026-10-27', '2026-11-02'), 'Tue 27 Oct – Mon 2 Nov 2026');
    assert.equal(formatRangeLabel('2026-12-28', '2027-01-03'), 'Mon 28 Dec 2026 – Sun 3 Jan 2027');
  });
});
