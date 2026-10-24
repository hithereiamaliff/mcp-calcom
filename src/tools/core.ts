/**
 * Core tools: connectivity check, connection diagnostics and the account profile.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describeEventTypeLocation } from '../calcom/locations.js';
import { CalApiError } from '../calcom/http.js';
import { getCachedProfile, getProfile, rememberProfile } from '../calcom/profile.js';
import { SERVER_NAME, SERVER_VERSION } from '../version.js';
import {
  READ_ONLY,
  type ToolContext,
  allows,
  describeError,
  formatParam,
  jsonResult,
  runTool,
  textResult,
} from './shared.js';

function deployment(ctx: ToolContext): string {
  return ctx.connection.isCloud ? 'Cal.com Cloud' : 'self-hosted (Cal.diy / Cal.com)';
}

function toolGroups(ctx: ToolContext): Record<string, string> {
  return {
    read: 'enabled — bookings, availability, calendars, event types, schedules, webhooks, conferencing',
    booking_actions: allows(ctx, 'bookings')
      ? 'enabled — create / reschedule / cancel / confirm / decline bookings, no-shows, guests, locations, private links'
      : 'disabled (access level "read")',
    configuration: allows(ctx, 'full')
      ? 'enabled — event types, schedules, profile, default conferencing app, webhooks'
      : `disabled (access level "${ctx.connection.access}")`,
  };
}

export function registerCoreTools(server: McpServer, ctx: ToolContext): void {
  // ---------------------------------------------------------------------------
  // hello
  // ---------------------------------------------------------------------------
  server.registerTool(
    'hello',
    {
      title: 'Hello',
      description: 'Check that the Cal.com MCP server is reachable and see how this connection is configured (no API call).',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const profile = getCachedProfile(ctx.client);
      return jsonResult({
        message: `Hello from ${SERVER_NAME}!`,
        version: SERVER_VERSION,
        timestamp: new Date().toISOString(),
        transport: ctx.transport,
        auth_mode: ctx.authMode,
        api_url: ctx.connection.baseUrl,
        deployment: deployment(ctx),
        access_level: ctx.connection.access,
        tool_groups: toolGroups(ctx),
        ...(profile ? { account: { username: profile.username, time_zone: profile.timeZone } } : {}),
        warnings: ctx.connection.warnings,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // get_my_profile
  // ---------------------------------------------------------------------------
  server.registerTool(
    'get_my_profile',
    {
      title: 'My Cal profile',
      description: 'Your Cal profile: name, username, email, time zone, week start, 12/24-hour clock and default availability schedule.',
      inputSchema: { format: formatParam },
      annotations: READ_ONLY,
    },
    async args => runTool(async () => {
      const me = await ctx.client.getMe();
      const profile = rememberProfile(ctx.client, me);
      const data = {
        id: me.id,
        name: me.name ?? null,
        username: me.username,
        email: me.email,
        time_zone: me.timeZone ?? null,
        week_start: profile.weekStart,
        time_format: profile.timeFormat,
        default_schedule_id: me.defaultScheduleId ?? null,
        locale: me.locale ?? null,
        bio: me.bio || null,
        organization_id: me.organizationId ?? null,
      };
      if (args.format === 'json') return jsonResult(data);

      return textResult([
        '## Your Cal profile',
        `- Name: ${me.name || '—'}`,
        `- Username: ${me.username}`,
        `- Email: ${me.email}`,
        `- Time zone: ${me.timeZone || 'not set (times are shown in UTC)'}`,
        `- Week starts on: ${profile.weekStart}`,
        `- Clock: ${profile.timeFormat}-hour`,
        `- Default schedule id: ${me.defaultScheduleId ?? '—'}`,
        ...(me.locale ? [`- Language: ${me.locale}`] : []),
        ...(me.bio ? [`- Bio: ${me.bio}`] : []),
      ].join('\n'));
    }),
  );

  // ---------------------------------------------------------------------------
  // get_instance_info
  // ---------------------------------------------------------------------------
  server.registerTool(
    'get_instance_info',
    {
      title: 'Connection diagnostics',
      description:
        'Diagnose the Cal connection: whether the API v2 URL is reachable (and is really API v2), whether the API key ' +
        'works, the account it belongs to, event types, default schedule, connected calendars, default video app, ' +
        'rate-limit headroom and which tool groups are enabled. Use it first when other tools fail.',
      inputSchema: { format: formatParam },
      annotations: READ_ONLY,
    },
    async args => runTool(async () => {
      const [me, eventTypes, schedule, calendars, conferencing] = await Promise.allSettled([
        getProfile(ctx.client, { fresh: true }),
        ctx.client.listEventTypes(),
        ctx.client.getDefaultSchedule(),
        ctx.client.listCalendars(),
        ctx.client.getDefaultConferencingApp(),
      ]);

      const fail = (result: PromiseRejectedResult) => describeError(result.reason).replace(/\n/g, ' ');
      const notes: string[] = [];
      if (me.status === 'rejected' && me.reason instanceof CalApiError && me.reason.html) {
        notes.push('The API URL answers with a web page, so API v2 is not deployed there (or the URL is the web app). See the hint above.');
      }
      if (!ctx.connection.isCloud) {
        notes.push('Cal.diy has no teams, organizations, routing forms, workflows or insights — those Cal.com Cloud features are not available.');
      }
      if (me.status === 'fulfilled' && !me.value.timeZoneFromProfile) {
        notes.push('Your Cal profile has no valid time zone, so times are shown in UTC. Set one in Cal → Settings → General.');
      }
      notes.push(...ctx.connection.warnings);

      const info = {
        api_url: ctx.connection.baseUrl,
        deployment: deployment(ctx),
        api_key: me.status === 'fulfilled'
          ? `ok — ${me.value.name ? `${me.value.name} ` : ''}(${me.value.username}, ${me.value.email})`
          : `failed — ${fail(me)}`,
        time_zone: me.status === 'fulfilled' ? me.value.timeZone : null,
        event_types: eventTypes.status === 'fulfilled'
          ? {
            total: eventTypes.value.length,
            hidden: eventTypes.value.filter(eventType => eventType.hidden).length,
            examples: eventTypes.value.slice(0, 5).map(eventType => ({
              id: eventType.id,
              title: eventType.title,
              length: eventType.lengthInMinutes,
              locations: (eventType.locations ?? []).map(describeEventTypeLocation),
            })),
          }
          : `error: ${fail(eventTypes)}`,
        default_schedule: schedule.status === 'fulfilled'
          ? (schedule.value ? { id: schedule.value.id, name: schedule.value.name, time_zone: schedule.value.timeZone } : 'none')
          : `error: ${fail(schedule)}`,
        calendars: calendars.status === 'fulfilled'
          ? {
            connected: calendars.value.connectedCalendars.map(connected => ({
              integration: connected.integration.title || connected.integration.name || connected.integration.slug,
              calendars: connected.calendars?.length ?? 0,
              checked_for_conflicts: connected.calendars?.filter(calendar => calendar.isSelected).length ?? 0,
            })),
            destination: calendars.value.destinationCalendar
              ? calendars.value.destinationCalendar.name || calendars.value.destinationCalendar.externalId
              : null,
          }
          : `error: ${fail(calendars)}`,
        default_conferencing_app: conferencing.status === 'fulfilled'
          ? conferencing.value?.appSlug ?? 'none'
          : `error: ${fail(conferencing)}`,
        rate_limit: ctx.client.lastRateLimit ?? null,
        access_level: ctx.connection.access,
        tool_groups: toolGroups(ctx),
        notes,
      };

      if (args.format === 'json') return jsonResult(info);

      const eventTypeLine = typeof info.event_types === 'string'
        ? info.event_types
        : `${info.event_types.total} (${info.event_types.hidden} hidden)`;
      const scheduleLine = typeof info.default_schedule === 'string'
        ? info.default_schedule
        : `${info.default_schedule.name} (id ${info.default_schedule.id}, ${info.default_schedule.time_zone})`;
      const calendarLine = typeof info.calendars === 'string'
        ? info.calendars
        : info.calendars.connected.length
          ? info.calendars.connected
            .map(connected => `${connected.integration}: ${connected.calendars} calendar(s), ${connected.checked_for_conflicts} checked for conflicts`)
            .join('; ') + (info.calendars.destination ? ` · new bookings go to ${info.calendars.destination}` : '')
          : 'none connected';
      const rateLimit = ctx.client.lastRateLimit;

      return textResult([
        '## Cal connection',
        `- API: ${info.api_url} — ${info.deployment}`,
        `- API key: ${info.api_key}`,
        ...(info.time_zone ? [`- Time zone: ${info.time_zone}`] : []),
        `- Event types: ${eventTypeLine}`,
        `- Default schedule: ${scheduleLine}`,
        `- Calendars: ${calendarLine}`,
        `- Default video app: ${info.default_conferencing_app}`,
        ...(rateLimit?.remaining !== undefined ? [`- Rate limit: ${rateLimit.remaining} of ${rateLimit.limit ?? '?'} requests left in the current window`] : []),
        '',
        `## Tool groups (access level "${ctx.connection.access}")`,
        ...Object.entries(info.tool_groups).map(([group, status]) => `- ${group}: ${status}`),
        ...(notes.length ? ['', '## Notes', ...notes.map(note => `- ${note}`)] : []),
      ].join('\n'));
    }),
  );
}
