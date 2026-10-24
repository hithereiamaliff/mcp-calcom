/**
 * Time-zone helpers (Intl-based, no dependencies).
 *
 * Cal API v2 works with UTC instants; people think in wall-clock time. These helpers convert
 * "2026-10-27 15:00" in an IANA zone to UTC (DST-safe, refusing times a DST change skips),
 * resolve range presets (today, this_week, …) in the user's zone, and format output.
 */

import { ToolInputError } from '../errors.js';

const DAY_MS = 86_400_000;
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export type TimeFormat = 12 | 24;

export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday */
  weekday: number;
}

export interface DateFields {
  year: number;
  month: number;
  day: number;
}

// =============================================================================
// Zones
// =============================================================================

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function assertTimeZone(timeZone: string): string {
  if (!isValidTimeZone(timeZone)) {
    throw new ToolInputError(`Unknown time zone "${timeZone}". Use an IANA name such as "Asia/Kuala_Lumpur", "Europe/London" or "UTC".`);
  }
  return timeZone;
}

export function wallTime(date: Date, timeZone: string): WallTime {
  const parts = partsFormatter(timeZone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WEEKDAY_SHORT.indexOf(get('weekday') as (typeof WEEKDAY_SHORT)[number]),
  };
}

/** UTC offset of timeZone at the given instant, in minutes (Asia/Kuala_Lumpur → 480) */
export function offsetMinutes(date: Date, timeZone: string): number {
  const wall = wallTime(date, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  const wholeSeconds = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((asUtc - wholeSeconds) / 60_000);
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

function describeFields(fields: DateFields & { hour?: number; minute?: number }): string {
  const date = `${fields.year}-${pad(fields.month)}-${pad(fields.day)}`;
  return fields.hour === undefined ? date : `${date} ${pad(fields.hour)}:${pad(fields.minute ?? 0)}`;
}

function assertDateFields(fields: DateFields): void {
  const probe = new Date(Date.UTC(fields.year, fields.month - 1, fields.day));
  if (
    fields.month < 1 || fields.month > 12 ||
    probe.getUTCFullYear() !== fields.year || probe.getUTCMonth() !== fields.month - 1 || probe.getUTCDate() !== fields.day
  ) {
    throw new ToolInputError(`${describeFields(fields)} is not a valid date.`);
  }
}

/**
 * Wall-clock time in timeZone → UTC instant.
 * Ambiguous times (clocks going back) resolve to the earlier occurrence; times skipped
 * by a DST change are refused with an explanation.
 */
export function zonedToUtc(
  fields: DateFields & { hour?: number; minute?: number; second?: number },
  timeZone: string,
): Date {
  const { year, month, day, hour = 0, minute = 0, second = 0 } = fields;
  assertDateFields(fields);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    throw new ToolInputError(`${describeFields({ year, month, day, hour, minute })} is not a valid time.`);
  }

  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsets = new Set([
    offsetMinutes(new Date(asUtc - DAY_MS), timeZone),
    offsetMinutes(new Date(asUtc), timeZone),
    offsetMinutes(new Date(asUtc + DAY_MS), timeZone),
  ]);

  const matches = [...offsets]
    .map(offset => asUtc - offset * 60_000)
    .filter(candidate => {
      const wall = wallTime(new Date(candidate), timeZone);
      return wall.year === year && wall.month === month && wall.day === day &&
        wall.hour === hour && wall.minute === minute && wall.second === second;
    })
    .sort((a, b) => a - b);

  if (!matches.length) {
    throw new ToolInputError(
      `${describeFields({ year, month, day, hour, minute })} does not exist in ${timeZone} — the clocks skip that time ` +
      'for daylight saving. Pick a time outside the change.',
    );
  }
  return new Date(matches[0]);
}

// =============================================================================
// Parsing
// =============================================================================

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:\s*([ap])\.?m\.?)?$/i;
const ZONED_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(Z|[+-]\d{2}:?\d{2})$/i;

export function parseDate(input: string, label = 'date'): DateFields {
  const match = DATE_RE.exec(input.trim());
  if (!match) throw new ToolInputError(`${label} must be a date like "2026-10-27" (got "${input}").`);
  const fields = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  assertDateFields(fields);
  return fields;
}

function to24Hour(hour: number, meridiem: string | undefined, input: string): number {
  if (!meridiem) return hour;
  if (hour < 1 || hour > 12) throw new ToolInputError(`"${input}" mixes a 24-hour time with am/pm.`);
  const isPm = meridiem.toLowerCase() === 'p';
  return (hour % 12) + (isPm ? 12 : 0);
}

/**
 * A moment in time: ISO with offset ("2026-10-27T15:00:00+08:00", "…Z") or local wall time
 * ("2026-10-27 15:00", "2026-10-27T3:00 pm") interpreted in timeZone.
 */
