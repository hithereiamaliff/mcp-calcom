/**
 * Availability & calendar tools (all read-only):
 *   get_available_slots, list_calendars, get_busy_times, list_calendar_events
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatSlots, markdownTable, slotStart } from '../calcom/format.js';
import {
  addDays,
  dateIn,
  daysBetween,
  endOfDay,
  formatClock,
  formatDateLabel,
  formatRangeLabel,
  localIso,
  parseDate,
  parseDateTime,
  startOfDay,
  todayIn,
} from '../calcom/time.js';
import type { BusyTime, UnifiedCalendarEvent } from '../calcom/types.js';
import { ToolInputError } from '../errors.js';
import { resolveEventType } from './bookings.js';
import {
  type Display,
  READ_ONLY,
  type ToolContext,
  display,
  formatParam,
  jsonResult,
  runTool,
  textResult,
  timeZoneParam,
} from './shared.js';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 31;

interface DayRange {
  fromDate: string;
  toDate: string;
  from: Date;
  to: Date;
}

/** start/end as dates (or datetimes) in the display zone; default today + defaultDays */
function dayRange(start: string | undefined, end: string | undefined, days: number | undefined, d: Display, defaultDays = 7): DayRange {
  const startValue = start?.trim();
  const from = !startValue
    ? startOfDay(todayIn(d.timeZone), d.timeZone)
    : DATE_ONLY.test(startValue) ? startOfDay(startValue, d.timeZone) : parseDateTime(startValue, d.timeZone, 'start');
  const fromDate = dateIn(from, d.timeZone);

  const endValue = end?.trim();
  let to: Date;
  if (!endValue) {
    to = endOfDay(addDays(fromDate, (days ?? defaultDays) - 1), d.timeZone);
  } else if (DATE_ONLY.test(endValue)) {
    parseDate(endValue, 'end');
    to = endOfDay(endValue, d.timeZone);
  } else {
    to = parseDateTime(endValue, d.timeZone, 'end');
  }
  const toDate = dateIn(to, d.timeZone);

  if (to.getTime() <= from.getTime()) throw new ToolInputError('end must be after start.');
  if (daysBetween(fromDate, toDate) + 1 > MAX_RANGE_DAYS) {
    throw new ToolInputError(`Ranges are limited to ${MAX_RANGE_DAYS} days — split the request.`);
  }
  return { fromDate, toDate, from, to };
}

function datesBetween(fromDate: string, toDate: string): string[] {
  const dates: string[] = [];
  for (let date = fromDate; daysBetween(date, toDate) >= 0; date = addDays(date, 1)) dates.push(date);
  return dates;
}

function eventTime(value: UnifiedCalendarEvent['start']): Date {
  return new Date(typeof value === 'string' ? value : value.time);
}

