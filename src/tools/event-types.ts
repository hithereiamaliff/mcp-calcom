/**
 * Event type tools.
 *   always:           list_event_types, get_event_type, list_private_links
 *   access bookings:  create_private_link, delete_private_link
 *   access full:      create_event_type, update_event_type, delete_event_type
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatMoney, markdownTable, paymentInfo } from '../calcom/format.js';
import { describeEventTypeLocation, locationInputSchema, toEventTypeLocation } from '../calcom/locations.js';
import { endOfDay, formatDuration, formatInstant, parseDateTime } from '../calcom/time.js';
import type { EventType, PrivateLink } from '../calcom/types.js';
import { ToolInputError } from '../errors.js';
import {
  DESTRUCTIVE,
  READ_ONLY,
  type ToolContext,
  WRITE,
  WRITE_IDEMPOTENT,
  allows,
  confirmParam,
  display,
  eventTypeIdParam,
  formatParam,
  jsonResult,
  requireConfirmation,
  runTool,
  textResult,
  timeZoneParam,
} from './shared.js';

// =============================================================================
// Describing event types
// =============================================================================

function requiresConfirmation(eventType: EventType): string | undefined {
  const policy = eventType.confirmationPolicy as { type?: string; disabled?: boolean; noticeThreshold?: { count?: number; unit?: string } } | null | undefined;
  if (!policy || policy.disabled || !policy.type) return undefined;
  if (policy.type === 'time' && policy.noticeThreshold) {
    return `when booked less than ${policy.noticeThreshold.count} ${policy.noticeThreshold.unit} ahead`;
  }
  return 'always';
}

function lengthText(eventType: EventType): string {
  const options = eventType.lengthInMinutesOptions?.length ? ` (options ${eventType.lengthInMinutesOptions.join(' / ')} min)` : '';
  return `${formatDuration(eventType.lengthInMinutes)}${options}`;
}

function priceText(eventType: EventType): string {
  const price = paymentInfo(eventType);
  return price ? `${formatMoney(price.amount, price.currency)}${price.app ? ` (${price.app})` : ''}` : 'free';
}

function bookingWindowText(window: unknown): string | undefined {
  const entry = (Array.isArray(window) ? window[0] : window) as { type?: string; value?: unknown; rolling?: boolean; disabled?: boolean } | undefined;
  if (!entry || entry.disabled || !entry.type) return undefined;
  if (entry.type === 'range' && Array.isArray(entry.value)) return `only between ${entry.value[0]} and ${entry.value[1]}`;
  const unit = entry.type === 'businessDays' ? 'business days' : 'calendar days';
  return `${entry.value} ${unit} into the future${entry.rolling ? ' (rolling)' : ''}`;
}

function limitsText(limits: Record<string, unknown> | null | undefined, duration = false): string | undefined {
  if (!limits || limits.disabled) return undefined;
  const parts = (['day', 'week', 'month', 'year'] as const)
    .filter(period => typeof limits[period] === 'number')
    .map(period => `${duration ? formatDuration(limits[period] as number) : limits[period]} per ${period}`);
  return parts.length ? parts.join(', ') : undefined;
}

function eventTypeDetails(eventType: EventType): string[] {
  const lines = [
    `## ${eventType.title} (id ${eventType.id})`,
    ...(eventType.bookingUrl ? [`- Booking page: ${eventType.bookingUrl}`] : []),
    `- Slug: ${eventType.slug}`,
    `- Length: ${lengthText(eventType)}`,
    `- Visibility: ${eventType.hidden ? 'hidden (not listed on your profile)' : 'listed'}`,
    `- Price: ${priceText(eventType)}`,
    `- Locations: ${(eventType.locations ?? []).map(describeEventTypeLocation).join('; ') || 'Cal Video (default)'}`,
  ];
  if (eventType.description) lines.push(`- Description: ${eventType.description.replace(/\s+/g, ' ').slice(0, 500)}`);

  const timing = [
    eventType.minimumBookingNotice ? `minimum notice ${formatDuration(eventType.minimumBookingNotice)}` : '',
    eventType.beforeEventBuffer ? `${formatDuration(eventType.beforeEventBuffer)} buffer before` : '',
    eventType.afterEventBuffer ? `${formatDuration(eventType.afterEventBuffer)} buffer after` : '',
    eventType.slotInterval ? `slots every ${formatDuration(eventType.slotInterval)}` : '',
    eventType.offsetStart ? `start times offset by ${eventType.offsetStart} min` : '',
    eventType.onlyShowFirstAvailableSlot ? 'only the first slot of each day' : '',
  ].filter(Boolean);
  if (timing.length) lines.push(`- Timing: ${timing.join(', ')}`);

  lines.push(`- Availability: ${eventType.scheduleId ? `schedule id ${eventType.scheduleId}` : 'your default schedule'}`);
  const window = bookingWindowText(eventType.bookingWindow);
  if (window) lines.push(`- Booking window: ${window}`);
  const countLimits = limitsText(eventType.bookingLimitsCount);
  if (countLimits) lines.push(`- Booking limits: ${countLimits}`);
  const durationLimits = limitsText(eventType.bookingLimitsDuration, true);
  if (durationLimits) lines.push(`- Booked-time limits: ${durationLimits}`);
  if (eventType.bookerActiveBookingsLimit?.maximumActiveBookings) {
    lines.push(`- Per-booker limit: ${eventType.bookerActiveBookingsLimit.maximumActiveBookings} active booking(s)`);
  }
  const confirmation = requiresConfirmation(eventType);
  lines.push(`- Confirmation: ${confirmation ? `required ${confirmation}` : 'not required'}`);
  if (eventType.seats?.seatsPerTimeSlot) lines.push(`- Seats: ${eventType.seats.seatsPerTimeSlot} per slot`);
  if (eventType.recurrence?.frequency) {
    lines.push(`- Recurring: every ${eventType.recurrence.interval} ${eventType.recurrence.frequency.replace(/ly$/, '')}(s), up to ${eventType.recurrence.occurrences} times`);
  }
  if (eventType.disableGuests) lines.push('- Guests: bookers cannot add guests');
  if (eventType.disableCancelling?.disabled) lines.push('- Cancelling: disabled for bookers');
  if (eventType.disableRescheduling?.disabled) lines.push('- Rescheduling: disabled for bookers');
  else if (eventType.disableRescheduling?.minutesBefore) lines.push(`- Rescheduling: not allowed less than ${formatDuration(eventType.disableRescheduling.minutesBefore)} before`);
  if (eventType.requiresBookerEmailVerification) lines.push('- Bookers must verify their email');
  if (eventType.successRedirectUrl) lines.push(`- Redirect after booking: ${eventType.successRedirectUrl}`);

  const fields = (eventType.bookingFields ?? []).filter(field => !field.hidden);
  if (fields.length) {
    lines.push('', '### Booking form', markdownTable(['slug', 'type', 'label', 'required', 'options'], fields.map(field => ({
      slug: field.slug ?? field.type,
      type: field.type,
      label: field.label,
      required: field.required === true ? 'yes' : '',
      options: field.options?.join(', '),
    }))));
    lines.push('_Custom answers go in create_booking booking_fields, keyed by slug._');
  }
  return lines;
}

function linkRow(link: PrivateLink, timeZone: string) {
  return {
    link_id: link.linkId,
    url: link.bookingUrl,
    limit: link.expiresAt
      ? `until ${formatInstant(new Date(link.expiresAt), timeZone)}`
      : `${link.usageCount ?? 0} of ${link.maxUsageCount ?? 1} use(s)`,
    status: link.isExpired ? 'expired' : 'active',
  };
}

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'event';
}

// =============================================================================
// Friendly event type input
// =============================================================================

const eventTypeFields = {
  title: z.string().trim().min(1).describe('Name shown to bookers, e.g. "Strategy session".'),
  slug: z.string().trim().min(1).optional().describe('URL slug, e.g. "strategy-session". Default (create): derived from the title.'),
  length_in_minutes: z.number().int().positive().describe('Default length in minutes.'),
  length_options: z.array(z.number().int().positive()).optional().describe('Let bookers choose a length, e.g. [30, 60]. Must include length_in_minutes.'),
  description: z.string().optional().describe('Description shown on the booking page.'),
  locations: z.array(locationInputSchema).optional().describe('Where the meeting happens (replaces existing locations). Default for new event types: Cal Video.'),
  minimum_notice_minutes: z.number().int().min(0).optional().describe('Minimum minutes between booking and start.'),
  buffer_before_minutes: z.number().int().min(0).optional().describe('Blocked minutes before each booking.'),
  buffer_after_minutes: z.number().int().min(0).optional().describe('Blocked minutes after each booking.'),
  slot_interval_minutes: z.number().int().positive().optional().describe('Show a start time every N minutes (default: the length).'),
  schedule_id: z.number().int().positive().optional().describe('Availability schedule to use (list_schedules). Default: your default schedule.'),
  hidden: z.boolean().optional().describe('Hide from your public profile page (the link still works).'),
  requires_confirmation: z.boolean().optional().describe('Bookings must be confirmed by you before they are final.'),
  seats_per_slot: z.number().int().min(0).optional().describe('Seats per time slot for group sessions; 0 turns seats off.'),
  booking_window_days: z.number().int().min(0).optional().describe('How many calendar days ahead people can book (rolling); 0 = no limit.'),
  max_bookings_per_day: z.number().int().min(0).optional().describe('Maximum bookings of this type per day; 0 = no limit.'),
  disable_guests: z.boolean().optional().describe('Stop bookers from adding guests.'),
  success_redirect_url: z.string().url().optional().describe('Redirect bookers to this URL after booking.'),
  advanced: z
    .record(z.unknown())
    .optional()
    .describe('Any other Cal API v2 event type fields (2024-06-14 schema) passed through as-is, e.g. {"bookingFields": [...], "recurrence": {"interval": 1, "occurrences": 4, "frequency": "weekly"}}.'),
};

type EventTypeArgs = Partial<{ [K in keyof typeof eventTypeFields]: z.infer<(typeof eventTypeFields)[K]> }>;

function eventTypeBody(args: EventTypeArgs, isCreate: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (args.title !== undefined) body.title = args.title;
  if (args.slug !== undefined) body.slug = slugify(args.slug);
  else if (isCreate && args.title) body.slug = slugify(args.title);
  if (args.length_in_minutes !== undefined) body.lengthInMinutes = args.length_in_minutes;
  if (args.length_options !== undefined) {
    if (args.length_in_minutes !== undefined && !args.length_options.includes(args.length_in_minutes)) {
      throw new ToolInputError('length_options must include length_in_minutes.');
    }
    body.lengthInMinutesOptions = args.length_options;
  }
  if (args.description !== undefined) body.description = args.description;
  if (args.locations !== undefined) body.locations = args.locations.map(toEventTypeLocation);
  if (args.minimum_notice_minutes !== undefined) body.minimumBookingNotice = args.minimum_notice_minutes;
  if (args.buffer_before_minutes !== undefined) body.beforeEventBuffer = args.buffer_before_minutes;
  if (args.buffer_after_minutes !== undefined) body.afterEventBuffer = args.buffer_after_minutes;
  if (args.slot_interval_minutes !== undefined) body.slotInterval = args.slot_interval_minutes;
  if (args.schedule_id !== undefined) body.scheduleId = args.schedule_id;
  if (args.hidden !== undefined) body.hidden = args.hidden;
  if (args.requires_confirmation !== undefined) {
    body.confirmationPolicy = args.requires_confirmation
      ? { type: 'always', blockUnconfirmedBookingsInBooker: true }
      : { disabled: true };
  }
  if (args.seats_per_slot !== undefined) {
    body.seats = args.seats_per_slot > 0
      ? { seatsPerTimeSlot: args.seats_per_slot, showAttendeeInfo: false, showAvailabilityCount: true }
      : { disabled: true };
  }
  if (args.booking_window_days !== undefined) {
    body.bookingWindow = args.booking_window_days > 0
      ? { type: 'calendarDays', value: args.booking_window_days, rolling: true }
      : { disabled: true };
  }
  if (args.max_bookings_per_day !== undefined) {
    body.bookingLimitsCount = args.max_bookings_per_day > 0 ? { day: args.max_bookings_per_day } : { disabled: true };
  }
  if (args.disable_guests !== undefined) body.disableGuests = args.disable_guests;
  if (args.success_redirect_url !== undefined) body.successRedirectUrl = args.success_redirect_url;
  if (args.advanced) Object.assign(body, args.advanced);
  return body;
}

// =============================================================================
// Registration
// =============================================================================

export function registerEventTypeTools(server: McpServer, ctx: ToolContext): void {
  // ---------------------------------------------------------------------------
  // list_event_types
  // ---------------------------------------------------------------------------
  server.registerTool(
    'list_event_types',
    {
      title: 'List event types',
      description: 'Your event types (meeting types people can book) with id, length, price, visibility, confirmation rule, locations and booking page URL.',
      inputSchema: { format: formatParam },
      annotations: READ_ONLY,
    },
    async args => runTool(async () => {
      const eventTypes = await ctx.client.listEventTypes();
      if (args.format === 'json') {
        return jsonResult(eventTypes.map(eventType => ({
          id: eventType.id,
          title: eventType.title,
          slug: eventType.slug,
          length_in_minutes: eventType.lengthInMinutes,
          length_options: eventType.lengthInMinutesOptions ?? null,
          hidden: eventType.hidden,
          price: paymentInfo(eventType) ?? null,
          requires_confirmation: Boolean(requiresConfirmation(eventType)),
          seats: eventType.seats?.seatsPerTimeSlot ?? null,
          locations: (eventType.locations ?? []).map(describeEventTypeLocation),
          booking_url: eventType.bookingUrl ?? null,
        })));
      }
      if (!eventTypes.length) return textResult('You have no event types yet.');
      return textResult([
        `## Event types (${eventTypes.length})`,
        markdownTable(['id', 'title', 'length', 'price', 'visibility', 'confirmation', 'locations', 'booking_url'], eventTypes.map(eventType => ({
          id: eventType.id,
          title: eventType.title,
          length: lengthText(eventType),
          price: priceText(eventType),
          visibility: eventType.hidden ? 'hidden' : 'listed',
          confirmation: requiresConfirmation(eventType) ? 'required' : '',
          locations: (eventType.locations ?? []).map(describeEventTypeLocation).join('; ') || 'Cal Video',
          booking_url: eventType.bookingUrl,
        }))),
      ].join('\n'));
    }),
  );

  // ---------------------------------------------------------------------------
  // get_event_type
  // ---------------------------------------------------------------------------
  server.registerTool(
    'get_event_type',
    {
      title: 'Get an event type',
      description: 'All settings of one event type in plain language: length, locations, notice, buffers, booking window, limits, confirmation, seats, recurrence and the booking-form questions.',
      inputSchema: { event_type_id: eventTypeIdParam, format: formatParam },
      annotations: READ_ONLY,
    },
    async args => runTool(async () => {
      const eventType = await ctx.client.getEventType(args.event_type_id);
      if (args.format === 'json') return jsonResult(eventType);
      return textResult(eventTypeDetails(eventType).join('\n'));
    }),
  );

  // ---------------------------------------------------------------------------
  // list_private_links
  // ---------------------------------------------------------------------------
  server.registerTool(
    'list_private_links',
    {
      title: 'List private links',
      description: 'Private (single-use or expiring) booking links of an event type, with usage and expiry.',
      inputSchema: { event_type_id: eventTypeIdParam, time_zone: timeZoneParam, format: formatParam },
      annotations: READ_ONLY,
    },
    async args => runTool(async () => {
      const links = await ctx.client.listPrivateLinks(args.event_type_id);
      if (args.format === 'json') return jsonResult(links);
      const d = await display(ctx, args.time_zone);
      return textResult([
        `## Private links · event type ${args.event_type_id}`,
        markdownTable(['link_id', 'url', 'limit', 'status'], links.map(link => linkRow(link, d.timeZone)), '_No private links._'),
      ].join('\n'));
    }),
  );

  if (allows(ctx, 'bookings')) {
    // -------------------------------------------------------------------------
    // create_private_link / delete_private_link
    // -------------------------------------------------------------------------
    server.registerTool(
      'create_private_link',
      {
        title: 'Create a private link',
        description:
          'Create a private booking link for an event type — single-use by default, or valid for a number of uses or ' +
          'until a date. Useful for sending one client a link to a hidden event type.',
        inputSchema: {
          event_type_id: eventTypeIdParam,
          max_usage_count: z.number().int().positive().optional().describe('Number of bookings the link allows (default 1).'),
          expires_at: z.string().optional().describe('Valid until this date "YYYY-MM-DD" (end of day) or datetime, in time_zone.'),
          time_zone: timeZoneParam,
        },
        annotations: WRITE,
      },
      async args => runTool(async () => {
        const d = await display(ctx, args.time_zone);
        const body: Record<string, unknown> = {};
        if (args.expires_at) {
          const value = args.expires_at.trim();
          body.expiresAt = (/^\d{4}-\d{2}-\d{2}$/.test(value) ? endOfDay(value, d.timeZone) : parseDateTime(value, d.timeZone, 'expires_at')).toISOString();
        }
        if (args.max_usage_count) body.maxUsageCount = args.max_usage_count;
        const link = await ctx.client.createPrivateLink(args.event_type_id, body);
        const row = linkRow(link, d.timeZone);
        return textResult([
          '## Private link created',
          `- URL: ${link.bookingUrl}`,
          `- Valid: ${row.limit}`,
          `- Link id: ${link.linkId}`,
        ].join('\n'));
      }),
    );

    server.registerTool(
      'delete_private_link',
      {
        title: 'Delete a private link',
        description: 'Revoke a private booking link so it can no longer be used. Needs confirm: true.',
        inputSchema: {
          event_type_id: eventTypeIdParam,
          link_id: z.string().trim().min(1).describe('Link id from list_private_links.'),
          confirm: confirmParam,
        },
        annotations: DESTRUCTIVE,
      },
      async args => runTool(async () => {
        requireConfirmation(args.confirm, 'Deleting a private link');
        await ctx.client.deletePrivateLink(args.event_type_id, args.link_id);
        return textResult(`Private link ${args.link_id} of event type ${args.event_type_id} deleted.`);
      }),
    );
  }

  if (!allows(ctx, 'full')) return;

  // ---------------------------------------------------------------------------
  // create_event_type / update_event_type / delete_event_type
  // ---------------------------------------------------------------------------
  server.registerTool(
    'create_event_type',
    {
      title: 'Create an event type',
      description:
        'Create a new bookable event type. Common settings have friendly parameters; anything else from the Cal API ' +
        '(booking questions, recurrence, colours …) can go in advanced.',
      inputSchema: eventTypeFields,
      annotations: WRITE,
    },
    async args => runTool(async () => {
      const eventType = await ctx.client.createEventType(eventTypeBody(args, true));
      return textResult(['Created.', '', ...eventTypeDetails(eventType)].join('\n'));
    }),
  );

  server.registerTool(
    'update_event_type',
    {
      title: 'Update an event type',
      description: 'Change settings of an event type. Only the fields you pass change; locations and length_options replace the existing lists.',
      inputSchema: {
        event_type_id: eventTypeIdParam,
        ...Object.fromEntries(Object.entries(eventTypeFields).map(([key, schema]) => [key, schema.optional()])) as {
          [K in keyof typeof eventTypeFields]: z.ZodOptional<(typeof eventTypeFields)[K]>
        },
      },
      annotations: WRITE_IDEMPOTENT,
    },
    async args => runTool(async () => {
      const { event_type_id: id, ...fields } = args;
      const body = eventTypeBody(fields, false);
      if (!Object.keys(body).length) throw new ToolInputError('Nothing to update — pass at least one setting.');
      const eventType = await ctx.client.updateEventType(id, body);
      return textResult(['Updated.', '', ...eventTypeDetails(eventType)].join('\n'));
    }),
  );

  server.registerTool(
    'delete_event_type',
    {
      title: 'Delete an event type',
      description: 'Delete an event type. Existing bookings stay, but its booking link stops working. Needs confirm: true.',
      inputSchema: { event_type_id: eventTypeIdParam, confirm: confirmParam },
      annotations: DESTRUCTIVE,
    },
    async args => runTool(async () => {
      requireConfirmation(args.confirm, 'Deleting an event type');
      const eventType = await ctx.client.getEventType(args.event_type_id);
      await ctx.client.deleteEventType(args.event_type_id);
      return textResult(`Deleted event type "${eventType.title}" (id ${eventType.id}). Existing bookings are kept.`);
    }),
  );
}
