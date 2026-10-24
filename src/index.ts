/**
 * Cal.com / Cal.diy MCP Server — shared server factory.
 *
 * Used by both entry points:
 *   - src/cli.ts          stdio transport (npx / local MCP clients)
 *   - src/http-server.ts  Streamable HTTP transport (VPS, per-request servers)
 *
 * Tools are registered per connection, so a client only sees what its access level allows:
 *   read      profile, bookings, availability & calendars, event types, schedules, settings (all read-only)
 *   bookings  + booking actions (create / reschedule / cancel / confirm / decline / no-show / guests / location)
 *               and private links
 *   full      + configuration changes (event types, schedules, profile, default conferencing app, webhooks)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CalcomConnection } from './config.js';
import { registerAvailabilityTools } from './tools/availability.js';
import { registerBookingTools } from './tools/bookings.js';
import { registerCoreTools } from './tools/core.js';
import { registerEventTypeTools } from './tools/event-types.js';
import { registerScheduleTools } from './tools/schedules.js';
import { registerSettingsTools } from './tools/settings.js';
import { createToolContext, type ToolContext } from './tools/shared.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

export const SERVER_INSTRUCTIONS =
  'Cal.com / Cal.diy scheduling tools. Times are shown in the account time zone (see get_my_profile) unless you ' +
  'pass time_zone; give times as "YYYY-MM-DD HH:mm" in that zone or as ISO with an offset. To book someone: ' +
  'list_event_types → get_available_slots → create_booking. Bookings are identified by their uid (list_bookings). ' +
  'Tools that change data only exist when the connection allows them (see hello); destructive tools need ' +
  'confirm: true after the user explicitly agrees. If calls fail, get_instance_info diagnoses the connection.';

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  registerCoreTools(server, ctx);
  registerBookingTools(server, ctx);
  registerAvailabilityTools(server, ctx);
  registerEventTypeTools(server, ctx);
  registerScheduleTools(server, ctx);
  registerSettingsTools(server, ctx);
}

export function createAppServer(
  connection: CalcomConnection,
  options: { transport: ToolContext['transport']; authMode: string },
): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
  registerAllTools(server, createToolContext(connection, options));
  return server;
}
