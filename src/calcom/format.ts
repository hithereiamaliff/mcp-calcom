/**
 * Output formatting for LLM consumption: agenda-style booking lists in the user's time zone,
 * compact slot lists, weekly hours as text, small markdown tables, and actionable hints for
 * Cal API errors.
 */

import type { CalApiError } from './http.js';
import { describeBookingLocation } from './locations.js';
import {
  type TimeFormat,
  dateIn,
  formatClock,
  formatDateLabel,
  formatDuration,
  localIso,
  parseDate,
  todayIn,
  wallTime,
} from './time.js';
import type { Booking, BookingAttendee, EventType, ScheduleAvailability, ScheduleOverride, Slot, SlotsMap } from './types.js';

const MAX_CELL_LENGTH = 140;

// =============================================================================
// Tables
// =============================================================================

export function escapeCell(value: unknown): string {
  const text = value === null || value === undefined || value === '' ? '—' : String(value);
  const flat = text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
  return flat.length > MAX_CELL_LENGTH ? `${flat.slice(0, MAX_CELL_LENGTH - 1)}…` : flat;
}

export function markdownTable(columns: string[], rows: Array<Record<string, unknown>>, emptyText = '_Nothing to show._'): string {
  if (rows.length === 0) return emptyText;
  const header = `| ${columns.join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map(row => `| ${columns.map(column => escapeCell(row[column])).join(' | ')} |`);
  return [header, divider, ...body].join('\n');
}

// =============================================================================
// Bookings
// =============================================================================

export function statusLabel(status: string): string {
  switch (status) {
    case 'pending':
      return '**pending confirmation**';
    case 'rejected':
      return 'declined';
    default:
      return status;
  }
}

function person(attendee: Pick<BookingAttendee, 'name' | 'email' | 'displayEmail'>): string {
  const email = attendee.displayEmail || attendee.email;
  if (!attendee.name || attendee.name === email) return email;
  return `${attendee.name} <${email}>`;
}

export function attendeeSummary(booking: Booking, max = 2): string {
  const attendees = booking.attendees ?? [];
  if (!attendees.length) return 'no attendees';
  const shown = attendees.slice(0, max).map(person);
  const more = attendees.length - shown.length + (booking.guests?.length ?? 0);
  return more > 0 ? `${shown.join(', ')} +${more} more` : shown.join(', ');
}

export function bookingTimes(booking: Booking, timeZone: string, timeFormat: TimeFormat): string {
  const start = new Date(booking.start);
  const end = new Date(booking.end);
  const sameDay = dateIn(start, timeZone) === dateIn(end, timeZone);
  const endText = sameDay ? formatClock(end, timeZone, timeFormat) : `${formatDateLabel(dateIn(end, timeZone))} ${formatClock(end, timeZone, timeFormat)}`;
  return `${formatClock(start, timeZone, timeFormat)}–${endText}`;
}

export function bookingLine(booking: Booking, timeZone: string, timeFormat: TimeFormat): string {
  const location = describeBookingLocation(booking.location);
  const parts = [
    bookingTimes(booking, timeZone, timeFormat),
    booking.title,
    attendeeSummary(booking),
    statusLabel(booking.status),
    ...(location ? [location] : []),
    `uid \`${booking.uid}\``,
  ];
  return `- ${parts.join(' · ')}`;
}

/** Bookings grouped by calendar day (in timeZone), in start order (newest first when descending) */
export function agenda(bookings: Booking[], timeZone: string, timeFormat: TimeFormat, descending = false): string[] {
  const direction = descending ? -1 : 1;
  const sorted = [...bookings].sort((a, b) => direction * (new Date(a.start).getTime() - new Date(b.start).getTime()));
  const currentYear = parseDate(todayIn(timeZone)).year;
  const lines: string[] = [];
  let currentDay = '';
  for (const booking of sorted) {
    const day = dateIn(new Date(booking.start), timeZone);
    if (day !== currentDay) {
      lines.push(`### ${formatDateLabel(day, currentYear)}`);
      currentDay = day;
    }
    lines.push(bookingLine(booking, timeZone, timeFormat));
  }
  return lines;
}

