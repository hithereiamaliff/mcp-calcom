#!/usr/bin/env node
/**
 * Cal.com MCP Server — stdio entry point (npx / Claude Desktop / Cursor / …).
 * All logging goes to stderr; stdout is reserved for the MCP protocol.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConnectionConfigError, normalizeConnection } from './config.js';
import { createAppServer } from './index.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

async function main() {
  const { CALCOM_API_KEY, CAL_API_KEY, CALCOM_API_URL, CALCOM_ACCESS } = process.env;
  const apiKey = CALCOM_API_KEY || CAL_API_KEY;

  if (!apiKey) {
    console.error('ERROR: Missing required environment variable CALCOM_API_KEY (a Cal.com / Cal.diy API key, cal_…).');
    console.error('\nCreate one in Cal → Settings → Developer → API Keys, then set it in your MCP client config:');
    console.error('  CALCOM_API_KEY   required  API key (CAL_API_KEY is accepted too)');
    console.error('  CALCOM_API_URL   optional  API v2 URL of a self-hosted instance, e.g. https://cal.example.com/api/v2');
    console.error('                             (default: Cal.com Cloud, https://api.cal.com/v2)');
    console.error('  CALCOM_ACCESS    optional  "read" (default), "bookings" (booking actions) or "full" (also configuration)');
    process.exit(1);
  }

  let connection;
  try {
    connection = normalizeConnection({ apiKey, apiUrl: CALCOM_API_URL, access: CALCOM_ACCESS });
  } catch (error) {
    if (error instanceof ConnectionConfigError) {
      console.error(`ERROR: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  for (const warning of connection.warnings) console.error(`Warning: ${warning}`);

  const server = createAppServer(connection, { transport: 'stdio', authMode: 'cli' });
  await server.connect(new StdioServerTransport());

  console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
  console.error(`API: ${connection.baseUrl}${connection.isCloud ? ' (Cal.com Cloud)' : ''}`);
  console.error(`Access level: ${connection.access}`);
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
