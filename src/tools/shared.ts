/**
 * Shared plumbing for tool modules: per-connection context, display time zone, access
 * gating, uniform error handling, annotations and common zod parameters.
 */

import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { CalClient } from '../calcom/client.js';
import { hintForError } from '../calcom/format.js';
import { CalApiError } from '../calcom/http.js';
import { type AccountProfile, getProfile } from '../calcom/profile.js';
import { type TimeFormat, assertTimeZone } from '../calcom/time.js';
import { type AccessLevel, type CalcomConnection, ConnectionConfigError, allowsAccess } from '../config.js';
import { ToolInputError } from '../errors.js';

export interface ToolContext {
  connection: CalcomConnection;
  client: CalClient;
  transport: 'stdio' | 'streamable-http';
  authMode: string;
}

export function createToolContext(
  connection: CalcomConnection,
  options: { transport: ToolContext['transport']; authMode: string },
): ToolContext {
  return {
    connection,
    client: new CalClient(connection.baseUrl, connection.apiKey),
    ...options,
  };
}

export function allows(ctx: ToolContext, level: AccessLevel): boolean {
  return allowsAccess(ctx.connection, level);
}

export interface Display {
  profile: AccountProfile;
  /** Zone used to read and show times: the tool argument, else the profile's */
  timeZone: string;
  timeFormat: TimeFormat;
}

export async function display(ctx: ToolContext, timeZone?: string): Promise<Display> {
  const profile = await getProfile(ctx.client);
  return {
    profile,
    timeZone: timeZone?.trim() ? assertTimeZone(timeZone.trim()) : profile.timeZone,
    timeFormat: profile.timeFormat,
  };
}

// =============================================================================
// Results & errors
// =============================================================================

export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

export function jsonResult(data: unknown): CallToolResult {
  return textResult(JSON.stringify(data, null, 2));
}

export function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export function describeError(error: unknown): string {
  if (error instanceof ToolInputError || error instanceof ConnectionConfigError) {
    return error.message;
  }
  if (error instanceof CalApiError) {
    const status = error.status ? ` (${error.status})` : '';
    const lines = [`Cal.com API error${status} on ${error.endpoint}: ${error.message}`];
    lines.push(...error.details.slice(0, 10).map(detail => `- ${detail}`));
    const hint = hintForError(error);
    if (hint) lines.push(`Hint: ${hint}`);
    return lines.join('\n');
  }
  console.error('Unexpected tool error:', error);
  return `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
}

/** Run a tool body and turn every failure into an isError result */
export async function runTool(body: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await body();
  } catch (error) {
    return errorResult(describeError(error));
  }
}

export function requireConfirmation(confirm: boolean | undefined, action: string): void {
  if (confirm !== true) {
    throw new ToolInputError(
      `${action} cannot be undone. Ask the user to confirm explicitly, then call this tool again with confirm: true.`,
    );
  }
}

/** Collapse a recurring-series response (array) to its first occurrence, keeping the count */
export function firstBooking<T>(data: T | T[]): { booking: T; count: number } {
  if (Array.isArray(data)) {
    if (!data.length) throw new ToolInputError('The Cal API returned no booking.');
    return { booking: data[0], count: data.length };
  }
  return { booking: data, count: 1 };
}

// =============================================================================
// Annotations
// =============================================================================

export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
export const WRITE_IDEMPOTENT: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
export const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
export const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };

// =============================================================================
// Common parameter schemas
// =============================================================================

export const formatParam = z
  .enum(['markdown', 'json'])
  .optional()
  .describe('Output format: "markdown" (default, readable) or "json" (structured data).');

export const timeZoneParam = z
  .string()
  .optional()
  .describe('IANA time zone used to read and show times, e.g. "Asia/Kuala_Lumpur". Default: the time zone in your Cal profile.');

export const confirmParam = z
  .boolean()
  .optional()
  .describe('Must be true. Set it only after the user has explicitly confirmed this action.');

export const bookingUidParam = z
  .string()
  .trim()
  .min(1)
  .describe('Booking uid, as shown by list_bookings / get_booking (e.g. "8bx2PqLmZt0aQd71").');

export const eventTypeIdParam = z
  .number()
  .int()
  .positive()
  .describe('Event type id, as shown by list_event_types.');

export const scheduleIdParam = z
  .number()
  .int()
  .positive()
  .describe('Schedule id, as shown by list_schedules.');

export const webhookTriggers = [
  'BOOKING_CREATED',
  'BOOKING_PAYMENT_INITIATED',
  'BOOKING_PAID',
  'BOOKING_RESCHEDULED',
  'BOOKING_REQUESTED',
  'BOOKING_CANCELLED',
  'BOOKING_REJECTED',
  'BOOKING_NO_SHOW_UPDATED',
  'MEETING_STARTED',
  'MEETING_ENDED',
  'RECORDING_READY',
  'RECORDING_TRANSCRIPTION_GENERATED',
  'INSTANT_MEETING',
  'OOO_CREATED',
  'AFTER_HOSTS_CAL_VIDEO_NO_SHOW',
  'AFTER_GUESTS_CAL_VIDEO_NO_SHOW',
  'FORM_SUBMITTED',
  'FORM_SUBMITTED_NO_EVENT',
] as const;