/** Stable JSON shape for one booking (UTC and local times side by side) */
export function normalizeBooking(booking: Booking, timeZone: string): Record<string, unknown> {
  const start = new Date(booking.start);
  const end = new Date(booking.end);
  return {
    uid: booking.uid,
    id: booking.id,
    title: booking.title,
    status: booking.status,
    start: booking.start,
    end: booking.end,
    start_local: localIso(start, timeZone),
    end_local: localIso(end, timeZone),
    duration_minutes: booking.duration ?? Math.round((end.getTime() - start.getTime()) / 60_000),
    event_type: booking.eventType ?? (booking.eventTypeId ? { id: booking.eventTypeId } : null),
    location: booking.location ?? null,
    attendees: (booking.attendees ?? []).map(attendee => ({
      ...(attendee.id !== undefined ? { id: attendee.id } : {}),
      name: attendee.name,
      email: attendee.displayEmail || attendee.email,
      time_zone: attendee.timeZone ?? null,
      absent: attendee.absent ?? false,
      ...(attendee.phoneNumber ? { phone: attendee.phoneNumber } : {}),
      ...(attendee.seatUid ? { seat_uid: attendee.seatUid } : {}),
    })),
    guests: booking.guests ?? [],
    hosts: (booking.hosts ?? []).map(host => ({ name: host.name, email: host.displayEmail || host.email, username: host.username })),
    absent_host: booking.absentHost ?? false,
    description: booking.description || null,
    booking_fields: booking.bookingFieldsResponses ?? {},
    cancellation_reason: booking.cancellationReason ?? null,
    rescheduling_reason: booking.reschedulingReason ?? null,
    rescheduled_from_uid: booking.rescheduledFromUid ?? null,
    rescheduled_to_uid: booking.rescheduledToUid ?? null,
    recurring_booking_uid: booking.recurringBookingUid ?? null,
    created_at: booking.createdAt ?? null,
  };
}

