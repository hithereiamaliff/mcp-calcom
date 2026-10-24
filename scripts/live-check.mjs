#!/usr/bin/env node
/**
 * Read-only live check against a real Cal.com / Cal.diy instance.
 *
 * Reads CALCOM_API_KEY and CALCOM_API_URL from .env, starts dist/cli.js over stdio with the
 * access level forced to "read" (no tool that changes data is even registered), and prints
 * the output of every read tool.
 *
 *   npm run live-check
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!process.env.CALCOM_API_KEY && !process.env.CAL_API_KEY) {
  console.error('Set CALCOM_API_KEY (and CALCOM_API_URL for a self-hosted instance) in .env first — see .env.sample.');
  process.exit(1);
}

const client = new Client({ name: 'live-check', version: '1.0.0' });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, 'dist/cli.js')],
  env: { ...process.env, CALCOM_ACCESS: 'read' },
  stderr: 'inherit',
}));

const tools = (await client.listTools()).tools.map(tool => tool.name);
console.log(`\n${tools.length} tools: ${tools.join(', ')}\n`);

const results = [];
async function run(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const output = result.content.map(item => item.text).join('\n');
  results.push(!result.isError);
  console.log(`${'='.repeat(80)}\n${name} ${JSON.stringify(args)}${result.isError ? '  [ERROR]' : ''}\n${'-'.repeat(80)}\n${output}\n`);
  return { result, output };
}

function parseJson(output) {
  try {
    return JSON.parse(output);
  } catch {
    return undefined;
  }
}

await run('get_instance_info');
await run('get_my_profile');

const eventTypes = parseJson((await run('list_event_types', { format: 'json' })).output) ?? [];
await run('list_event_types');
const visible = eventTypes.find(eventType => !eventType.hidden) ?? eventTypes[0];
if (visible) {
  await run('get_event_type', { event_type_id: visible.id });
  await run('list_private_links', { event_type_id: visible.id });
  await run('get_available_slots', { event_type_id: visible.id, days: 3 });
}

const upcoming = parseJson((await run('list_bookings', { format: 'json', limit: 5 })).output);
await run('list_bookings', { limit: 10 });
const past = parseJson((await run('list_bookings', { when: 'past', format: 'json', limit: 5 })).output);
await run('list_bookings', { when: 'past_30_days', limit: 10 });
const sample = upcoming?.bookings?.[0] ?? past?.bookings?.[0];
if (sample) await run('get_booking', { booking_uid: sample.uid, include: ['attendees', 'calendar_links', 'references'] });
await run('get_booking_summary', { period: 'past_30_days' });

await run('list_schedules');
await run('get_schedule');
await run('list_calendars');
await run('get_busy_times');
await run('list_calendar_events');
await run('list_conferencing_apps');
await run('list_webhooks');

await client.close();
const succeeded = results.filter(Boolean).length;
console.log(`${succeeded}/${results.length} calls succeeded.`);
process.exit(succeeded === results.length ? 0 : 1);
