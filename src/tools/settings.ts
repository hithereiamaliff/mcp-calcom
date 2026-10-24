/**
 * Account settings tools.
 *   always:       list_conferencing_apps, list_webhooks
 *   access full:  update_my_profile, set_default_conferencing_app, create_webhook, update_webhook, delete_webhook
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { markdownTable } from '../calcom/format.js';
import { rememberProfile } from '../calcom/profile.js';
import { assertTimeZone } from '../calcom/time.js';
import type { Webhook } from '../calcom/types.js';
import { ToolInputError } from '../errors.js';
import {
  DESTRUCTIVE,
  READ_ONLY,
  type ToolContext,
  WRITE,
  WRITE_IDEMPOTENT,
  allows,
  confirmParam,
  formatParam,
  jsonResult,
  requireConfirmation,
  runTool,
  textResult,
  webhookTriggers,
} from './shared.js';

/** Credential types of conferencing apps → readable names */
const CONFERENCING_LABELS: Record<string, string> = {
  daily_video: 'Cal Video',
  google_video: 'Google Meet',
  zoom_video: 'Zoom',
  office365_video: 'Microsoft Teams',
};

/** Apps POST /conferencing/{app}/default accepts */
const DEFAULT_APPS = ['google-meet', 'zoom', 'msteams', 'daily-video'] as const;
const DEFAULT_APP_LABELS: Record<(typeof DEFAULT_APPS)[number], string> = {
  'google-meet': 'Google Meet',
  zoom: 'Zoom',
  msteams: 'Microsoft Teams',
  'daily-video': 'Cal Video',
};

function webhookJson(webhook: Webhook) {
  const { secret, ...rest } = webhook;
  return { ...rest, has_secret: Boolean(secret) };
}

function webhookRows(webhooks: Webhook[]) {
  return webhooks.map(webhook => ({
    id: webhook.id,
    subscriber_url: webhook.subscriberUrl,
    triggers: webhook.triggers.join(', '),
    active: webhook.active ? 'yes' : 'no',
    scope: webhook.eventTypeId ? `event type ${webhook.eventTypeId}` : 'all bookings',
  }));
}

const eventTypeScope = z
  .number()
  .int()
  .positive()
  .optional()
  .describe('Event type id for event-type webhooks. Omit for account-wide webhooks.');

const triggersParam = z
  .array(z.enum(webhookTriggers))
  .min(1)
  .describe('Events that fire the webhook, e.g. ["BOOKING_CREATED", "BOOKING_CANCELLED"].');