/** Human summary of one booking (detail view) */
export function bookingDetails(booking: Booking, timeZone: string, timeFormat: TimeFormat): string[] {
  const start = new Date(booking.start);
  const lines = [
    `## ${booking.title}`,
    `- When: ${formatDateLabel(dateIn(start, timeZone))}, ${bookingTimes(booking, timeZone, timeFormat)} (${timeZone})` +
      ` — ${formatDuration(booking.duration ?? (new Date(booking.end).getTime() - start.getTime()) / 60_000)}`,
    `- Status: ${statusLabel(booking.status)}`,
    `- uid: \`${booking.uid}\`${booking.recurringBookingUid ? ` (recurring series \`${booking.recurringBookingUid}\`)` : ''}`,
  ];
  if (booking.eventType?.id || booking.eventTypeId) {
    lines.push(`- Event type: ${booking.eventType?.slug ? `${booking.eventType.slug} ` : ''}(id ${booking.eventType?.id ?? booking.eventTypeId})`);
  }
  const location = describeBookingLocation(booking.location);
  if (location) lines.push(`- Location: ${location}`);
  for (const attendee of booking.attendees ?? []) {
    const extras = [attendee.timeZone, attendee.phoneNumber, attendee.absent ? 'marked absent' : '', attendee.id !== undefined ? `attendee id ${attendee.id}` : '']
      .filter(Boolean)
      .join(', ');
    lines.push(`- Attendee: ${person(attendee)}${extras ? ` (${extras})` : ''}`);
  }
  if (booking.guests?.length) lines.push(`- Guests: ${booking.guests.join(', ')}`);
  for (const host of booking.hosts ?? []) lines.push(`- Host: ${person({ name: host.name ?? '', email: host.email, displayEmail: host.displayEmail })}${booking.absentHost ? ' (marked absent)' : ''}`);
  if (booking.description) lines.push(`- Notes: ${booking.description.replace(/\s+/g, ' ').slice(0, 500)}`);
  const responses = Object.entries(booking.bookingFieldsResponses ?? {}).filter(
    ([key, value]) => !['name', 'email', 'guests', 'location', 'notes', 'title'].includes(key) && value !== '' && value !== null && value !== undefined,
  );
  for (const [key, value] of responses) lines.push(`- ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  if (booking.cancellationReason) lines.push(`- Cancellation reason: ${booking.cancellationReason}`);
  if (booking.reschedulingReason) lines.push(`- Rescheduling reason: ${booking.reschedulingReason}`);
  if (booking.rescheduledFromUid) lines.push(`- Rescheduled from \`${booking.rescheduledFromUid}\``);
  if (booking.rescheduledToUid) lines.push(`- Rescheduled to \`${booking.rescheduledToUid}\``);
  return lines;
}

// =============================================================================
// Slots
// =============================================================================

export function slotStart(slot: Slot): string {
  return typeof slot === 'string' ? slot : slot.start;
}

export interface SlotSummary {
  lines: string[];
  total: number;
  first?: Date;
}

/** One line per day: "- Mon 27 Oct: 09:00 09:30 11:00" (dates as returned by the API, already in timeZone) */
export function formatSlots(slots: SlotsMap, dates: string[], timeZone: string, timeFormat: TimeFormat, maxPerDay = 24): SlotSummary {
  const currentYear = parseDate(todayIn(timeZone)).year;
  const lines: string[] = [];
  let total = 0;
  let first: Date | undefined;

  for (const date of dates) {
    const daySlots = slots[date] ?? [];
    total += daySlots.length;
    const times = daySlots.map(slot => new Date(slotStart(slot))).filter(time => !Number.isNaN(time.getTime()));
    if (!first && times.length) first = times[0];
    const shown = times.slice(0, maxPerDay).map(time => formatClock(time, timeZone, timeFormat));
    const extra = times.length > maxPerDay ? ` (+${times.length - maxPerDay} more)` : '';
    lines.push(`- ${formatDateLabel(date, currentYear)}: ${shown.length ? shown.join(' ') + extra : 'none'}`);
  }
  return { lines, total, first };
}

// =============================================================================
// Schedules
// =============================================================================

const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_SHORT: Record<string, string> = {
  Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun',
};

/** ["Mon–Fri 09:00–17:00", "Sat 10:00–14:00"] — consecutive days with identical hours merged */
export function weeklyHours(availability: ScheduleAvailability[]): string[] {
  const byDay = new Map<string, string[]>();
  for (const block of availability) {
    for (const day of block.days) {
      const ranges = byDay.get(day) ?? [];
      ranges.push(`${block.startTime}–${block.endTime}`);
      byDay.set(day, ranges);
    }
  }
  if (byDay.size === 0) return ['No weekly hours (unavailable unless a date override adds time).'];

  const lines: string[] = [];
  let runStart = -1;
  let runHours = '';
  const flush = (end: number) => {
    if (runStart === -1 || !runHours) return;
    const label = runStart === end ? DAY_SHORT[DAY_ORDER[runStart]] : `${DAY_SHORT[DAY_ORDER[runStart]]}–${DAY_SHORT[DAY_ORDER[end]]}`;
    lines.push(`${label} ${runHours}`);
  };
  DAY_ORDER.forEach((day, index) => {
    const hours = (byDay.get(day) ?? []).sort().join(', ');
    if (hours === runHours && hours) return;
    flush(index - 1);
    runStart = hours ? index : -1;
    runHours = hours;
  });
  flush(DAY_ORDER.length - 1);
  const closed = DAY_ORDER.filter(day => !byDay.has(day)).map(day => DAY_SHORT[day]);
  if (closed.length) lines.push(`Unavailable: ${closed.join(', ')}`);
  return lines;
}

export function isUnavailableOverride(override: ScheduleOverride): boolean {
  return override.startTime === override.endTime;
}

export function describeOverride(override: ScheduleOverride): string {
  const day = formatDateLabel(override.date);
  return isUnavailableOverride(override) ? `${day}: unavailable all day` : `${day}: ${override.startTime}–${override.endTime}`;
}

// =============================================================================
// Misc
// =============================================================================

const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

/** Amounts are stored in the smallest currency unit (cents), as Cal and its payment apps do */
export function formatMoney(amount: number | null | undefined, currency?: string | null): string {
  if (!amount) return 'free';
  const code = (currency || 'USD').toUpperCase();
  const major = ZERO_DECIMAL_CURRENCIES.has(code) ? amount : amount / 100;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(major);
  } catch {
    return `${major.toFixed(2)} ${code}`;
  }
}

export interface PaymentInfo {
  /** Smallest currency unit */
  amount: number;
  currency: string;
  /** Payment app slug (hitpay, stripe, …) when the price comes from an app */
  app?: string;
}

