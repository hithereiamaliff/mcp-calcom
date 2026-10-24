/**
 * Availability schedule tools (working hours and date overrides).
 *   always:       list_schedules, get_schedule
 *   access full:  create_schedule, update_schedule, delete_schedule
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { describeOverride, isUnavailableOverride, weeklyHours } from '../calcom/format.js';
import { assertTimeZone, todayIn } from '../calcom/time.js';
import type { Schedule, ScheduleOverride } from '../calcom/types.js';
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
  formatParam,
  jsonResult,
  requireConfirmation,
  runTool,
  scheduleIdParam,
  textResult,
} from './shared.js';

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Factories, not shared instances: a schema reused within one tool becomes a JSON-schema $ref,
// which some MCP clients cannot resolve
const timeParam = (example: string) => z.string().regex(TIME, 'Use "HH:mm" (24-hour), e.g. "09:00".').describe(`"HH:mm" (24-hour), e.g. "${example}".`);
const dateParam = () => z.string().regex(DATE, 'Use "YYYY-MM-DD".').describe('Date "YYYY-MM-DD".');

const availabilitySchema = z
  .array(z.object({
    days: z.array(z.enum(WEEKDAYS)).min(1).describe('Weekdays this block applies to.'),
    start_time: timeParam('09:00'),
    end_time: timeParam('17:00'),
  }))
  .describe('Weekly working hours; several blocks per day are allowed (e.g. a lunch break). Replaces the existing hours.');

const overridesSchema = z
  .array(z.object({ date: dateParam(), start_time: timeParam('10:00'), end_time: timeParam('14:00') }))
  .describe('Different hours on specific dates. Use block_dates to make a whole day unavailable.');

function checkRange(start: string, end: string, label: string): void {
  if (end <= start) throw new ToolInputError(`${label}: end_time (${end}) must be after start_time (${start}).`);
}

function scheduleLines(schedule: Schedule, today: string): string[] {
  const upcoming = schedule.overrides
    .filter(override => override.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
  const pastCount = schedule.overrides.length - upcoming.length;
  return [
    `## ${schedule.name} (id ${schedule.id})${schedule.isDefault ? ' — default' : ''}`,
    `- Time zone: ${schedule.timeZone}`,
    '- Weekly hours:',
    ...weeklyHours(schedule.availability).map(line => `  - ${line}`),
    ...(upcoming.length ? ['- Date overrides:', ...upcoming.slice(0, 30).map(override => `  - ${describeOverride(override)}`)] : ['- Date overrides: none upcoming']),
    ...(pastCount ? [`  _(${pastCount} past override(s) not shown)_`] : []),
  ];
}

function scheduleJson(schedule: Schedule) {
  return {
    id: schedule.id,
    name: schedule.name,
    time_zone: schedule.timeZone,
    is_default: schedule.isDefault,
    availability: schedule.availability,
    overrides: schedule.overrides.map(override => ({ ...override, unavailable: isUnavailableOverride(override) })),
  };
}

function toApiAvailability(blocks: z.infer<typeof availabilitySchema>) {
  return blocks.map((block, index) => {
    checkRange(block.start_time, block.end_time, `availability[${index}]`);
    return { days: block.days, startTime: block.start_time, endTime: block.end_time };
  });
}

function toApiOverrides(blocks: z.infer<typeof overridesSchema>): ScheduleOverride[] {
  return blocks.map((block, index) => {
    checkRange(block.start_time, block.end_time, `overrides[${index}]`);
    return { date: block.date, startTime: block.start_time, endTime: block.end_time };
  });
}

async function loadSchedule(ctx: ToolContext, scheduleId?: number): Promise<Schedule> {
  if (scheduleId) return ctx.client.getSchedule(scheduleId);
  const schedule = await ctx.client.getDefaultSchedule();
  if (!schedule) throw new ToolInputError('You have no default schedule. Pass schedule_id (see list_schedules).');
  return schedule;
}

export function registerScheduleTools(server: McpServer, ctx: ToolContext): void {
  // ---------------------------------------------------------------------------
  // list_schedules / get_schedule
  // ---------------------------------------------------------------------------
  server.registerTool(
    'list_schedules',
    {
      title: 'List availability schedules',
      description: 'Your availability schedules (working hours) with their time zone, weekly hours and upcoming date overrides; the default one is marked.',
      inputSchema: { format: formatParam },
      annotations: READ_ONLY,
    },
    async args => runTool(async () => {
      const schedules = await ctx.client.listSchedules();
      if (args.format === 'json') return jsonResult(schedules.map(scheduleJson));
      if (!schedules.length) return textResult('You have no availability schedules.');
      const today = todayIn((await display(ctx)).timeZone);
      return textResult(schedules.flatMap(schedule => [...scheduleLines(schedule, today), '']).join('\n').trim());
    }),
  );

  server.registerTool(
    'get_schedule',
    {
      title: 'Get an availability schedule',
      description: 'One availability schedule (default: your default schedule) with weekly hours and date overrides.',
      inputSchema: { schedule_id: scheduleIdParam.optional(), format: formatParam },
      annotations: READ_ONLY,
    },
    async args => runTool(async () => {
      const schedule = await loadSchedule(ctx, args.schedule_id);
      if (args.format === 'json') return jsonResult(scheduleJson(schedule));
      return textResult(scheduleLines(schedule, todayIn(schedule.timeZone)).join('\n'));
    }),
  );

  if (!allows(ctx, 'full')) return;

  // ---------------------------------------------------------------------------
  // create_schedule
  // ---------------------------------------------------------------------------
  server.registerTool(
    'create_schedule',
    {
      title: 'Create an availability schedule',
      description: 'Create a new availability schedule. Without availability it starts as Monday–Friday 09:00–17:00.',
      inputSchema: {
        name: z.string().trim().min(1).describe('Name, e.g. "Consulting hours".'),
        time_zone: z.string().optional().describe('IANA time zone of the hours. Default: your profile time zone.'),
        availability: availabilitySchema.optional(),
        overrides: overridesSchema.optional(),
        is_default: z.boolean().optional().describe('Make it your default schedule (default false).'),
      },
      annotations: WRITE,
    },
    async args => runTool(async () => {
      const d = await display(ctx);
      const body: Record<string, unknown> = {
        name: args.name,
        timeZone: args.time_zone ? assertTimeZone(args.time_zone.trim()) : d.timeZone,
        isDefault: args.is_default ?? false,
        ...(args.availability ? { availability: toApiAvailability(args.availability) } : {}),
        ...(args.overrides ? { overrides: toApiOverrides(args.overrides) } : {}),
      };
      const schedule = await ctx.client.createSchedule(body);
      return textResult(['Created.', '', ...scheduleLines(schedule, todayIn(schedule.timeZone))].join('\n'));
    }),
  );

  // ---------------------------------------------------------------------------
  // update_schedule
  // ---------------------------------------------------------------------------
  server.registerTool(
    'update_schedule',
    {
      title: 'Update an availability schedule',
      description:
        'Change working hours or date overrides of a schedule (default: your default schedule). availability replaces ' +
        'the weekly hours; overrides are merged by date unless overrides_mode is "replace"; block_dates makes whole days ' +
        'unavailable and unblock_dates removes the overrides of those days.',
      inputSchema: {
        schedule_id: scheduleIdParam.optional().describe('Schedule id (list_schedules). Default: your default schedule.'),
        name: z.string().trim().min(1).optional().describe('New name.'),
        time_zone: z.string().optional().describe('New IANA time zone for the hours.'),
        availability: availabilitySchema.optional(),
        overrides: overridesSchema.optional(),
        overrides_mode: z.enum(['merge', 'replace']).optional().describe('merge (default): replace overrides only on the given dates; replace: overwrite all overrides.'),
        block_dates: z.array(dateParam()).optional().describe('Days to make unavailable (e.g. holidays).'),
        unblock_dates: z.array(dateParam()).optional().describe('Days whose overrides should be removed (back to weekly hours).'),
        is_default: z.boolean().optional().describe('Make this your default schedule.'),
      },
      annotations: WRITE_IDEMPOTENT,
    },
    async args => runTool(async () => {
      const current = await loadSchedule(ctx, args.schedule_id);
      const body: Record<string, unknown> = {};
      if (args.name) body.name = args.name;
      if (args.time_zone) body.timeZone = assertTimeZone(args.time_zone.trim());
      if (args.availability) body.availability = toApiAvailability(args.availability);
      if (args.is_default !== undefined) body.isDefault = args.is_default;

      if (args.overrides || args.block_dates?.length || args.unblock_dates?.length) {
        const given = args.overrides ? toApiOverrides(args.overrides) : [];
        let overrides = args.overrides_mode === 'replace' && args.overrides ? [] : [...current.overrides];
        const replacedDates = new Set([...given.map(override => override.date), ...(args.block_dates ?? []), ...(args.unblock_dates ?? [])]);
        overrides = overrides.filter(override => !replacedDates.has(override.date));
        overrides.push(...given);
        overrides.push(...(args.block_dates ?? []).map(date => ({ date, startTime: '00:00', endTime: '00:00' })));
        body.overrides = overrides.sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
      }

      if (!Object.keys(body).length) throw new ToolInputError('Nothing to update — pass at least one change.');
      const schedule = await ctx.client.updateSchedule(current.id, body);
      return textResult(['Updated.', '', ...scheduleLines(schedule, todayIn(schedule.timeZone))].join('\n'));
    }),
  );

  // ---------------------------------------------------------------------------
  // delete_schedule
  // ---------------------------------------------------------------------------
  server.registerTool(
    'delete_schedule',
    {
      title: 'Delete an availability schedule',
      description: 'Delete a schedule that is not your default. Event types using it fall back to the default schedule. Needs confirm: true.',
      inputSchema: { schedule_id: scheduleIdParam, confirm: confirmParam },
      annotations: DESTRUCTIVE,
    },
    async args => runTool(async () => {
      requireConfirmation(args.confirm, 'Deleting a schedule');
      const schedule = await ctx.client.getSchedule(args.schedule_id);
      if (schedule.isDefault) {
        throw new ToolInputError(`"${schedule.name}" is your default schedule. Make another schedule the default first (update_schedule with is_default: true).`);
      }
      await ctx.client.deleteSchedule(args.schedule_id);
      return textResult(`Deleted schedule "${schedule.name}" (id ${schedule.id}).`);
    }),
  );
}