export function parseDateTime(input: string, timeZone: string, label = 'time'): Date {
  const value = input.trim();

  const zoned = ZONED_RE.exec(value);
  if (zoned) {
    const [, year, month, day, hour, minute, second, fraction, rawOffset] = zoned;
    assertDateFields({ year: Number(year), month: Number(month), day: Number(day) });
    const offset = rawOffset.toUpperCase() === 'Z' ? 'Z' : `${rawOffset.slice(0, 3)}:${rawOffset.slice(-2)}`;
    const iso = `${year}-${month}-${day}T${pad(Number(hour))}:${minute}:${second ?? '00'}${fraction ? `.${fraction.slice(0, 3)}` : ''}${offset}`;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime()) || Number(hour) > 23) {
      throw new ToolInputError(`Could not read ${label} "${input}".`);
    }
    return date;
  }

  const local = LOCAL_RE.exec(value);
  if (local) {
    const [, year, month, day, hour, minute, second, meridiem] = local;
    return zonedToUtc(
      {
        year: Number(year),
        month: Number(month),
        day: Number(day),
        hour: to24Hour(Number(hour), meridiem, input),
        minute: Number(minute),
        second: Number(second ?? 0),
      },
      timeZone,
    );
  }

  if (DATE_RE.test(value)) {
    throw new ToolInputError(`${label} needs a time of day too, e.g. "${value} 15:00" (in ${timeZone}).`);
  }
  throw new ToolInputError(
    `Could not read ${label} "${input}". Use "YYYY-MM-DD HH:mm" (wall time in ${timeZone}) or an ISO time with offset ` +
    'such as "2026-10-27T15:00:00+08:00".',
  );
}

// =============================================================================
// Calendar dates (YYYY-MM-DD strings)
// =============================================================================

export function dateString(fields: DateFields): string {
  return `${fields.year}-${pad(fields.month)}-${pad(fields.day)}`;
}

/** Calendar date of an instant in timeZone */
export function dateIn(date: Date, timeZone: string): string {
  return dateString(wallTime(date, timeZone));
}

export function todayIn(timeZone: string, now = new Date()): string {
  return dateIn(now, timeZone);
}

export function addDays(date: string, days: number): string {
  const { year, month, day } = parseDate(date);
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * DAY_MS);
  return dateString({ year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() });
}

