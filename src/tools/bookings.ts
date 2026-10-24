/**
 * Booking tools.
 *   always:           list_bookings, get_booking, get_booking_summary
 *   access bookings:  create_booking, reschedule_booking, cancel_booking, confirm_booking, decline_booking,
 *                     mark_no_show, add_booking_guests, remove_booking_attendee, update_booking_location
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  agenda,
  awaitingPayment,
  bookingDetails,
  bookingTimes,
  formatMoney,
  markdownTable,
  normalizeBooking,
  paymentInfo,
  paymentTypeIds,
  requiresConfirmation,
  slotStart,
  statusLabel,
} from '../calcom/format.js';
import type { QueryValue } from '../calcom/http.js';
import { describeBookingLocation, locationInputSchema, toBookingLocation, toUpdateLocation } from '../calcom/locations.js';
import {
  type RangePreset,
  addDays,
  dateIn,
  endOfDay,
  formatClock,
  formatDateLabel,
  formatDuration,
  formatInstant,
  formatRangeLabel,
  parseDateTime,
  previousRange,
  rangeFromDates,
  resolvePreset,
  startOfDay,
  wallTime,
  weekdayName,
} from '../calcom/time.js';
import type { Booking, EventType } from '../calcom/types.js';
import { ToolInputError } from '../errors.js';
import {
  DESTRUCTIVE,
  type Display,
  READ_ONLY,
  type ToolContext,
  WRITE,
  WRITE_IDEMPOTENT,
  allows,
  bookingUidParam,
  confirmParam,
  display,
  firstBooking,
  formatParam,
  jsonResult,
  requireConfirmation,
  runTool,
  textResult,
  timeZoneParam,
} from './shared.js';

// =============================================================================
// Ranges
// =============================================================================

const LIST_WHEN = [
  'upcoming',
  'unconfirmed',
  'past',
  'cancelled',
  'today',
  'tomorrow',
  'yesterday',
  'this_week',
  'next_week',
  'last_week',
  'next_7_days',
  'next_30_days',
  'past_7_days',
  'past_30_days',
  'this_month',
  'last_month',
  'custom',
] as const;

const SUMMARY_PERIODS = [
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'past_7_days',
  'past_30_days',
  'past_90_days',
  'this_year',
  'last_year',
  'next_7_days',
  'next_30_days',
  'custom',
] as const;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

interface InstantRange {
  from: Date;
  to: Date;
  label: string;
}

function customRange(from: string | undefined, to: string | undefined, timeZone: string): InstantRange {
  if (!from) {
    throw new ToolInputError('when / period "custom" needs from (and optionally to), e.g. from="2026-11-01", to="2026-11-07".');
  }
  const toValue = (to ?? from).trim();
  const start = DATE_ONLY.test(from.trim()) ? startOfDay(from.trim(), timeZone) : parseDateTime(from, timeZone, 'from');
  const end = DATE_ONLY.test(toValue) ? endOfDay(toValue, timeZone) : parseDateTime(toValue, timeZone, 'to');
  if (end.getTime() <= start.getTime()) throw new ToolInputError('"to" must be after "from".');
  return { from: start, to: end, label: formatRangeLabel(dateIn(start, timeZone), dateIn(end, timeZone)) };
}

function presetRange(preset: RangePreset, d: Display): InstantRange {
  const range = resolvePreset(preset, d.timeZone, { weekStart: d.profile.weekStart });
  return { from: range.from, to: range.to, label: formatRangeLabel(range.fromDate, range.toDate) };
}

// =============================================================================
// Slot pre-check
// =============================================================================

export interface EventTypeTarget {
  id?: number;
  slug?: string;
  username?: string;
  eventType?: EventType;
}

/** Event type by id, or by slug (yours, or another user's with username) */
export async function resolveEventType(
  ctx: ToolContext,
  args: { event_type_id?: number; event_type_slug?: string; username?: string },
  d: Display,
): Promise<EventTypeTarget> {
  if (args.event_type_id) {
    const eventType = await ctx.client.getEventType(args.event_type_id);
    return { id: eventType.id, eventType };
  }
  const slug = args.event_type_slug?.trim();
  if (slug) {
    const username = args.username?.trim() || d.profile.username;
    if (username === d.profile.username) {
      const eventType = (await ctx.client.listEventTypes()).find(candidate => candidate.slug === slug);
      if (!eventType) throw new ToolInputError(`You have no event type with slug "${slug}". Use list_event_types to see yours.`);
      return { id: eventType.id, eventType };
    }
    return { slug, username };
  }
  throw new ToolInputError('Pass event_type_id (see list_event_types) or event_type_slug.');
}