/** Price of a paid event type: payment apps keep it in metadata.apps.<app>, older data in price */
export function paymentInfo(eventType: Pick<EventType, 'metadata' | 'price' | 'currency'>): PaymentInfo | undefined {
  const apps = (eventType.metadata as { apps?: Record<string, { enabled?: boolean; price?: unknown; currency?: unknown }> } | null | undefined)?.apps;
  for (const [app, data] of Object.entries(apps ?? {})) {
    if (data?.enabled && typeof data.price === 'number' && data.price > 0) {
      return { amount: data.price, currency: typeof data.currency === 'string' ? data.currency : eventType.currency || 'usd', app };
    }
  }
  if (typeof eventType.price === 'number' && eventType.price > 0) {
    return { amount: eventType.price, currency: eventType.currency || 'usd' };
  }
  return undefined;
}

export function hourLabel(date: Date, timeZone: string): string {
  return `${String(wallTime(date, timeZone).hour).padStart(2, '0')}:00`;
}

// =============================================================================
// Error hints
// =============================================================================

const BOOKING_ERROR_HINTS: Array<{ test: RegExp; hint: string }> = [
  { test: /no_available_users_found|hosts_unavailable|host_unavailable|booking_conflict/i, hint: 'That time is not available. Use get_available_slots to pick a free slot.' },
  { test: /booking_time_out_of_bounds/i, hint: "The time is outside the event type's booking window or minimum notice. Use get_available_slots to see bookable times." },
  { test: /booker_limit_exceeded/i, hint: 'This attendee already has the maximum number of active bookings for this event type.' },
  { test: /booking_seats_full|not_enough_available_seats/i, hint: 'All seats for that time are taken. Pick another slot.' },
  { test: /cancelled_bookings_cannot_be_rescheduled/i, hint: 'Cancelled bookings cannot be rescheduled. Create a new booking instead.' },
  { test: /event_type_not_found/i, hint: 'The event type was not found. Use list_event_types to get valid ids.' },
  { test: /booking_not_found/i, hint: 'The booking was not found. Use list_bookings to get valid uids.' },
  { test: /booker_email_blocked|booker_email_requires_login/i, hint: "The attendee's email is blocked or must log in to book this event type." },
  { test: /invalid_verification_code|requires.*verification/i, hint: 'This event type requires booker email verification, which cannot be completed through the API on behalf of someone else.' },
  { test: /private_link_expired/i, hint: 'The private link has expired or was used up.' },
  { test: /time.?zone/i, hint: 'Use an IANA time zone name such as "Asia/Kuala_Lumpur".' },
  { test: /slug/i, hint: 'Event type slugs must be unique on your account and use lowercase letters, numbers and dashes.' },
  { test: /payment/i, hint: 'This event type takes payment; bookings created through the API skip the checkout page. Share the booking link instead.' },
];

export function hintForError(error: CalApiError): string | undefined {
  if (error.status === 0) {
    return 'Could not reach the Cal.com API. Check the API URL and that the instance is reachable from this server.';
  }
  if (error.html) {
    return 'This URL serves a web page, not Cal API v2. Self-hosted Cal.diy / Cal.com runs API v2 as a separate service ' +
      '(apps/api/v2): deploy it and set the API URL to it, e.g. https://cal.example.com/api/v2 ' +
      '(see https://github.com/hithereiamaliff/mcp-calcom/blob/main/docs/CALDIY-API-V2.md).';
  }
  if (error.status === 401) {
    return 'The API key was rejected (invalid, expired or deleted). Create a new one in Cal → Settings → Developer → API Keys and update the connection.';
  }
  if (error.status === 403) {
    return 'The key is valid but not allowed to do this — the resource probably belongs to another user, or the event type does not allow it.';
  }
  if (error.status === 404) {
    return 'Not found. Check the id / uid (list_bookings, list_event_types and list_schedules show them). If it is correct, this Cal version may not have this endpoint.';
  }
  if (error.status === 409) {
    return 'Conflict — something with the same identity already exists (for example an event type slug).';
  }
  if (error.status === 429) {
    return `Rate limit reached (Cal allows about 120 requests per minute per API key).${error.retryAfterSeconds ? ` Try again in about ${Math.ceil(error.retryAfterSeconds)} s.` : ' Wait a minute and retry.'}`;
  }
  if (error.status === 400 || error.status === 422) {
    const text = [error.code, error.message, ...error.details].join(' ');
    return BOOKING_ERROR_HINTS.find(({ test }) => test.test(text))?.hint;
  }
  if (error.status >= 500) {
    return 'The Cal server failed while handling this request. Retry later; if it keeps failing, check the API v2 logs.';
  }
  return undefined;
}