export function weekdayOf(date: string): number {
  const { year, month, day } = parseDate(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function daysBetween(from: string, to: string): number {
  const a = parseDate(from);
  const b = parseDate(to);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY_MS);
}

/** First instant of the calendar day in timeZone (handles zones whose DST change is at midnight) */
export function startOfDay(date: string, timeZone: string): Date {
  const fields = parseDate(date);
  for (let hour = 0; hour < 3; hour++) {
    try {
      return zonedToUtc({ ...fields, hour }, timeZone);
    } catch {
      // midnight skipped by DST — the day starts at the first existing hour
    }
  }
  return zonedToUtc({ ...fields, hour: 3 }, timeZone);
}

/** Last millisecond of the calendar day in timeZone */
export function endOfDay(date: string, timeZone: string): Date {
  return new Date(startOfDay(addDays(date, 1), timeZone).getTime() - 1);
}

export function weekdayIndex(name?: string | null): number {
  const index = WEEKDAY_NAMES.findIndex(day => day.toLowerCase() === (name ?? '').toLowerCase());
  return index === -1 ? 1 : index;
}

// =============================================================================
// Range presets
// =============================================================================

export const RANGE_PRESETS = [
  'today',
  'tomorrow',
  'yesterday',
  'this_week',
  'next_week',
  'last_week',
  'next_7_days',
  'next_14_days',
  'next_30_days',
  'past_7_days',
  'past_30_days',
  'past_90_days',
  'this_month',
  'next_month',
  'last_month',
  'this_year',
  'last_year',
] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export interface DateRange {
  /** Inclusive calendar dates in the display zone */
  fromDate: string;
  toDate: string;
  /** UTC instants: start of fromDate, end of toDate */
  from: Date;
  to: Date;
}

function monthBounds(year: number, month: number): [string, string] {
  const normalized = new Date(Date.UTC(year, month - 1, 1));
  const first = dateString({ year: normalized.getUTCFullYear(), month: normalized.getUTCMonth() + 1, day: 1 });
  const last = new Date(Date.UTC(normalized.getUTCFullYear(), normalized.getUTCMonth() + 1, 0));
  return [first, dateString({ year: last.getUTCFullYear(), month: last.getUTCMonth() + 1, day: last.getUTCDate() })];
}

export function rangeFromDates(fromDate: string, toDate: string, timeZone: string): DateRange {
  if (daysBetween(fromDate, toDate) < 0) {
    throw new ToolInputError(`The range ends (${toDate}) before it starts (${fromDate}).`);
  }
  return { fromDate, toDate, from: startOfDay(fromDate, timeZone), to: endOfDay(toDate, timeZone) };
}

export function resolvePreset(
  preset: RangePreset,
  timeZone: string,
  options: { weekStart?: string | null; now?: Date } = {},
): DateRange {
  const today = todayIn(timeZone, options.now);
  const offsetToWeekStart = (weekdayOf(today) - weekdayIndex(options.weekStart) + 7) % 7;
  const weekStart = addDays(today, -offsetToWeekStart);
  const { year, month } = parseDate(today);

  const dates: Record<RangePreset, () => [string, string]> = {
    today: () => [today, today],
    tomorrow: () => [addDays(today, 1), addDays(today, 1)],
    yesterday: () => [addDays(today, -1), addDays(today, -1)],
    this_week: () => [weekStart, addDays(weekStart, 6)],
    next_week: () => [addDays(weekStart, 7), addDays(weekStart, 13)],
    last_week: () => [addDays(weekStart, -7), addDays(weekStart, -1)],
    next_7_days: () => [today, addDays(today, 6)],
    next_14_days: () => [today, addDays(today, 13)],
    next_30_days: () => [today, addDays(today, 29)],
    past_7_days: () => [addDays(today, -6), today],
    past_30_days: () => [addDays(today, -29), today],
    past_90_days: () => [addDays(today, -89), today],
    this_month: () => monthBounds(year, month),
    next_month: () => monthBounds(year, month + 1),
    last_month: () => monthBounds(year, month - 1),
    this_year: () => [`${year}-01-01`, `${year}-12-31`],
    last_year: () => [`${year - 1}-01-01`, `${year - 1}-12-31`],
  };

  const [fromDate, toDate] = dates[preset]();
  return rangeFromDates(fromDate, toDate, timeZone);
}

/** Equal-length range immediately before the given one (for period comparisons) */
export function previousRange(range: DateRange, timeZone: string): DateRange {
  const length = daysBetween(range.fromDate, range.toDate) + 1;
  return rangeFromDates(addDays(range.fromDate, -length), addDays(range.fromDate, -1), timeZone);
}

// =============================================================================
// Formatting
// =============================================================================

/** "Mon 27 Oct" (+ year when it differs from referenceYear) */
export function formatDateLabel(date: string, referenceYear?: number): string {
  const { year, month, day } = parseDate(date);
  const weekday = WEEKDAY_SHORT[weekdayOf(date)];
  const base = `${weekday} ${day} ${MONTH_SHORT[month - 1]}`;
  return referenceYear === year ? base : `${base} ${year}`;
}

/** "Mon 27 Oct – Sun 2 Nov 2026" */
export function formatRangeLabel(fromDate: string, toDate: string): string {
  if (fromDate === toDate) return formatDateLabel(fromDate);
  const fromYear = parseDate(fromDate).year;
  const toYear = parseDate(toDate).year;
  return fromYear === toYear
    ? `${formatDateLabel(fromDate, fromYear)} – ${formatDateLabel(toDate)}`
    : `${formatDateLabel(fromDate)} – ${formatDateLabel(toDate)}`;
}

/** "15:00" or "3:00 pm" */
export function formatClock(date: Date, timeZone: string, timeFormat: TimeFormat = 24): string {
  const { hour, minute } = wallTime(date, timeZone);
  if (timeFormat === 12) {
    const suffix = hour < 12 ? 'am' : 'pm';
    return `${hour % 12 || 12}:${pad(minute)} ${suffix}`;
  }
  return `${pad(hour)}:${pad(minute)}`;
}

/** "Mon 27 Oct 2026, 15:00" */
export function formatInstant(date: Date, timeZone: string, timeFormat: TimeFormat = 24): string {
  return `${formatDateLabel(dateIn(date, timeZone))}, ${formatClock(date, timeZone, timeFormat)}`;
}

export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

/** "2026-10-27T15:00:00+08:00" */
export function localIso(date: Date, timeZone: string): string {
  const wall = wallTime(date, timeZone);
  return `${dateString(wall)}T${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}${formatOffset(offsetMinutes(date, timeZone))}`;
}

/** "30 min", "1 h", "1 h 30 min", "2 d 3 h" */
export function formatDuration(totalMinutes: number): string {
  const minutes = Math.round(totalMinutes);
  if (minutes < 60) return `${minutes} min`;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return hours ? `${days} d ${hours} h` : `${days} d`;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export function weekdayName(index: number): string {
  return WEEKDAY_NAMES[index] ?? '';
}