/** null when start is an open slot, otherwise a message listing nearby open slots */
async function slotProblem(
  ctx: ToolContext,
  target: EventTypeTarget,
  start: Date,
  d: Display,
  options: { duration?: number; rescheduleUid?: string } = {},
): Promise<string | null> {
  const day = dateIn(start, d.timeZone);
  const slots = await ctx.client.getSlots({
    ...(target.id ? { eventTypeId: target.id } : { eventTypeSlug: target.slug, username: target.username }),
    start: startOfDay(day, d.timeZone).toISOString(),
    end: endOfDay(addDays(day, 6), d.timeZone).toISOString(),
    timeZone: d.timeZone,
    duration: options.duration,
    bookingUidToReschedule: options.rescheduleUid,
  });

  const open = Object.values(slots)
    .flat()
    .map(slot => new Date(slotStart(slot)))
    .filter(time => !Number.isNaN(time.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  if (open.some(time => time.getTime() === start.getTime())) return null;

  const sameDay = open.filter(time => dateIn(time, d.timeZone) === day);
  const next = open.filter(time => time.getTime() > start.getTime()).slice(0, 5);
  return [
    `${formatInstant(start, d.timeZone, d.timeFormat)} (${d.timeZone}) is not an open slot for this event type.`,
    sameDay.length
      ? `Open times that day: ${sameDay.slice(0, 16).map(time => formatClock(time, d.timeZone, d.timeFormat)).join(', ')}.`
      : 'There are no open times that day.',
    next.length
      ? `Next open slots: ${next.map(time => formatInstant(time, d.timeZone, d.timeFormat)).join('; ')}.`
      : 'No open slots in the following 7 days.',
    'Call again with one of these times, or set check_availability: false to let Cal decide.',
  ].join(' ');
}

/**
 * Paid event types whose pending bookings are waiting for payment — only fetched when there is a
 * pending booking to label.
 */
async function paidTypesFor(ctx: ToolContext, bookings: Booking[]): Promise<Set<number> | undefined> {
  if (!bookings.some(booking => booking.status === 'pending')) return undefined;
  const eventTypes = await ctx.client.listEventTypes().catch(() => undefined);
  return eventTypes ? paymentTypeIds(eventTypes) : undefined;
}

const AWAITING_PAYMENT_NOTE =
  'Cal confirms a booking awaiting payment once the attendee pays; confirm_booking would mark it accepted while unpaid.';

// =============================================================================
// Summary statistics
// =============================================================================

interface Stats {
  total: number;
  active: number;
  accepted: number;
  pending: number;
  awaitingPayment: number;
  cancelled: number;
  declined: number;
  completed: number;
  upcoming: number;
  bookedMinutes: number;
  noShows: number;
  hostNoShows: number;
  uniqueAttendees: number;
  repeatAttendees: number;
  byEventType: Array<{ key: string; title: string; count: number; cancelled: number; minutes: number }>;
  byWeekday: number[];
  byHour: Array<{ hour: number; count: number }>;
  topAttendees: Array<{ email: string; name: string; count: number }>;
  cancellationReasons: Array<{ reason: string; count: number }>;
  revenue: Record<string, number>;
}

function bookingMinutes(booking: Booking): number {
  return booking.duration ?? Math.max(0, (new Date(booking.end).getTime() - new Date(booking.start).getTime()) / 60_000);
}

function computeStats(bookings: Booking[], eventTypes: Map<number, EventType>, timeZone: string, now = new Date()): Stats {
  const byEventType = new Map<string, { key: string; title: string; count: number; cancelled: number; minutes: number }>();
  const byWeekday = [0, 0, 0, 0, 0, 0, 0];
  const byHour = new Map<number, number>();
  const attendees = new Map<string, { email: string; name: string; count: number }>();
  const reasons = new Map<string, number>();
  const revenue: Record<string, number> = {};
  const paidTypes = paymentTypeIds([...eventTypes.values()]);
  const stats = {
    total: bookings.length, active: 0, accepted: 0, pending: 0, awaitingPayment: 0, cancelled: 0, declined: 0,
    completed: 0, upcoming: 0, bookedMinutes: 0, noShows: 0, hostNoShows: 0,
  };

  for (const booking of bookings) {
    const eventTypeId = booking.eventType?.id ?? booking.eventTypeId;
    const eventType = eventTypeId ? eventTypes.get(eventTypeId) : undefined;
    const key = eventTypeId ? String(eventTypeId) : 'none';
    const group = byEventType.get(key) ?? {
      key,
      title: eventType?.title ?? booking.eventType?.slug ?? (eventTypeId ? `event type ${eventTypeId}` : 'no event type'),
      count: 0,
      cancelled: 0,
      minutes: 0,
    };
    byEventType.set(key, group);

    if (booking.status === 'cancelled' || booking.status === 'rejected') {
      if (booking.status === 'cancelled') stats.cancelled++;
      else stats.declined++;
      group.cancelled++;
      const reason = booking.cancellationReason?.trim();
      if (reason) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      continue;
    }

    stats.active++;
    group.count++;
    const start = new Date(booking.start);
    const ended = new Date(booking.end).getTime() < now.getTime();
    const wall = wallTime(start, timeZone);
    byWeekday[wall.weekday]++;
    byHour.set(wall.hour, (byHour.get(wall.hour) ?? 0) + 1);

    for (const attendee of booking.attendees ?? []) {
      const email = (attendee.displayEmail || attendee.email).toLowerCase();
      const entry = attendees.get(email) ?? { email, name: attendee.name, count: 0 };
      entry.count++;
      attendees.set(email, entry);
    }

    if (booking.status === 'pending') {
      if (awaitingPayment(booking, paidTypes)) stats.awaitingPayment++;
      else stats.pending++;
      if (!ended) stats.upcoming++;
      continue;
    }

    stats.accepted++;
    const minutes = bookingMinutes(booking);
    stats.bookedMinutes += minutes;
    group.minutes += minutes;
    if (ended) stats.completed++;
    else stats.upcoming++;
    if (ended && booking.absentHost) stats.hostNoShows++;
    if (ended && booking.attendees?.some(attendee => attendee.absent)) stats.noShows++;

    const price = eventType ? paymentInfo(eventType) : undefined;
    if (price) {
      const currency = price.currency.toUpperCase();
      revenue[currency] = (revenue[currency] ?? 0) + price.amount;
    }
  }

  const attendeeList = [...attendees.values()];
  return {
    ...stats,
    uniqueAttendees: attendeeList.length,
    repeatAttendees: attendeeList.filter(attendee => attendee.count > 1).length,
    byEventType: [...byEventType.values()].sort((a, b) => b.count - a.count || b.cancelled - a.cancelled),
    byWeekday,
    byHour: [...byHour.entries()].map(([hour, count]) => ({ hour, count })).sort((a, b) => b.count - a.count || a.hour - b.hour),
    topAttendees: attendeeList.sort((a, b) => b.count - a.count).slice(0, 5),
    cancellationReasons: [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 5),
    revenue,
  };
}

async function fetchAllBookings(
  ctx: ToolContext,
  query: Record<string, QueryValue>,
  maxPages = 10,
): Promise<{ bookings: Booking[]; truncated: boolean }> {
  const all: Booking[] = [];
  for (let page = 0; page < maxPages; page++) {
    const { bookings, pagination } = await ctx.client.listBookings({ ...query, take: 100, skip: page * 100 });
    all.push(...bookings);
    const more = pagination?.hasNextPage ?? bookings.length === 100;
    if (!more) return { bookings: all, truncated: false };
  }
  return { bookings: all, truncated: true };
}

function change(current: number, previous: number): string {
  if (previous === 0) return current === 0 ? '—' : 'new';
  const percent = Math.round(((current - previous) / previous) * 100);
  return `${percent > 0 ? '+' : ''}${percent}%`;
}

function revenueText(revenue: Record<string, number>): string {
  const entries = Object.entries(revenue);
  return entries.length ? entries.map(([currency, amount]) => formatMoney(amount, currency)).join(' + ') : '—';
}

// =============================================================================
// Output helpers
// =============================================================================

function bookedSummary(booking: Booking, d: Display, heading: string, paidTypes?: ReadonlySet<number>): string[] {
  const location = describeBookingLocation(booking.location);
  return [
    `## ${heading}: ${booking.title}`,
    `- When: ${formatDateLabel(dateIn(new Date(booking.start), d.timeZone))}, ${bookingTimes(booking, d.timeZone, d.timeFormat)} (${d.timeZone})`,
    `- Status: ${statusLabel(booking.status, awaitingPayment(booking, paidTypes))}`,
    `- uid: \`${booking.uid}\``,
    ...(location ? [`- Location: ${location}`] : []),
    ...(booking.attendees ?? []).map(attendee => `- Attendee: ${attendee.name} <${attendee.displayEmail || attendee.email}>`),
    ...(booking.guests?.length ? [`- Guests: ${booking.guests.join(', ')}`] : []),
  ];
}

const attendeeSchema = z.object({
  name: z.string().trim().min(1).describe('Full name.'),
  email: z.string().trim().email().describe('Email address — Cal sends the confirmation here.'),
  time_zone: z.string().optional().describe('Attendee IANA time zone, e.g. "Europe/London". Default: the time_zone used for start.'),
  phone: z.string().optional().describe('Phone number in international format, e.g. "+60123456789".'),
  language: z.string().optional().describe('Language for Cal emails, e.g. "en", "ms", "id".'),
});

// =============================================================================
// Registration
// =============================================================================

export function registerBookingTools(server: McpServer, ctx: ToolContext): void {
  // ---------------------------------------------------------------------------
  // list_bookings
  // ---------------------------------------------------------------------------
  server.registerTool(
    'list_bookings',
    {
      title: 'List bookings',
      description:
        'List bookings as an agenda grouped by day in your time zone. Default: upcoming bookings (including ones ' +
        'waiting for confirmation or payment). Use when= for today / this_week / past / cancelled / a custom range, and filter by ' +
        'attendee or event type. Each line shows the booking uid used by the other booking tools.',
      inputSchema: {
        when: z
          .enum(LIST_WHEN)
          .optional()
          .describe('upcoming (default) · unconfirmed (waiting for your confirmation or for payment) · past · cancelled · a date range preset · custom (with from/to).'),
        from: z.string().optional().describe('when="custom": start date "YYYY-MM-DD" or datetime, in time_zone.'),
        to: z.string().optional().describe('when="custom": end date (inclusive) or datetime. Default: same day as from.'),
        status: z
          .array(z.enum(['upcoming', 'recurring', 'past', 'cancelled', 'unconfirmed']))
          .optional()
          .describe("Override Cal's status filter (OR-combined). Usually leave empty and use when."),
        include_cancelled: z.boolean().optional().describe('Date ranges only: also show cancelled / declined bookings (default false).'),
        attendee_email: z.string().optional().describe('Only bookings with this attendee email.'),
        attendee_name: z.string().optional().describe('Only bookings with an attendee of this name.'),
        event_type_id: z.number().int().positive().optional().describe('Only bookings of this event type (id from list_event_types).'),
        sort: z.enum(['asc', 'desc']).optional().describe('Order by start time. Default: asc, or desc for past / cancelled.'),
        limit: z.number().int().min(1).max(100).optional().describe('Maximum bookings to return (default 50).'),
        offset: z.number().int().min(0).optional().describe('Skip this many bookings (pagination).'),
        time_zone: timeZoneParam,
        format: formatParam,
      },
      annotations: READ_ONLY,
    },
    async args => runTool(async () => {
      const d = await display(ctx, args.time_zone);
      const when = args.when ?? 'upcoming';
      const limit = args.limit ?? 50;
      const offset = args.offset ?? 0;
      const query: Record<string, QueryValue> = { take: limit, skip: offset };

      let label: string;
      let statuses: string[] | undefined;
      let descending = false;
      switch (when) {
        case 'upcoming':
          statuses = ['upcoming', 'unconfirmed'];
          label = 'Upcoming bookings';
          break;
        case 'unconfirmed':
          statuses = ['unconfirmed'];
          label = 'Bookings waiting for confirmation or payment';
          break;
        case 'past':
          statuses = ['past'];
          label = 'Past bookings (most recent first)';
          descending = true;
          break;
        case 'cancelled':
          statuses = ['cancelled'];
          label = 'Cancelled and declined bookings (most recent first)';
          descending = true;
          break;
        default: {
          const range = when === 'custom' ? customRange(args.from, args.to, d.timeZone) : presetRange(when, d);
          query.afterStart = range.from.toISOString();
          query.beforeEnd = range.to.toISOString();
          statuses = args.include_cancelled ? undefined : ['upcoming', 'past', 'unconfirmed'];
          label = `Bookings · ${range.label}`;
        }
      }
      if (args.status?.length) statuses = args.status;
      if (statuses) query.status = statuses;
      if (args.sort) descending = args.sort === 'desc';
      query.sortStart = descending ? 'desc' : 'asc';
      if (args.attendee_email) query.attendeeEmail = args.attendee_email.trim();
      if (args.attendee_name) query.attendeeName = args.attendee_name.trim();
      if (args.event_type_id) query.eventTypeId = args.event_type_id;

      const { bookings, pagination } = await ctx.client.listBookings(query);
      const total = pagination?.totalItems;
      const hasMore = pagination?.hasNextPage ?? bookings.length === limit;
      const paidTypes = await paidTypesFor(ctx, bookings);

      if (args.format === 'json') {
        return jsonResult({
          time_zone: d.timeZone,
          range: label,
          bookings: bookings.map(booking => normalizeBooking(booking, d.timeZone, paidTypes)),
          pagination: { offset, returned: bookings.length, total: total ?? null, has_more: hasMore },
        });
      }

      const filters = [
        args.attendee_email && `attendee ${args.attendee_email}`,
        args.attendee_name && `attendee name "${args.attendee_name}"`,
        args.event_type_id && `event type ${args.event_type_id}`,
        args.status?.length && `status ${args.status.join(' or ')}`,
      ].filter(Boolean);

      const lines = [`## ${label} · ${d.timeZone}`];
      if (filters.length) lines.push(`_Filtered by ${filters.join(', ')}._`);
      lines.push(...(bookings.length ? agenda(bookings, d.timeZone, d.timeFormat, descending, paidTypes) : ['_No bookings found._']));
      if (bookings.length) {
        const pending = bookings.filter(booking => booking.status === 'pending');
        const unpaid = pending.filter(booking => awaitingPayment(booking, paidTypes)).length;
        const footer = total !== undefined
          ? `Showing ${offset + 1}–${offset + bookings.length} of ${total}.`
          : `${bookings.length} booking(s).`;
        lines.push('', `_${footer}${hasMore ? ` Call again with offset=${offset + bookings.length} for more.` : ''}` +
          `${pending.length > unpaid ? ' Pending bookings can be handled with confirm_booking / decline_booking.' : ''}` +
          `${unpaid ? ` ${AWAITING_PAYMENT_NOTE}` : ''}_`);
      }
      return textResult(lines.join('\n'));
    }),
  );

  // ---------------------------------------------------------------------------
  // get_booking
  // ---------------------------------------------------------------------------
  const INCLUDES = ['attendees', 'calendar_links', 'references', 'recordings', 'transcripts', 'conferencing_sessions'] as const;

  server.registerTool(
    'get_booking',
    {
      title: 'Get a booking',
      description:
        'Full details of one booking (or every occurrence of a recurring series): time, status, attendees, guests, ' +
        'location / meeting link, booking-form answers, cancellation or reschedule info. Optionally include attendee ids, ' +
        'add-to-calendar links, calendar references, Cal Video recordings, transcripts and meeting sessions.',
      inputSchema: {
        booking_uid: bookingUidParam.optional(),
        seat_uid: z.string().optional().describe('For seated events: look the booking up by seat uid instead.'),
        include: z.array(z.enum(INCLUDES)).optional().describe('Extra data to fetch alongside the booking.'),
        time_zone: timeZoneParam,
        format: formatParam,
      },
      annotations: READ_ONLY,
    },
    async args => runTool(async () => {
      if (!args.booking_uid && !args.seat_uid) throw new ToolInputError('Pass booking_uid (from list_bookings) or seat_uid.');
      const d = await display(ctx, args.time_zone);
      const data = args.seat_uid ? await ctx.client.getBookingBySeat(args.seat_uid) : await ctx.client.getBooking(args.booking_uid!);
      const occurrences = Array.isArray(data) ? data : [data];
      if (!occurrences.length) throw new ToolInputError('Booking not found.');
      const booking = occurrences[0];
      const uid = args.booking_uid ?? booking.uid;

      const includes = args.include ?? [];
      const fetchers: Record<(typeof INCLUDES)[number], () => Promise<unknown>> = {
        attendees: () => ctx.client.listAttendees(uid),
        calendar_links: () => ctx.client.getCalendarLinks(uid),
        references: () => ctx.client.getReferences(uid),
        recordings: () => ctx.client.getRecordings(uid),
        transcripts: () => ctx.client.getTranscripts(uid),
        conferencing_sessions: () => ctx.client.getConferencingSessions(uid),
      };
      const settled = await Promise.allSettled(includes.map(name => fetchers[name]()));
      const extras = Object.fromEntries(includes.map((name, index) => {
        const result = settled[index];
        return [name, result.status === 'fulfilled' ? result.value : { error: result.reason instanceof Error ? result.reason.message : String(result.reason) }];
      }));

      const paidTypes = await paidTypesFor(ctx, occurrences);

      if (args.format === 'json') {
        return jsonResult({
          time_zone: d.timeZone,
          booking: normalizeBooking(booking, d.timeZone, paidTypes),
          ...(occurrences.length > 1 ? { occurrences: occurrences.map(occurrence => normalizeBooking(occurrence, d.timeZone, paidTypes)) } : {}),
          ...extras,
        });
      }

      const lines = bookingDetails(booking, d.timeZone, d.timeFormat, paidTypes);
      if (awaitingPayment(booking, paidTypes)) lines.push(`_${AWAITING_PAYMENT_NOTE}_`);
      if (occurrences.length > 1) {
        lines.push('', `### Recurring series — ${occurrences.length} occurrences`, ...agenda(occurrences, d.timeZone, d.timeFormat, false, paidTypes));
      }
      for (const name of includes) {
        const value = extras[name];
        lines.push('', `### ${name.replace(/_/g, ' ')}`);
        if (value && typeof value === 'object' && 'error' in (value as object) && !Array.isArray(value)) {
          lines.push(`_Unavailable: ${(value as { error: string }).error}_`);
          continue;
        }
        const list = Array.isArray(value) ? value : [];
        if (!list.length) {
          lines.push('_None._');
          continue;
        }
        switch (name) {
          case 'attendees':
            lines.push(markdownTable(['id', 'name', 'email', 'time_zone', 'absent'], (list as Array<Record<string, unknown>>).map(attendee => ({
              id: attendee.id, name: attendee.name, email: attendee.displayEmail ?? attendee.email, time_zone: attendee.timeZone, absent: attendee.absent ? 'yes' : '',
            }))));
            break;
          case 'calendar_links':
            lines.push(...(list as Array<{ label: string; link: string }>).map(link => link.link.startsWith('data:')
              ? `- ${link.label}: inline file (use format "json" to get it)`
              : `- ${link.label}: ${link.link.replace(/ /g, '%20')}`));
            break;
          case 'references':
            lines.push(markdownTable(['type', 'event_uid', 'calendar'], (list as Array<Record<string, unknown>>).map(reference => ({
              type: reference.type, event_uid: reference.eventUid, calendar: reference.destinationCalendarId,
            }))));
            break;
          case 'recordings':
            lines.push(markdownTable(['id', 'started', 'duration', 'status', 'download'], (list as Array<Record<string, unknown>>).map(recording => ({
              id: recording.id,
              started: typeof recording.startTs === 'number' ? formatInstant(new Date(recording.startTs * 1000), d.timeZone, d.timeFormat) : '',
              duration: typeof recording.duration === 'number' ? formatDuration(recording.duration / 60) : '',
              status: recording.status,
              download: recording.downloadLink ?? recording.error,
            }))));
            break;
          case 'transcripts':
            lines.push(...(list as string[]).map(link => `- ${link}`), '_Transcript links expire after one hour._');
            break;
          case 'conferencing_sessions':
            lines.push(markdownTable(['started', 'duration', 'participants'], (list as Array<Record<string, unknown>>).map(session => ({
              started: typeof session.startTime === 'number' ? formatInstant(new Date(session.startTime * 1000), d.timeZone, d.timeFormat) : '',
              duration: typeof session.duration === 'number' ? formatDuration(session.duration / 60) : '',
              participants: Array.isArray(session.participants) ? session.participants.map(p => (p as { userName?: string }).userName ?? '?').join(', ') : '',
            }))));
            break;
        }
      }
      return textResult(lines.join('\n'));
    }),
  );

  // ---------------------------------------------------------------------------
  // get_booking_summary
  // ---------------------------------------------------------------------------
  server.registerTool(
    'get_booking_summary',
    {
      title: 'Booking summary',
      description:
        'Statistics for a period, computed from your bookings (Cal.diy has no Insights page): bookings by status and ' +
        'event type, booked hours, cancellations and their reasons, no-shows, busiest weekdays and hours, top and repeat ' +
        'attendees, and estimated revenue from paid event types — compared with the previous period by default.',
      inputSchema: {
        period: z.enum(SUMMARY_PERIODS).optional().describe('Default past_30_days. "custom" needs from / to.'),
        from: z.string().optional().describe('period="custom": start date "YYYY-MM-DD".'),
        to: z.string().optional().describe('period="custom": end date (inclusive).'),
        event_type_id: z.number().int().positive().optional().describe('Only this event type.'),
        compare_previous: z.boolean().optional().describe('Compare with the previous period of the same length (default true).'),
        time_zone: timeZoneParam,
        format: formatParam,
      },
      annotations: READ_ONLY,
    },
    async args => runTool(async () => {
      const d = await display(ctx, args.time_zone);
      const period = args.period ?? 'past_30_days';

      let fromDate: string;
      let toDate: string;
      if (period === 'custom') {
        const custom = customRange(args.from, args.to, d.timeZone);
        fromDate = dateIn(custom.from, d.timeZone);
        toDate = dateIn(custom.to, d.timeZone);
      } else {
        const preset = resolvePreset(period, d.timeZone, { weekStart: d.profile.weekStart });
        fromDate = preset.fromDate;
        toDate = preset.toDate;
      }
      const range = rangeFromDates(fromDate, toDate, d.timeZone);
      const compare = args.compare_previous !== false;
      const previous = compare ? previousRange(range, d.timeZone) : undefined;

      const baseQuery = (from: Date, to: Date): Record<string, QueryValue> => ({
        afterStart: from.toISOString(),
        beforeEnd: to.toISOString(),
        sortStart: 'asc',
        ...(args.event_type_id ? { eventTypeId: args.event_type_id } : {}),
      });

      const [current, prior, eventTypes] = await Promise.all([
        fetchAllBookings(ctx, baseQuery(range.from, range.to)),
        previous ? fetchAllBookings(ctx, baseQuery(previous.from, previous.to)) : Promise.resolve(undefined),
        ctx.client.listEventTypes().catch(() => [] as EventType[]),
      ]);
      const eventTypesById = new Map(eventTypes.map(eventType => [eventType.id, eventType]));
      const stats = computeStats(current.bookings, eventTypesById, d.timeZone);
      const before = prior ? computeStats(prior.bookings, eventTypesById, d.timeZone) : undefined;
      const periodLabel = formatRangeLabel(range.fromDate, range.toDate);
      const previousLabel = previous ? formatRangeLabel(previous.fromDate, previous.toDate) : undefined;

      if (args.format === 'json') {
        return jsonResult({
          time_zone: d.timeZone,
          period: { from: range.fromDate, to: range.toDate },
          previous_period: previous ? { from: previous.fromDate, to: previous.toDate } : null,
          stats: { ...stats, bookedHours: Math.round((stats.bookedMinutes / 60) * 10) / 10 },
          previous: before ?? null,
          truncated: current.truncated || Boolean(prior?.truncated),
        });
      }

      const rows: Array<[string, string, string?]> = [
        ['bookings (not cancelled)', String(stats.active), before ? String(before.active) : undefined],
        ['accepted', String(stats.accepted), before ? String(before.accepted) : undefined],
        ['waiting for confirmation', String(stats.pending), before ? String(before.pending) : undefined],
        ...(stats.awaitingPayment || before?.awaitingPayment
          ? [['awaiting payment', String(stats.awaitingPayment), before ? String(before.awaitingPayment) : undefined] as [string, string, string?]]
          : []),
        ['cancelled / declined', `${stats.cancelled + stats.declined}${stats.total ? ` (${Math.round(((stats.cancelled + stats.declined) / stats.total) * 100)}%)` : ''}`, before ? String(before.cancelled + before.declined) : undefined],
        ['booked time (accepted)', formatDuration(stats.bookedMinutes), before ? formatDuration(before.bookedMinutes) : undefined],
        ['attendee no-shows', String(stats.noShows), before ? String(before.noShows) : undefined],
        ['host no-shows', String(stats.hostNoShows), before ? String(before.hostNoShows) : undefined],
        ['unique attendees', String(stats.uniqueAttendees), before ? String(before.uniqueAttendees) : undefined],
        ['est. revenue (accepted, paid types)', revenueText(stats.revenue), before ? revenueText(before.revenue) : undefined],
      ];
      const numeric: Record<string, [number, number] | undefined> = before ? {
        'bookings (not cancelled)': [stats.active, before.active],
        accepted: [stats.accepted, before.accepted],
        'cancelled / declined': [stats.cancelled + stats.declined, before.cancelled + before.declined],
        'booked time (accepted)': [stats.bookedMinutes, before.bookedMinutes],
        'unique attendees': [stats.uniqueAttendees, before.uniqueAttendees],
      } : {};

      const lines = [
        `## Booking summary · ${periodLabel} · ${d.timeZone}`,
        ...(args.event_type_id ? [`_Event type ${eventTypesById.get(args.event_type_id)?.title ?? args.event_type_id} only._`] : []),
        before
          ? markdownTable(['metric', 'this period', `previous (${previousLabel})`, 'change'], rows.map(([metric, value, prev]) => ({
            metric, 'this period': value, [`previous (${previousLabel})`]: prev, change: numeric[metric] ? change(numeric[metric]![0], numeric[metric]![1]) : '',
          })))
          : markdownTable(['metric', 'value'], rows.map(([metric, value]) => ({ metric, value }))),
      ];

      if (stats.byEventType.length) {
        lines.push('', '### By event type', markdownTable(['event type', 'bookings', 'cancelled', 'booked time'], stats.byEventType.map(group => ({
          'event type': group.title, bookings: group.count, cancelled: group.cancelled, 'booked time': formatDuration(group.minutes),
        }))));
      }
      if (stats.active) {
        const weekdays = [1, 2, 3, 4, 5, 6, 0].filter(day => stats.byWeekday[day] > 0)
          .map(day => `${weekdayName(day).slice(0, 3)} (${stats.byWeekday[day]})`);
        lines.push('', `### Busiest days\n${weekdays.join(' · ')}`);
        lines.push('', `### Busiest start hours\n${stats.byHour.slice(0, 5).map(({ hour, count }) => `${String(hour).padStart(2, '0')}:00 (${count})`).join(' · ')}`);
      }
      if (stats.topAttendees.length) {
        lines.push('', '### Top attendees', ...stats.topAttendees.map(attendee => `- ${attendee.name} <${attendee.email}> — ${attendee.count}`));
        if (stats.repeatAttendees) lines.push(`_${stats.repeatAttendees} attendee(s) booked more than once in this period._`);
      }
      if (stats.cancellationReasons.length) {
        lines.push('', '### Cancellation reasons', ...stats.cancellationReasons.map(({ reason, count }) => `- ${reason} (${count})`));
      }
      if (current.truncated || prior?.truncated) {
        lines.push('', '_Only the first 1,000 bookings of a period were analysed — use a shorter period for exact numbers._');
      }
      if (Object.keys(stats.revenue).length) {
        lines.push('', '_Revenue is estimated from event type prices (no refunds, discounts or failed payments)._');
      }
      return textResult(lines.join('\n'));
    }),
  );

  if (!allows(ctx, 'bookings')) return;

  // ---------------------------------------------------------------------------
  // create_booking
  // ---------------------------------------------------------------------------
  server.registerTool(
    'create_booking',
    {
      title: 'Create a booking',
      description:
        'Book someone into one of your event types. Cal sends the confirmation emails and calendar invites as for a ' +
        'normal booking. By default the time is first checked against open slots (get_available_slots); if it is not ' +
        'open, nearby open times are returned instead of booking. link / address / phone locations use what the event ' +
        'type defines — to give one booking its own link, book it and then call update_booking_location.',
      inputSchema: {
        event_type_id: z.number().int().positive().optional().describe('Event type id (list_event_types). Or use event_type_slug.'),
        event_type_slug: z.string().optional().describe('Event type slug, e.g. "30min".'),
        username: z.string().optional().describe('Owner of event_type_slug when it is not you.'),
        start: z.string().describe('Start time: "YYYY-MM-DD HH:mm" (wall time in time_zone) or ISO with offset, e.g. "2026-10-27T15:00:00+08:00".'),
        time_zone: timeZoneParam,
        attendee: attendeeSchema.describe('The person being booked.'),
        guests: z.array(z.string().trim().email()).max(10).optional().describe('Extra guest emails to invite.'),
        location: locationInputSchema.optional().describe("Which of the event type's locations to use. Default: the event type's first location."),
        length_in_minutes: z.number().int().positive().optional().describe('For event types with several lengths: the length to book.'),
        notes: z.string().optional().describe('Additional notes shown on the booking (the "notes" field).'),
        booking_fields: z.record(z.unknown()).optional().describe('Answers to custom booking questions, keyed by field slug (see get_event_type).'),
        metadata: z.record(z.string()).optional().describe('Up to 50 string key/values stored on the booking.'),
        recurrence_count: z.number().int().positive().optional().describe('Recurring event types: number of occurrences to book (default: the event type setting).'),
        check_availability: z.boolean().optional().describe('Check the time against open slots first (default true).'),
        allow_unpaid: z.boolean().optional().describe('Paid event types: create the booking even though no payment is collected (default false).'),
      },
      annotations: WRITE,
    },
    async args => runTool(async () => {
      const d = await display(ctx, args.time_zone);
      const target = await resolveEventType(ctx, args, d);
      const start = parseDateTime(args.start, d.timeZone, 'start');
      if (start.getTime() < Date.now() - 60_000) {
        throw new ToolInputError(`${formatInstant(start, d.timeZone, d.timeFormat)} (${d.timeZone}) is in the past.`);
      }

      const price = target.eventType ? paymentInfo(target.eventType) : undefined;
      if (price && !args.allow_unpaid) {
        throw new ToolInputError(
          `"${target.eventType!.title}" is a paid event type (${formatMoney(price.amount, price.currency)}${price.app ? ` via ${price.app}` : ''}). ` +
          'A booking created through the API does not collect the payment, so it may stay unpaid. Share the booking page instead' +
          `${target.eventType!.bookingUrl ? ` (${target.eventType!.bookingUrl})` : ''}, or call again with allow_unpaid: true to create it anyway.`,
        );
      }

      if (args.check_availability !== false) {
        const problem = await slotProblem(ctx, target, start, d, { duration: args.length_in_minutes });
        if (problem) throw new ToolInputError(problem);
      }

      const bookingFields = { ...(args.booking_fields ?? {}), ...(args.notes ? { notes: args.notes } : {}) };
      const body: Record<string, unknown> = {
        start: start.toISOString(),
        attendee: {
          name: args.attendee.name,
          email: args.attendee.email,
          timeZone: args.attendee.time_zone?.trim() || d.timeZone,
          ...(args.attendee.phone ? { phoneNumber: args.attendee.phone } : {}),
          ...(args.attendee.language ? { language: args.attendee.language } : {}),
        },
        ...(target.id ? { eventTypeId: target.id } : { eventTypeSlug: target.slug, username: target.username }),
        ...(args.guests?.length ? { guests: args.guests } : {}),
        ...(args.location ? { location: toBookingLocation(args.location) } : {}),
        ...(args.length_in_minutes ? { lengthInMinutes: args.length_in_minutes } : {}),
        ...(Object.keys(bookingFields).length ? { bookingFieldsResponses: bookingFields } : {}),
        ...(args.metadata ? { metadata: args.metadata } : {}),
        ...(args.recurrence_count ? { recurrenceCount: args.recurrence_count } : {}),
      };

      const { booking, count } = firstBooking(await ctx.client.createBooking(body));
      const paidTypes = target.eventType ? paymentTypeIds([target.eventType]) : undefined;
      const lines = bookedSummary(booking, d, 'Booked', paidTypes);
      if (count > 1) lines.push(`- Recurring: ${count} occurrences booked (first shown).`);
      if (awaitingPayment(booking, paidTypes)) {
        lines.push('', '_No payment was collected, so Cal keeps this booking pending until it is paid._');
      } else {
        if (booking.status === 'pending') lines.push('', '_This event type requires confirmation — the booking stays pending until it is confirmed (confirm_booking)._');
        if (price) lines.push('', '_No payment was collected for this paid event type._');
      }
      return textResult(lines.join('\n'));
    }),
  );

  // ---------------------------------------------------------------------------
  // reschedule_booking
  // ---------------------------------------------------------------------------
  server.registerTool(
    'reschedule_booking',
    {
      title: 'Reschedule a booking',
      description:
        'Move a booking to a new time. The new time is checked against open slots first (unless check_availability is ' +
        'false). Cal creates a new booking with a new uid and notifies everyone.',
      inputSchema: {
        booking_uid: bookingUidParam,
        start: z.string().describe('New start: "YYYY-MM-DD HH:mm" (wall time in time_zone) or ISO with offset.'),
        time_zone: timeZoneParam,
        reason: z.string().optional().describe('Reason shown to the attendees.'),
        rescheduled_by: z.string().email().optional().describe('Email of who is rescheduling — needed for event types that require confirmation (the owner email skips re-confirmation).'),
        seat_uid: z.string().optional().describe('Seated events: move only this seat.'),
        check_availability: z.boolean().optional().describe('Check the new time against open slots first (default true).'),
      },
      annotations: WRITE,
    },
    async args => runTool(async () => {
      const d = await display(ctx, args.time_zone);
      const { booking: current } = firstBooking(await ctx.client.getBooking(args.booking_uid));
      if (current.status === 'cancelled' || current.status === 'rejected') {
        throw new ToolInputError('Cancelled or declined bookings cannot be rescheduled. Create a new booking instead.');
      }
      const start = parseDateTime(args.start, d.timeZone, 'start');
      if (start.getTime() < Date.now() - 60_000) {
        throw new ToolInputError(`${formatInstant(start, d.timeZone, d.timeFormat)} (${d.timeZone}) is in the past.`);
      }

      const eventTypeId = current.eventType?.id ?? current.eventTypeId;
      if (args.check_availability !== false && eventTypeId) {
        const problem = await slotProblem(ctx, { id: eventTypeId }, start, d, {
          duration: current.duration,
          rescheduleUid: args.booking_uid,
        });
        if (problem) throw new ToolInputError(problem);
      }

      const body: Record<string, unknown> = args.seat_uid
        ? { start: start.toISOString(), seatUid: args.seat_uid, ...(args.rescheduled_by ? { rescheduledBy: args.rescheduled_by } : {}) }
        : {
          start: start.toISOString(),
          ...(args.reason ? { reschedulingReason: args.reason } : {}),
          ...(args.rescheduled_by ? { rescheduledBy: args.rescheduled_by } : {}),
        };
      const { booking } = firstBooking(await ctx.client.rescheduleBooking(args.booking_uid, body));
      const lines = bookedSummary(booking, d, 'Rescheduled');
      lines.push(`- Previously: ${formatInstant(new Date(current.start), d.timeZone, d.timeFormat)} (uid \`${current.uid}\`)`);
      if (booking.uid !== current.uid) lines.push('', `_Use the new uid \`${booking.uid}\` for further changes._`);
      return textResult(lines.join('\n'));
    }),
  );

  // ---------------------------------------------------------------------------
  // cancel_booking
  // ---------------------------------------------------------------------------
  server.registerTool(
    'cancel_booking',
    {
      title: 'Cancel a booking',
      description: 'Cancel a booking; Cal notifies the attendees. Needs confirm: true after the user agrees.',
      inputSchema: {
        booking_uid: bookingUidParam,
        reason: z.string().optional().describe('Cancellation reason shown to the attendees.'),
        cancel_subsequent: z.boolean().optional().describe('Recurring bookings: also cancel every later occurrence.'),
        seat_uid: z.string().optional().describe('Seated events: cancel only this seat.'),
        confirm: confirmParam,
        time_zone: timeZoneParam,
      },
      annotations: DESTRUCTIVE,
    },
    async args => runTool(async () => {
      requireConfirmation(args.confirm, 'Cancelling a booking');
      const d = await display(ctx, args.time_zone);
      const body: Record<string, unknown> = args.seat_uid
        ? { seatUid: args.seat_uid, ...(args.reason ? { cancellationReason: args.reason } : {}) }
        : {
          ...(args.reason ? { cancellationReason: args.reason } : {}),
          ...(args.cancel_subsequent ? { cancelSubsequentBookings: true } : {}),
        };
      const { booking, count } = firstBooking(await ctx.client.cancelBooking(args.booking_uid, body));
      const lines = bookedSummary(booking, d, args.seat_uid ? 'Seat cancelled' : 'Cancelled');
      if (count > 1) lines.push(`- ${count} occurrences affected.`);
      return textResult(lines.join('\n'));
    }),
  );

  // ---------------------------------------------------------------------------
  // confirm_booking / decline_booking
  // ---------------------------------------------------------------------------
  server.registerTool(
    'confirm_booking',
    {
      title: 'Confirm a booking request',
      description:
        'Accept a booking that is waiting for your confirmation (list_bookings when="unconfirmed"). Bookings of paid ' +
        'event types that are still waiting for payment are refused unless allow_unpaid is true.',
      inputSchema: {
        booking_uid: bookingUidParam,
        allow_unpaid: z.boolean().optional().describe('Confirm a booking of a paid event type that is still waiting for payment (default false).'),
        time_zone: timeZoneParam,
      },
      annotations: WRITE_IDEMPOTENT,
    },
    async args => runTool(async () => {
      const d = await display(ctx, args.time_zone);
      if (!args.allow_unpaid) {
        const { booking: current } = firstBooking(await ctx.client.getBooking(args.booking_uid));
        const eventTypeId = current.eventType?.id ?? current.eventTypeId;
        const eventType = current.status === 'pending' && eventTypeId
          ? await ctx.client.getEventType(eventTypeId).catch(() => undefined)
          : undefined;
        const price = eventType && !requiresConfirmation(eventType) ? paymentInfo(eventType) : undefined;
        if (eventType && price) {
          throw new ToolInputError(
            `Booking \`${current.uid}\` is for the paid event type "${eventType.title}" (${formatMoney(price.amount, price.currency)}` +
            `${price.app ? ` via ${price.app}` : ''}) and is waiting for payment — Cal confirms it by itself once the attendee pays. ` +
            'Confirming it now marks it accepted while unpaid, and Cal skips the confirmation emails and the calendar event for ' +
            'unpaid bookings. Call again with allow_unpaid: true to confirm it anyway, or use decline_booking / cancel_booking to free the slot.',
          );
        }
      }
      const { booking } = firstBooking(await ctx.client.confirmBooking(args.booking_uid));
      return textResult(bookedSummary(booking, d, 'Confirmed').join('\n'));
    }),
  );

  server.registerTool(
    'decline_booking',
    {
      title: 'Decline a booking request',
      description: 'Reject a booking that is waiting for your confirmation; the attendee is notified. Needs confirm: true.',
      inputSchema: {
        booking_uid: bookingUidParam,
        reason: z.string().optional().describe('Reason sent to the attendee.'),
        confirm: confirmParam,
        time_zone: timeZoneParam,
      },
      annotations: DESTRUCTIVE,
    },
    async args => runTool(async () => {
      requireConfirmation(args.confirm, 'Declining a booking request');
      const d = await display(ctx, args.time_zone);
      const { booking } = firstBooking(await ctx.client.declineBooking(args.booking_uid, args.reason ? { reason: args.reason } : {}));
      return textResult(bookedSummary(booking, d, 'Declined').join('\n'));
    }),
  );

  // ---------------------------------------------------------------------------
  // mark_no_show
  // ---------------------------------------------------------------------------
  server.registerTool(
    'mark_no_show',
    {
      title: 'Mark no-show',
      description: 'Record that the host and/or attendees did not show up to a past booking (or undo it with absent: false).',
      inputSchema: {
        booking_uid: bookingUidParam,
        host_absent: z.boolean().optional().describe('true if you (the host) did not attend.'),
        attendees: z
          .array(z.object({ email: z.string().email(), absent: z.boolean().optional().describe('Default true.') }))
          .optional()
          .describe('Attendees to mark, by email.'),
        time_zone: timeZoneParam,
      },
      annotations: WRITE_IDEMPOTENT,
    },
    async args => runTool(async () => {
      if (args.host_absent === undefined && !args.attendees?.length) {
        throw new ToolInputError('Pass host_absent and/or attendees to mark.');
      }
      const d = await display(ctx, args.time_zone);
      const body: Record<string, unknown> = {
        ...(args.host_absent !== undefined ? { host: args.host_absent } : {}),
        ...(args.attendees?.length ? { attendees: args.attendees.map(attendee => ({ email: attendee.email, absent: attendee.absent ?? true })) } : {}),
      };
      const { booking } = firstBooking(await ctx.client.markAbsent(args.booking_uid, body));
      const lines = bookedSummary(booking, d, 'Attendance updated');
      const absent = (booking.attendees ?? []).filter(attendee => attendee.absent).map(attendee => attendee.email);
      lines.push(`- Absent: ${[...(booking.absentHost ? ['host'] : []), ...absent].join(', ') || 'nobody'}`);
      return textResult(lines.join('\n'));
    }),
  );

  // ---------------------------------------------------------------------------
  // add_booking_guests / remove_booking_attendee
  // ---------------------------------------------------------------------------
  server.registerTool(
    'add_booking_guests',
    {
      title: 'Add guests to a booking',
      description: 'Invite up to 10 more people to an existing booking; Cal emails them the invite and updates the calendar event.',
      inputSchema: {
        booking_uid: bookingUidParam,
        guests: z
          .array(z.object({
            email: z.string().trim().email(),
            name: z.string().optional(),
            time_zone: z.string().optional().describe('IANA time zone of the guest.'),
            phone: z.string().optional().describe('International format.'),
          }))
          .min(1)
          .max(10)
          .describe('Guests to add.'),
        time_zone: timeZoneParam,
      },
      annotations: WRITE,
    },
    async args => runTool(async () => {
      const d = await display(ctx, args.time_zone);
      const guests = args.guests.map(guest => ({
        email: guest.email,
        ...(guest.name ? { name: guest.name } : {}),
        ...(guest.time_zone ? { timeZone: guest.time_zone } : {}),
        ...(guest.phone ? { phoneNumber: guest.phone } : {}),
      }));
      const { booking } = firstBooking(await ctx.client.addGuests(args.booking_uid, guests));
      return textResult(bookedSummary(booking, d, 'Guests added').join('\n'));
    }),
  );

  server.registerTool(
    'remove_booking_attendee',
    {
      title: 'Remove an attendee',
      description:
        'Remove an attendee or guest from a booking (they receive a cancellation email). The primary attendee cannot be ' +
        'removed — cancel the booking instead. Needs confirm: true.',
      inputSchema: {
        booking_uid: bookingUidParam,
        attendee_id: z.number().int().positive().optional().describe('Attendee id (get_booking with include=["attendees"]).'),
        attendee_email: z.string().email().optional().describe('Or the attendee email.'),
        confirm: confirmParam,
      },
      annotations: DESTRUCTIVE,
    },
    async args => runTool(async () => {
      if (!args.attendee_id && !args.attendee_email) throw new ToolInputError('Pass attendee_id or attendee_email.');
      requireConfirmation(args.confirm, 'Removing an attendee');
      const attendees = await ctx.client.listAttendees(args.booking_uid);
      const target = args.attendee_id
        ? attendees.find(attendee => attendee.id === args.attendee_id)
        : attendees.find(attendee => (attendee.displayEmail || attendee.email).toLowerCase() === args.attendee_email!.toLowerCase());
      if (!target || target.id === undefined) {
        throw new ToolInputError(`No such attendee on this booking. Attendees: ${attendees.map(attendee => `${attendee.email} (id ${attendee.id})`).join(', ') || 'none'}.`);
      }
      if (attendees[0] && attendees[0].id === target.id) {
        throw new ToolInputError(`${target.email} is the primary attendee and cannot be removed — cancel the booking instead.`);
      }
      await ctx.client.removeAttendee(args.booking_uid, target.id);
      return textResult(`Removed ${target.name} <${target.email}> from booking \`${args.booking_uid}\`. Cal sent them a cancellation email.`);
    }),
  );

  // ---------------------------------------------------------------------------
  // update_booking_location
  // ---------------------------------------------------------------------------
  server.registerTool(
    'update_booking_location',
    {
      title: 'Change booking location',
      description:
        "Change where a booking happens — a video app, a specific meeting link, an address or a phone number. Cal " +
        'updates the calendar event.',
      inputSchema: {
        booking_uid: bookingUidParam,
        location: locationInputSchema.describe('The new location. link / address / phone need value here.'),
        time_zone: timeZoneParam,
      },
      annotations: WRITE_IDEMPOTENT,
    },
    async args => runTool(async () => {
      const d = await display(ctx, args.time_zone);
      const { booking } = firstBooking(await ctx.client.updateLocation(args.booking_uid, toUpdateLocation(args.location)));
      return textResult(bookedSummary(booking, d, 'Location updated').join('\n'));
    }),
  );
}