export function registerAvailabilityTools(server: McpServer, ctx: ToolContext): void {
  // ---------------------------------------------------------------------------
  // get_available_slots
  // ---------------------------------------------------------------------------
  server.registerTool(
    'get_available_slots',
    {
      title: 'Available slots',
      description:
        'Open booking times for an event type, as a compact list per day in your time zone (or time_zone). Default ' +
        'range: the next 7 days. Use it before create_booking or reschedule_booking, or to answer "when am I free?".',
      inputSchema: {
        event_type_id: z.number().int().positive().optional().describe('Event type id (list_event_types). Or use event_type_slug.'),
        event_type_slug: z.string().optional().describe('Event type slug, e.g. "30min".'),
        username: z.string().optional().describe('Owner of event_type_slug when it is not you.'),
        start: z.string().optional().describe('First day "YYYY-MM-DD" (or a datetime) in time_zone. Default: today.'),
        end: z.string().optional().describe('Last day "YYYY-MM-DD" (inclusive) or a datetime. Default: start + days - 1.'),
        days: z.number().int().min(1).max(MAX_RANGE_DAYS).optional().describe('Number of days when end is not given (default 7).'),
        duration: z.number().int().positive().optional().describe('For event types with several lengths: the length in minutes.'),
        booking_uid_to_reschedule: z.string().optional().describe('When rescheduling: the booking uid, so its current time counts as free.'),
        time_zone: timeZoneParam,
        format: formatParam,
      },
      annotations: READ_ONLY,
    },
    async args => runTool(async () => {
      const d = await display(ctx, args.time_zone);
      const target = await resolveEventType(ctx, args, d);
      const range = dayRange(args.start, args.end, args.days, d);

      const slots = await ctx.client.getSlots({
        ...(target.id ? { eventTypeId: target.id } : { eventTypeSlug: target.slug, username: target.username }),
        start: range.from.toISOString(),
        end: range.to.toISOString(),
        timeZone: d.timeZone,
        duration: args.duration,
        bookingUidToReschedule: args.booking_uid_to_reschedule,
      });
      const dates = [...new Set([...datesBetween(range.fromDate, range.toDate), ...Object.keys(slots)])].sort();
      const title = target.eventType
        ? `${target.eventType.title} (id ${target.eventType.id}, ${args.duration ?? target.eventType.lengthInMinutes} min)`
        : `${target.slug} by ${target.username}`;

      if (args.format === 'json') {
        return jsonResult({
          event_type: target.eventType ? { id: target.eventType.id, slug: target.eventType.slug, title: target.eventType.title } : { slug: target.slug, username: target.username },
          time_zone: d.timeZone,
          from: range.fromDate,
          to: range.toDate,
          slots: Object.fromEntries(dates.map(date => [date, (slots[date] ?? []).map(slot => {
            const start = new Date(slotStart(slot));
            return { start: localIso(start, d.timeZone), start_utc: start.toISOString() };
          })])),
        });
      }

      const summary = formatSlots(slots, dates, d.timeZone, d.timeFormat);
      const lines = [
        `## Available slots · ${title} · ${formatRangeLabel(range.fromDate, range.toDate)} · ${d.timeZone}`,
        ...summary.lines,
        '',
        summary.first
          ? `First available: ${formatDateLabel(dateIn(summary.first, d.timeZone))} ${formatClock(summary.first, d.timeZone, d.timeFormat)} ` +
            `(${summary.first.toISOString()}) · ${summary.total} open slot(s).`
          : 'No open slots in this range — try a later start date or a longer range.',
      ];
      if (summary.first && target.id) {
        lines.push(`_To book: create_booking with event_type_id ${target.id} and start "YYYY-MM-DD HH:mm" (in ${d.timeZone})._`);
      }
      return textResult(lines.join('\n'));
    }),
  );

  // ---------------------------------------------------------------------------
  // list_calendars
  // ---------------------------------------------------------------------------
  server.registerTool(
    'list_calendars',
    {
      title: 'Connected calendars',
      description:
        'Calendars connected to Cal (Google, Office 365, Apple, CalDAV …): which ones are checked for conflicts and ' +
        'where new bookings are written. Shows the credential ids and external ids used by get_busy_times.',
      inputSchema: { format: formatParam },
      annotations: READ_ONLY,
    },
    async args => runTool(async () => {
      const data = await ctx.client.listCalendars();
      const connected = data.connectedCalendars ?? [];
      if (args.format === 'json') {
        return jsonResult({
          connected: connected.map(entry => ({
            integration: entry.integration.title || entry.integration.name || entry.integration.slug,
            credential_id: entry.credentialId,
            calendars: (entry.calendars ?? []).map(calendar => ({
              name: calendar.name,
              external_id: calendar.externalId,
              primary: Boolean(calendar.primary),
              checked_for_conflicts: calendar.isSelected,
              read_only: Boolean(calendar.readOnly),
            })),
          })),
          destination: data.destinationCalendar ?? null,
        });
      }

      if (!connected.length) {
        return textResult('No calendars are connected. Connect one in Cal → Settings → Calendars (Apps → Calendar).');
      }
      const lines = ['## Connected calendars'];
      for (const entry of connected) {
        lines.push(
          '',
          `### ${entry.integration.title || entry.integration.name || entry.integration.slug} (credential id ${entry.credentialId})`,
          markdownTable(
            ['calendar', 'external_id', 'conflict_check', 'primary', 'read_only'],
            (entry.calendars ?? []).map(calendar => ({
              calendar: calendar.name ?? calendar.externalId,
              external_id: calendar.externalId,
              conflict_check: calendar.isSelected ? 'yes' : '',
              primary: calendar.primary ? 'yes' : '',
              read_only: calendar.readOnly ? 'yes' : '',
            })),
            '_No calendars listed for this account._',
          ),
        );
      }
      const destination = data.destinationCalendar;
      lines.push('', destination
        ? `New bookings are written to: ${destination.name || destination.externalId}${destination.integrationTitle ? ` (${destination.integrationTitle})` : ''}.`
        : 'No destination calendar set — Cal uses the default.');
      return textResult(lines.join('\n'));
    }),
  );

  // ---------------------------------------------------------------------------
  // get_busy_times
  // ---------------------------------------------------------------------------
  server.registerTool(
    'get_busy_times',
    {
      title: 'Busy times',
      description:
        'Busy blocks from your connected calendars for a date range (default: the next 7 days) — every calendar ' +
        'that is checked for conflicts unless you pass specific calendars. Works for Google, Office 365, Apple and CalDAV.',
      inputSchema: {
        start: z.string().optional().describe('First day "YYYY-MM-DD". Default: today.'),
        end: z.string().optional().describe('Last day (inclusive). Default: start + 6 days.'),
        calendars: z
          .array(z.object({ credential_id: z.number().int().positive(), external_id: z.string().min(1) }))
          .optional()
          .describe('Specific calendars (ids from list_calendars). Default: all calendars checked for conflicts.'),
        time_zone: timeZoneParam,
        format: formatParam,
      },
      annotations: READ_ONLY,
    },
    async args => runTool(async () => {
      const d = await display(ctx, args.time_zone);
      const range = dayRange(args.start, args.end, undefined, d);

      let calendars = args.calendars?.map(calendar => ({ credentialId: calendar.credential_id, externalId: calendar.external_id }));
      if (!calendars?.length) {
        const data = await ctx.client.listCalendars();
        calendars = (data.connectedCalendars ?? []).flatMap(entry =>
          (entry.calendars ?? []).filter(calendar => calendar.isSelected).map(calendar => ({ credentialId: entry.credentialId, externalId: calendar.externalId })),
        );
      }
      if (!calendars.length) {
        return textResult('No calendars are checked for conflicts, so there are no busy times to read. See list_calendars.');
      }

      const busy = await ctx.client.getBusyTimes({
        dateFrom: range.from.toISOString(),
        dateTo: range.to.toISOString(),
        timeZone: d.timeZone,
        calendars,
      });
      const unique = [...new Map(busy.map(block => [`${block.start}|${block.end}`, block])).values()]
        .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

      if (args.format === 'json') {
        return jsonResult({
          time_zone: d.timeZone,
          from: range.fromDate,
          to: range.toDate,
          calendars: calendars.length,
          busy: unique.map(block => ({
            start: localIso(new Date(block.start), d.timeZone),
            end: localIso(new Date(block.end), d.timeZone),
            source: block.source ?? null,
          })),
        });
      }

      const byDay = new Map<string, BusyTime[]>();
      for (const block of unique) {
        const day = dateIn(new Date(block.start), d.timeZone);
        byDay.set(day, [...(byDay.get(day) ?? []), block]);
      }
      const lines = [`## Busy times · ${formatRangeLabel(range.fromDate, range.toDate)} · ${d.timeZone}`, `_${calendars.length} calendar(s) checked._`];
      for (const day of datesBetween(range.fromDate, range.toDate)) {
        const blocks = byDay.get(day) ?? [];
        const text = blocks.map(block => {
          const start = new Date(block.start);
          const end = new Date(block.end);
          const endText = dateIn(end, d.timeZone) === day ? formatClock(end, d.timeZone, d.timeFormat) : `${formatDateLabel(dateIn(end, d.timeZone))} ${formatClock(end, d.timeZone, d.timeFormat)}`;
          return `${formatClock(start, d.timeZone, d.timeFormat)}–${endText}`;
        });
        lines.push(`- ${formatDateLabel(day)}: ${text.length ? text.join(', ') : 'free'}`);
      }
      return textResult(lines.join('\n'));
    }),
  );

  // ---------------------------------------------------------------------------
  // list_calendar_events
  // ---------------------------------------------------------------------------
  server.registerTool(
    'list_calendar_events',
    {
      title: 'Google Calendar events',
      description:
        'Events on your connected Google Calendar for a date range (default: the next 7 days), including events not ' +
        'booked through Cal. Google Calendar only (Cal API limitation).',
      inputSchema: {
        start: z.string().optional().describe('First day "YYYY-MM-DD". Default: today.'),
        end: z.string().optional().describe('Last day (inclusive). Default: start + 6 days.'),
        calendar_id: z.string().optional().describe('External calendar id from list_calendars. Default: your primary calendar.'),
        time_zone: timeZoneParam,
        format: formatParam,
      },
      annotations: READ_ONLY,
    },
    async args => runTool(async () => {
      const d = await display(ctx, args.time_zone);
      const range = dayRange(args.start, args.end, undefined, d);
      const events = (await ctx.client.listCalendarEvents('google', {
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        timeZone: d.timeZone,
        calendarId: args.calendar_id,
      })).sort((a, b) => eventTime(a.start).getTime() - eventTime(b.start).getTime());

      if (args.format === 'json') {
        return jsonResult({
          time_zone: d.timeZone,
          from: range.fromDate,
          to: range.toDate,
          events: events.map(event => ({
            id: event.id,
            title: event.title ?? null,
            start: localIso(eventTime(event.start), d.timeZone),
            end: localIso(eventTime(event.end), d.timeZone),
            status: event.status ?? null,
            attendees: (event.attendees ?? []).map(attendee => ({ email: attendee.email, name: attendee.name, response: attendee.responseStatus })),
            video: event.locations?.find(location => location.type === 'video')?.url ?? null,
          })),
        });
      }

      const lines = [`## Google Calendar · ${formatRangeLabel(range.fromDate, range.toDate)} · ${d.timeZone}`];
      if (!events.length) lines.push('_No events._');
      let currentDay = '';
      for (const event of events) {
        const start = eventTime(event.start);
        const end = eventTime(event.end);
        const day = dateIn(start, d.timeZone);
        if (day !== currentDay) {
          lines.push(`### ${formatDateLabel(day)}`);
          currentDay = day;
        }
        const others = (event.attendees ?? []).filter(attendee => !attendee.self).length;
        const video = event.locations?.find(location => location.type === 'video')?.url;
        lines.push(`- ${formatClock(start, d.timeZone, d.timeFormat)}–${formatClock(end, d.timeZone, d.timeFormat)} · ${event.title || '(no title)'}` +
          `${event.status && event.status !== 'accepted' ? ` · ${event.status}` : ''}${others ? ` · ${others} other attendee(s)` : ''}${video ? ` · ${video}` : ''}`);
      }
      return textResult(lines.join('\n'));
    }),
  );
}