export function registerSettingsTools(server: McpServer, ctx: ToolContext): void {
  // ---------------------------------------------------------------------------
  // list_conferencing_apps
  // ---------------------------------------------------------------------------
  server.registerTool(
    'list_conferencing_apps',
    {
      title: 'Video apps',
      description: 'Installed video conferencing apps (Cal Video, Google Meet, Zoom, Teams …) and which one is the default for new bookings.',
      inputSchema: { format: formatParam },
      annotations: READ_ONLY,
    },
    async args => runTool(async () => {
      const [apps, current] = await Promise.all([
        ctx.client.listConferencingApps(),
        ctx.client.getDefaultConferencingApp().catch(() => null),
      ]);
      if (args.format === 'json') return jsonResult({ apps, default: current });
      return textResult([
        '## Video apps',
        markdownTable(['app', 'type', 'credential_id', 'status'], apps.map(app => ({
          app: CONFERENCING_LABELS[app.type] ?? app.type,
          type: app.type,
          credential_id: app.id,
          status: app.invalid ? 'needs reconnecting' : 'ok',
        })), '_No video apps installed (Cal Video is always available)._'),
        '',
        `Default for new bookings: ${current?.appSlug ?? 'not set (Cal Video)'}${current?.appLink ? ` (${current.appLink})` : ''}`,
      ].join('\n'));
    }),
  );

  // ---------------------------------------------------------------------------
  // list_webhooks
  // ---------------------------------------------------------------------------
  server.registerTool(
    'list_webhooks',
    {
      title: 'List webhooks',
      description: 'Your webhooks (account-wide, or of one event type) with their triggers and target URL. Secrets are never shown.',
      inputSchema: {
        event_type_id: eventTypeScope,
        webhook_id: z.number().int().positive().optional().describe('Show only this webhook.'),
        format: formatParam,
      },
      annotations: READ_ONLY,
    },
    async args => runTool(async () => {
      const webhooks = args.webhook_id
        ? [await ctx.client.getWebhook(args.webhook_id, args.event_type_id)]
        : await ctx.client.listWebhooks(args.event_type_id);
      if (args.format === 'json') return jsonResult(webhooks.map(webhookJson));
      return textResult([
        `## Webhooks${args.event_type_id ? ` · event type ${args.event_type_id}` : ''}`,
        markdownTable(['id', 'subscriber_url', 'triggers', 'active', 'scope'], webhookRows(webhooks), '_No webhooks._'),
      ].join('\n'));
    }),
  );

  if (!allows(ctx, 'full')) return;

  // ---------------------------------------------------------------------------
  // update_my_profile
  // ---------------------------------------------------------------------------
  server.registerTool(
    'update_my_profile',
    {
      title: 'Update my profile',
      description: 'Change your Cal profile: name, time zone, week start, 12/24-hour clock, language, bio or default schedule.',
      inputSchema: {
        name: z.string().trim().min(1).optional(),
        time_zone: z.string().optional().describe('IANA time zone, e.g. "Asia/Kuala_Lumpur".'),
        week_start: z.enum(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']).optional(),
        time_format: z.union([z.literal(12), z.literal(24)]).optional().describe('12 or 24.'),
        locale: z.string().optional().describe('Language code, e.g. "en", "ms", "id".'),
        bio: z.string().optional(),
        default_schedule_id: z.number().int().positive().optional().describe('Schedule id (list_schedules) to make your default.'),
      },
      annotations: WRITE_IDEMPOTENT,
    },
    async args => runTool(async () => {
      const body: Record<string, unknown> = {
        ...(args.name ? { name: args.name } : {}),
        ...(args.time_zone ? { timeZone: assertTimeZone(args.time_zone.trim()) } : {}),
        ...(args.week_start ? { weekStart: args.week_start } : {}),
        ...(args.time_format ? { timeFormat: args.time_format } : {}),
        ...(args.locale ? { locale: args.locale } : {}),
        ...(args.bio !== undefined ? { bio: args.bio } : {}),
        ...(args.default_schedule_id ? { defaultScheduleId: args.default_schedule_id } : {}),
      };
      if (!Object.keys(body).length) throw new ToolInputError('Nothing to update — pass at least one field.');
      const me = await ctx.client.updateMe(body);
      const profile = rememberProfile(ctx.client, me);
      return textResult([
        '## Profile updated',
        `- Name: ${me.name || '—'}`,
        `- Time zone: ${me.timeZone || '—'}`,
        `- Week starts on: ${profile.weekStart}`,
        `- Clock: ${profile.timeFormat}-hour`,
        `- Default schedule id: ${me.defaultScheduleId ?? '—'}`,
      ].join('\n'));
    }),
  );

  // ---------------------------------------------------------------------------
  // set_default_conferencing_app
  // ---------------------------------------------------------------------------
  server.registerTool(
    'set_default_conferencing_app',
    {
      title: 'Set default video app',
      description: 'Choose the video app used by default for new bookings. The app must already be installed in Cal.',
      inputSchema: {
        app: z.enum(DEFAULT_APPS).describe('google-meet, zoom, msteams or daily-video (Cal Video).'),
      },
      annotations: WRITE_IDEMPOTENT,
    },
    async args => runTool(async () => {
      await ctx.client.setDefaultConferencingApp(args.app);
      return textResult(`${DEFAULT_APP_LABELS[args.app]} is now the default video app for new bookings.`);
    }),
  );

  // ---------------------------------------------------------------------------
  // create_webhook / update_webhook / delete_webhook
  // ---------------------------------------------------------------------------
  server.registerTool(
    'create_webhook',
    {
      title: 'Create a webhook',
      description: 'Have Cal POST booking events to a URL — for all your bookings, or only one event type.',
      inputSchema: {
        subscriber_url: z.string().url().describe('HTTPS URL that receives the POST requests.'),
        triggers: triggersParam.optional().describe('Default: ["BOOKING_CREATED", "BOOKING_RESCHEDULED", "BOOKING_CANCELLED"].'),
        active: z.boolean().optional().describe('Default true.'),
        secret: z.string().optional().describe('Signing secret for the X-Cal-Signature-256 header.'),
        payload_template: z.string().optional().describe('Custom payload template (Cal webhook variables).'),
        event_type_id: eventTypeScope,
      },
      annotations: WRITE,
    },
    async args => runTool(async () => {
      const webhook = await ctx.client.createWebhook({
        subscriberUrl: args.subscriber_url,
        triggers: args.triggers ?? ['BOOKING_CREATED', 'BOOKING_RESCHEDULED', 'BOOKING_CANCELLED'],
        active: args.active ?? true,
        ...(args.secret ? { secret: args.secret } : {}),
        ...(args.payload_template ? { payloadTemplate: args.payload_template } : {}),
      }, args.event_type_id);
      return textResult(['## Webhook created', markdownTable(['id', 'subscriber_url', 'triggers', 'active', 'scope'], webhookRows([webhook]))].join('\n'));
    }),
  );

  server.registerTool(
    'update_webhook',
    {
      title: 'Update a webhook',
      description: 'Change a webhook: URL, triggers, active state, secret or payload template.',
      inputSchema: {
        webhook_id: z.number().int().positive().describe('Webhook id (list_webhooks).'),
        event_type_id: eventTypeScope,
        subscriber_url: z.string().url().optional(),
        triggers: triggersParam.optional(),
        active: z.boolean().optional(),
        secret: z.string().optional(),
        payload_template: z.string().optional(),
      },
      annotations: WRITE_IDEMPOTENT,
    },
    async args => runTool(async () => {
      const body: Record<string, unknown> = {
        ...(args.subscriber_url ? { subscriberUrl: args.subscriber_url } : {}),
        ...(args.triggers ? { triggers: args.triggers } : {}),
        ...(args.active !== undefined ? { active: args.active } : {}),
        ...(args.secret ? { secret: args.secret } : {}),
        ...(args.payload_template !== undefined ? { payloadTemplate: args.payload_template } : {}),
      };
      if (!Object.keys(body).length) throw new ToolInputError('Nothing to update — pass at least one field.');
      const webhook = await ctx.client.updateWebhook(args.webhook_id, body, args.event_type_id);
      return textResult(['## Webhook updated', markdownTable(['id', 'subscriber_url', 'triggers', 'active', 'scope'], webhookRows([webhook]))].join('\n'));
    }),
  );

  server.registerTool(
    'delete_webhook',
    {
      title: 'Delete a webhook',
      description: 'Delete a webhook. Needs confirm: true.',
      inputSchema: {
        webhook_id: z.number().int().positive().describe('Webhook id (list_webhooks).'),
        event_type_id: eventTypeScope,
        confirm: confirmParam,
      },
      annotations: DESTRUCTIVE,
    },
    async args => runTool(async () => {
      requireConfirmation(args.confirm, 'Deleting a webhook');
      await ctx.client.deleteWebhook(args.webhook_id, args.event_type_id);
      return textResult(`Webhook ${args.webhook_id} deleted.`);
    }),
  );
}
