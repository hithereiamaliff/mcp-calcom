import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { type AccessLevel, normalizeConnection } from '../src/config.js';
import { createAppServer } from '../src/index.js';

// Nothing listens on port 9: any accidental API call fails fast with a network error
const UNREACHABLE_API = 'http://127.0.0.1:9/api/v2';

async function connect(access: AccessLevel) {
  const server = createAppServer(normalizeConnection({ apiKey: 'cal_test', apiUrl: UNREACHABLE_API, access }), { transport: 'stdio', authMode: 'test' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  return { client, tools, close: async () => { await client.close(); await server.close(); } };
}

const READ_TOOLS = [
  'hello', 'get_my_profile', 'get_instance_info',
  'list_bookings', 'get_booking', 'get_booking_summary',
  'get_available_slots', 'list_calendars', 'get_busy_times', 'list_calendar_events',
  'list_event_types', 'get_event_type', 'list_private_links',
  'list_schedules', 'get_schedule',
  'list_conferencing_apps', 'list_webhooks',
];
const BOOKING_TOOLS = [
  'create_booking', 'reschedule_booking', 'cancel_booking', 'confirm_booking', 'decline_booking',
  'mark_no_show', 'add_booking_guests', 'remove_booking_attendee', 'update_booking_location',
  'create_private_link', 'delete_private_link',
];
const CONFIG_TOOLS = [
  'create_event_type', 'update_event_type', 'delete_event_type',
  'create_schedule', 'update_schedule', 'delete_schedule',
  'update_my_profile', 'set_default_conferencing_app',
  'create_webhook', 'update_webhook', 'delete_webhook',
];
const DESTRUCTIVE_TOOLS = ['cancel_booking', 'decline_booking', 'remove_booking_attendee', 'delete_private_link', 'delete_event_type', 'delete_schedule', 'delete_webhook'];

const text = (result: { content: unknown }) => (result.content as Array<{ text: string }>).map(item => item.text).join('\n');

describe('tool registration by access level', () => {
  it('read: 17 read-only tools', async () => {
    const { tools, close } = await connect('read');
    assert.deepEqual(tools.map(tool => tool.name).sort(), [...READ_TOOLS].sort());
    for (const tool of tools) assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
    await close();
  });

  it('bookings: + 11 booking actions', async () => {
    const { tools, close } = await connect('bookings');
    assert.deepEqual(tools.map(tool => tool.name).sort(), [...READ_TOOLS, ...BOOKING_TOOLS].sort());
    await close();
  });

  it('full: all 39 tools with consistent annotations and no header parameters', async () => {
    const { tools, close } = await connect('full');
    assert.equal(tools.length, 39);
    assert.deepEqual(tools.map(tool => tool.name).sort(), [...READ_TOOLS, ...BOOKING_TOOLS, ...CONFIG_TOOLS].sort());
    for (const tool of tools) {
      assert.ok(tool.title && tool.description, `${tool.name} needs a title and description`);
      assert.equal(tool.annotations?.destructiveHint, DESTRUCTIVE_TOOLS.includes(tool.name), `${tool.name} destructiveHint`);
      const properties = Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
      for (const forbidden of ['cal-api-version', 'Authorization', 'authorization', 'api_key', 'apiKey']) {
        assert.ok(!properties.includes(forbidden), `${tool.name} must not take ${forbidden}`);
      }
      if (DESTRUCTIVE_TOOLS.includes(tool.name)) assert.ok(properties.includes('confirm'), `${tool.name} needs confirm`);
      // A zod schema reused inside one tool turns into a $ref, which some MCP clients cannot resolve
      assert.doesNotMatch(JSON.stringify(tool.inputSchema), /\$ref/, `${tool.name} input schema must be self-contained`);
    }
    await close();
  });
});

describe('tool behaviour without the API', () => {
  it('hello works offline and never shows the API key', async () => {
    const { client, close } = await connect('bookings');
    const output = text(await client.callTool({ name: 'hello', arguments: {} }));
    assert.match(output, /"access_level": "bookings"/);
    assert.match(output, /"api_url": "http:\/\/127\.0\.0\.1:9\/api\/v2"/);
    assert.doesNotMatch(output, /cal_test/);
    await close();
  });

  it('destructive tools refuse without confirm: true before calling the API', async () => {
    const { client, close } = await connect('full');
    const calls: Array<[string, Record<string, unknown>]> = [
      ['cancel_booking', { booking_uid: 'abc' }],
      ['decline_booking', { booking_uid: 'abc' }],
      ['remove_booking_attendee', { booking_uid: 'abc', attendee_id: 3 }],
      ['delete_private_link', { event_type_id: 1, link_id: 'x' }],
      ['delete_event_type', { event_type_id: 1 }],
      ['delete_schedule', { schedule_id: 1 }],
      ['delete_webhook', { webhook_id: 1 }],
    ];
    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, name);
      assert.match(text(result), /confirm: true/, name);
    }
    await close();
  });

  it('API failures come back as isError results with a hint', async () => {
    const { client, close } = await connect('read');
    const result = await client.callTool({ name: 'list_event_types', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(text(result), /Cal\.com API error on GET \/event-types/);
    assert.match(text(result), /Hint: Could not reach the Cal\.com API/);
    await close();
  });
});
