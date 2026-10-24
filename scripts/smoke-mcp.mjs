#!/usr/bin/env node
/**
 * End-to-end smoke test (no real credentials needed).
 *
 * Boots dist/http-server.js against a fake MCP Key Service and a fake Cal API v2 (which
 * enforces the API key and the per-endpoint cal-api-version header like the real one),
 * then drives it with the official MCP SDK client in every auth mode, plus dist/cli.js
 * over stdio. Run with: npm run smoke
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CAL_KEY = 'cal_test_key';
const SERVER_TOKEN = 'server-token';
const ADMIN_KEY = 'admin-key';
const KL_OFFSET_MS = 8 * 3600_000;

const KEYS = {
  read: `usr_${'a'.repeat(32)}`,
  invalid: `usr_${'b'.repeat(32)}`,
  bookings: `usr_${'c'.repeat(32)}`,
  full: `usr_${'d'.repeat(32)}`,
  privateUrl: `usr_${'e'.repeat(32)}`,
  webApp: `usr_${'f'.repeat(32)}`,
  badCalKey: `usr_${'1'.repeat(32)}`,
  uncached: `usr_${'2'.repeat(32)}`,
};

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => resolve(data));
  });
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(body));
}

const ok = (res, data, extra = {}) => json(res, 200, { status: 'success', data, ...extra }, {
  'X-RateLimit-Limit-Default': '120',
  'X-RateLimit-Remaining-Default': '117',
  'X-RateLimit-Reset-Default': '42',
});
const fail = (res, status, code, message) => json(res, status, { status: 'error', timestamp: new Date().toISOString(), path: '', error: { code, message } });

// =============================================================================
// Fake Cal API v2 data
// =============================================================================

/** "YYYY-MM-DD" in Kuala Lumpur (UTC+8, no DST) */
const klDate = date => new Date(date.getTime() + KL_OFFSET_MS).toISOString().slice(0, 10);
const klInstant = (day, time) => new Date(`${day}T${time}:00.000+08:00`);
const addDaysUtc = (date, days) => new Date(date.getTime() + days * 86_400_000);
const at = (dayOffset, time) => klInstant(klDate(addDaysUtc(new Date(), dayOffset)), time);

const me = {
  id: 7, username: 'aliff', email: 'hello@example.com', name: 'Aliff', timeZone: 'Asia/Kuala_Lumpur',
  weekStart: 'Monday', timeFormat: 24, defaultScheduleId: 11, locale: 'en', bio: null, organizationId: null,
};

const eventTypes = [
  {
    id: 101, title: '30 Min Meeting', slug: '30min', lengthInMinutes: 30, hidden: false, price: 0, currency: 'usd',
    metadata: {}, locations: [{ type: 'integration', integration: 'cal-video' }],
    bookingFields: [{ type: 'name', slug: 'name', label: 'Your name', required: true, isDefault: true }, { type: 'text', slug: 'company', label: 'Company', required: false, isDefault: false }],
    confirmationPolicy: null, minimumBookingNotice: 120, beforeEventBuffer: 0, afterEventBuffer: 10,
    bookingUrl: 'https://book.example.com/aliff/30min', ownerId: 7,
  },
  {
    id: 102, title: 'Paid Consultation', slug: 'paid', lengthInMinutes: 60, hidden: true, price: 0, currency: 'usd',
    metadata: { apps: { hitpay: { enabled: true, price: 5000, currency: 'myr' } } },
    locations: [{ type: 'address', address: 'Menara KL', public: true }], bookingFields: [],
    confirmationPolicy: { type: 'always', blockUnconfirmedBookingsInBooker: true },
    bookingUrl: 'https://book.example.com/aliff/paid', ownerId: 7,
  },
];

function makeBooking(uid, start, minutes, status, eventTypeId, extra = {}) {
  const end = new Date(start.getTime() + minutes * 60_000);
  return {
    id: Math.floor(Math.random() * 1e6), uid, title: `${eventTypes.find(e => e.id === eventTypeId).title} between Aliff and John Doe`,
    description: '', hosts: [{ id: 7, name: 'Aliff', email: 'hello@example.com', username: 'aliff', timeZone: 'Asia/Kuala_Lumpur' }],
    status, start: start.toISOString(), end: end.toISOString(), duration: minutes,
    eventTypeId, eventType: { id: eventTypeId, slug: eventTypes.find(e => e.id === eventTypeId).slug },
    location: 'https://cal.example.com/video/abc', absentHost: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    attendees: [
      { id: 1, name: 'John Doe', email: 'john@example.com', timeZone: 'Asia/Kuala_Lumpur', absent: false },
      { id: 2, name: 'Jane Tan', email: 'jane@example.com', timeZone: 'Asia/Singapore', absent: false },
    ],
    guests: [], bookingFieldsResponses: { company: 'TechMavie' },
    ...extra,
  };
}

const bookings = new Map();
for (const booking of [
  makeBooking('up1', at(2, '10:00'), 30, 'accepted', 101),
  makeBooking('pend1', at(3, '14:00'), 30, 'pending', 101),
  makeBooking('past1', at(-3, '11:00'), 60, 'accepted', 102, {
    attendees: [{ id: 3, name: 'John Doe', email: 'john@example.com', timeZone: 'Asia/Kuala_Lumpur', absent: true }],
  }),
  makeBooking('canc1', at(-2, '15:00'), 30, 'cancelled', 101, { cancellationReason: 'Client sick' }),
]) bookings.set(booking.uid, booking);

const schedules = new Map([[11, {
  id: 11, ownerId: 7, name: 'Working hours', timeZone: 'Asia/Kuala_Lumpur', isDefault: true,
  availability: [{ days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], startTime: '09:00', endTime: '17:00' }],
  overrides: [{ date: '2099-01-02', startTime: '10:00', endTime: '12:00' }],
}]]);

const webhooks = new Map([[5, { id: 5, userId: 7, subscriberUrl: 'https://hooks.example.com/cal', triggers: ['BOOKING_CREATED'], active: true, payloadTemplate: null, secret: 'super-secret' }]]);
const privateLinks = new Map([[101, [{ linkId: 'pl1', eventTypeId: 101, isExpired: false, bookingUrl: 'https://book.example.com/d/pl1/30min', maxUsageCount: 1, usageCount: 0 }]]]);

/** Open slots: 09:00, 09:30, 10:00 and 14:00 Kuala Lumpur time, Monday–Saturday, in the future */
function slotsFor(startIso, endIso) {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const slots = {};
  for (let day = klDate(start); day <= klDate(end); day = klDate(addDaysUtc(klInstant(day, '12:00'), 1))) {
    const weekday = klInstant(day, '12:00').getUTCDay();
    const times = weekday === 0 ? [] : ['09:00', '09:30', '10:00', '14:00']
      .map(time => klInstant(day, time))
      .filter(time => time >= start && time <= end && time.getTime() > Date.now());
    if (times.length) slots[day] = times.map(time => ({ start: `${day}T${new Date(time.getTime() + KL_OFFSET_MS).toISOString().slice(11, 23)}+08:00` }));
  }
  return slots;
}

function filterBookings(query) {
  const now = Date.now();
  const statuses = (query.get('status') ?? '').split(',').filter(Boolean);
  const matches = booking => {
    const ended = new Date(booking.end).getTime() <= now;
    const active = !['cancelled', 'rejected'].includes(booking.status);
    return statuses.some(status => (
      (status === 'upcoming' && !ended && active) ||
      (status === 'unconfirmed' && !ended && booking.status === 'pending') ||
      (status === 'past' && ended && active) ||
      (status === 'cancelled' && !active)
    ));
  };
  let list = [...bookings.values()].filter(booking => !statuses.length || matches(booking));
  if (query.get('afterStart')) list = list.filter(booking => booking.start >= new Date(query.get('afterStart')).toISOString());
  if (query.get('beforeEnd')) list = list.filter(booking => booking.end <= new Date(query.get('beforeEnd')).toISOString());
  if (query.get('eventTypeId')) list = list.filter(booking => booking.eventTypeId === Number(query.get('eventTypeId')));
  if (query.get('attendeeEmail')) list = list.filter(booking => booking.attendees.some(attendee => attendee.email === query.get('attendeeEmail')));
  list.sort((a, b) => (query.get('sortStart') === 'desc' ? -1 : 1) * a.start.localeCompare(b.start));
  const take = Number(query.get('take') ?? 100);
  const skip = Number(query.get('skip') ?? 0);
  const page = list.slice(skip, skip + take);
  return { page, pagination: { totalItems: list.length, returnedItems: page.length, itemsPerPage: take, hasNextPage: skip + take < list.length, hasPreviousPage: skip > 0 } };
}

const VERSIONED = [
  [/^\/bookings(\/|$)/, '2024-08-13'],
  [/^\/event-types(\/\d+)?$/, '2024-06-14'],
  [/^\/schedules(\/|$)/, '2024-06-11'],
  [/^\/slots(\/|$)/, '2024-09-04'],
];

const calRequests = [];

const calApi = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fake');
  const raw = await readBody(req);
  const body = raw ? JSON.parse(raw) : undefined;
  const version = req.headers['cal-api-version'];

  if (!url.pathname.startsWith('/api/v2/')) {
    return res.writeHead(404, { 'Content-Type': 'text/html' }).end('<!DOCTYPE html><html><body>404 web app</body></html>');
  }
  const route = url.pathname.slice('/api/v2'.length);
  calRequests.push({ method: req.method, route, query: url.searchParams, body, version, auth: req.headers.authorization });

  if (req.headers.authorization !== `Bearer ${CAL_KEY}`) {
    return fail(res, 401, 'UnauthorizedException', 'ApiAuthStrategy - api key - Your api key is not valid');
  }

  // Like Cal: versioned controllers only match their version; private links only the default version
  const required = VERSIONED.find(([pattern]) => pattern.test(route))?.[1];
  if (required && version !== required) return fail(res, 404, 'NotFoundException', `Cannot ${req.method} /v2${route} (cal-api-version ${version ?? 'missing'})`);
  if (/^\/event-types\/\d+\/private-links/.test(route) && version && version !== '2024-04-15') {
    return fail(res, 404, 'NotFoundException', `Cannot ${req.method} /v2${route} (cal-api-version ${version})`);
  }

  const parts = route.split('/').filter(Boolean);
  const key = `${req.method} /${parts.map(part => (/^\d+$/.test(part) ? ':id' : part)).join('/')}`;
  const bookingFromPath = () => bookings.get(decodeURIComponent(parts[1]));

  switch (key) {
    case 'GET /me': return ok(res, me);
    case 'PATCH /me': Object.assign(me, body); return ok(res, me);

    case 'GET /event-types': return ok(res, eventTypes);
    case 'GET /event-types/:id': {
      const eventType = eventTypes.find(candidate => candidate.id === Number(parts[1]));
      return eventType ? ok(res, eventType) : fail(res, 404, 'NotFoundException', 'Event type not found');
    }
    case 'POST /event-types': {
      const created = { id: 103, hidden: false, metadata: {}, bookingFields: [], locations: [], bookingUrl: `https://book.example.com/aliff/${body.slug}`, ...body };
      return json(res, 201, { status: 'success', data: created });
    }
    case 'PATCH /event-types/:id': {
      const eventType = eventTypes.find(candidate => candidate.id === Number(parts[1]));
      return ok(res, { ...eventType, ...body });
    }
    case 'DELETE /event-types/:id': return ok(res, { id: Number(parts[1]) });
    case 'GET /event-types/:id/private-links': return ok(res, privateLinks.get(Number(parts[1])) ?? []);
    case 'POST /event-types/:id/private-links': {
      const link = { linkId: 'pl2', eventTypeId: Number(parts[1]), isExpired: false, bookingUrl: 'https://book.example.com/d/pl2/30min', maxUsageCount: body.maxUsageCount ?? 1, usageCount: 0, ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}) };
      return json(res, 201, { status: 'success', data: link });
    }
    case 'DELETE /event-types/:id/private-links/pl1': return ok(res, { linkId: 'pl1' });

    case 'GET /bookings': {
      const { page, pagination } = filterBookings(url.searchParams);
      return ok(res, page, { pagination });
    }
    case 'POST /bookings': {
      if (!body?.start || !body.attendee?.email || !body.attendee?.timeZone) return fail(res, 400, 'BadRequestException', 'Bad Request Exception');
      const eventType = eventTypes.find(candidate => candidate.id === body.eventTypeId);
      const created = makeBooking('new1', new Date(body.start), body.lengthInMinutes ?? eventType.lengthInMinutes, eventType.confirmationPolicy ? 'pending' : 'accepted', eventType.id, {
        attendees: [{ id: 9, name: body.attendee.name, email: body.attendee.email, timeZone: body.attendee.timeZone, absent: false }],
        guests: body.guests ?? [],
        location: 'integrations:daily',
      });
      bookings.set(created.uid, created);
      return json(res, 201, { status: 'success', data: created });
    }
    default:
      break;
  }

  if (parts[0] === 'bookings' && parts[1] && parts[1] !== 'by-seat') {
    const booking = bookingFromPath();
    if (!booking) return fail(res, 404, 'NotFoundException', 'booking_not_found_error');
    const action = parts.slice(2).join('/');
    switch (`${req.method} ${action}`) {
      case 'GET ': return ok(res, booking);
      case 'POST reschedule': {
        const moved = { ...booking, uid: 'moved1', start: new Date(body.start).toISOString(), end: new Date(new Date(body.start).getTime() + booking.duration * 60_000).toISOString(), rescheduledFromUid: booking.uid, reschedulingReason: body.reschedulingReason ?? null };
        bookings.set(moved.uid, moved);
        return json(res, 201, { status: 'success', data: moved });
      }
      case 'POST cancel': booking.status = 'cancelled'; booking.cancellationReason = body?.cancellationReason ?? null; return ok(res, booking);
      case 'POST confirm': booking.status = 'accepted'; return ok(res, booking);
      case 'POST decline': booking.status = 'rejected'; return ok(res, booking);
      case 'POST mark-absent':
        if (body.host !== undefined) booking.absentHost = body.host;
        for (const { email, absent } of body.attendees ?? []) {
          const attendee = booking.attendees.find(candidate => candidate.email === email);
          if (attendee) attendee.absent = absent;
        }
        return ok(res, booking);
      case 'POST guests': booking.guests = [...booking.guests, ...body.guests.map(guest => guest.email)]; return ok(res, booking);
      case 'GET attendees': return ok(res, booking.attendees);
      case 'PATCH location': booking.location = body.location.link ?? body.location.address ?? body.location.integration; return ok(res, booking);
      case 'GET calendar-links': return ok(res, [{ label: 'Google', link: 'https://calendar.google.com/x' }]);
      case 'GET references': return ok(res, [{ id: 1, type: 'google_calendar', eventUid: 'g123', destinationCalendarId: 'primary' }]);
      case 'GET recordings': return fail(res, 400, 'BadRequestException', 'Cal Video is not configured');
      default:
        if (req.method === 'DELETE' && /^attendees\/\d+$/.test(action)) {
          booking.attendees = booking.attendees.filter(attendee => attendee.id !== Number(parts[3]));
          return ok(res, { id: Number(parts[3]) });
        }
        return fail(res, 404, 'NotFoundException', `Cannot ${req.method} ${route}`);
    }
  }

  switch (key) {
    case 'GET /slots': {
      if (!url.searchParams.get('timeZone')) return fail(res, 400, 'BadRequestException', 'timeZone missing');
      return ok(res, slotsFor(url.searchParams.get('start'), url.searchParams.get('end')));
    }
    case 'GET /schedules': return ok(res, [...schedules.values()]);
    case 'GET /schedules/default': return ok(res, schedules.get(11));
    case 'GET /schedules/:id': return schedules.has(Number(parts[1])) ? ok(res, schedules.get(Number(parts[1]))) : fail(res, 404, 'NotFoundException', 'Schedule not found');
    case 'POST /schedules': {
      const created = { id: 12, ownerId: 7, availability: [{ days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], startTime: '09:00', endTime: '17:00' }], overrides: [], ...body };
      schedules.set(12, created);
      return json(res, 201, { status: 'success', data: created });
    }
    case 'PATCH /schedules/:id': {
      const updated = { ...schedules.get(Number(parts[1])), ...body };
      schedules.set(updated.id, updated);
      return ok(res, updated);
    }
    case 'DELETE /schedules/:id': schedules.delete(Number(parts[1])); return ok(res, { id: Number(parts[1]) });

    case 'GET /calendars': return ok(res, {
      connectedCalendars: [{
        integration: { name: 'Google Calendar', title: 'Google Calendar', slug: 'google-calendar', type: 'google_calendar' },
        credentialId: 21,
        calendars: [
          { externalId: 'hello@example.com', name: 'Work', primary: true, readOnly: false, isSelected: true, credentialId: 21 },
          { externalId: 'holidays@group.v.calendar.google.com', name: 'Holidays', primary: false, readOnly: true, isSelected: false, credentialId: 21 },
        ],
      }],
      destinationCalendar: { integration: 'google_calendar', externalId: 'hello@example.com', name: 'Work', integrationTitle: 'Google Calendar' },
    });
    case 'GET /calendars/busy-times': {
      if (url.searchParams.get('calendarsToLoad[0][credentialId]') !== '21' || url.searchParams.get('calendarsToLoad[0][externalId]') !== 'hello@example.com' || !url.searchParams.get('timeZone')) {
        return fail(res, 400, 'BadRequestException', 'calendarsToLoad and timeZone are required');
      }
      return ok(res, [{ start: at(1, '13:00').toISOString(), end: at(1, '14:00').toISOString(), source: 'google' }]);
    }
    case 'GET /calendars/google/events': return ok(res, [{
      id: 'evt1', title: 'Dentist', start: { time: at(1, '08:00').toISOString(), timeZone: 'Asia/Kuala_Lumpur' }, end: { time: at(1, '09:00').toISOString(), timeZone: 'Asia/Kuala_Lumpur' },
      status: 'accepted', attendees: [{ email: 'hello@example.com', self: true }], source: 'google',
    }]);

    case 'GET /conferencing': return ok(res, [{ id: 31, type: 'google_video', userId: 7, invalid: false }]);
    case 'GET /conferencing/default': return ok(res, { appSlug: 'google-meet' });
    case 'POST /conferencing/zoom/default': return ok(res, null);

    case 'GET /webhooks': return ok(res, [...webhooks.values()]);
    case 'GET /webhooks/:id': return webhooks.has(Number(parts[1])) ? ok(res, webhooks.get(Number(parts[1]))) : fail(res, 404, 'NotFoundException', 'Webhook not found');
    case 'POST /webhooks': {
      const created = { id: 6, userId: 7, payloadTemplate: null, ...body };
      webhooks.set(6, created);
      return json(res, 201, { status: 'success', data: created });
    }
    case 'PATCH /webhooks/:id': {
      const updated = { ...webhooks.get(Number(parts[1])), ...body };
      webhooks.set(updated.id, updated);
      return ok(res, updated);
    }
    case 'DELETE /webhooks/:id': webhooks.delete(Number(parts[1])); return ok(res, { id: Number(parts[1]) });
    case 'GET /event-types/:id/webhooks': return ok(res, []);
    default:
      return fail(res, 404, 'NotFoundException', `Cannot ${req.method} /v2${route}`);
  }
});

// Fake web app: every path is an HTML 404 (like book.techmavie.digital without API v2)
const webApp = http.createServer((_req, res) => res.writeHead(404, { 'Content-Type': 'text/html' }).end('<!DOCTYPE html><html><body>This page could not be found.</body></html>'));

// =============================================================================
// Fake MCP Key Service
// =============================================================================

let calUrl;
let webUrl;
const keyServiceRequests = [];

const keyService = http.createServer(async (req, res) => {
  const body = JSON.parse((await readBody(req)) || '{}');
  keyServiceRequests.push(body);
  if (req.headers.authorization !== `Bearer ${SERVER_TOKEN}`) return json(res, 403, { valid: false, error: 'Unauthorized' });

  const credentials = {
    [KEYS.read]: { calcom_api_url: calUrl, calcom_api_key: CAL_KEY, calcom_access: '' },
    [KEYS.bookings]: { calcom_api_url: calUrl, calcom_api_key: CAL_KEY, calcom_access: 'bookings' },
    [KEYS.full]: { calcom_api_url: `${calUrl}/api/v2`, calcom_api_key: CAL_KEY, calcom_access: 'full' },
    [KEYS.privateUrl]: { calcom_api_url: 'http://10.0.0.1:5555', calcom_api_key: CAL_KEY },
    [KEYS.webApp]: { calcom_api_url: webUrl, calcom_api_key: CAL_KEY },
    [KEYS.badCalKey]: { calcom_api_url: calUrl, calcom_api_key: 'cal_wrong' },
    [KEYS.uncached]: { calcom_api_url: calUrl, calcom_api_key: CAL_KEY },
  }[body.key];

  if (!credentials) return json(res, 401, { valid: false, error: 'Invalid, revoked, or suspended API key, or server not authorized' });
  return json(res, 200, { valid: true, credentials, label: 'test', connector_id: 'calcom' });
});

// =============================================================================
// Run
// =============================================================================

const calPort = await listen(calApi);
const webPort = await listen(webApp);
const keyServicePort = await listen(keyService);
calUrl = `http://127.0.0.1:${calPort}`;
webUrl = `http://127.0.0.1:${webPort}`;

const probe = http.createServer();
const mcpPort = await listen(probe);
await new Promise(resolve => probe.close(resolve));

const analyticsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calcom-mcp-smoke-'));
const serverProcess = spawn(process.execPath, [path.join(ROOT, 'dist/http-server.js')], {
  env: {
    ...process.env,
    PORT: String(mcpPort),
    HOST: '127.0.0.1',
    MCP_API_KEY: ADMIN_KEY,
    KEY_SERVICE_URL: `http://127.0.0.1:${keyServicePort}/internal/resolve`,
    KEY_SERVICE_TOKEN: SERVER_TOKEN,
    ALLOW_PRIVATE_CALCOM_HOSTS: '127.0.0.1',
    ANALYTICS_DIR: analyticsDir,
    FIREBASE_SERVICE_ACCOUNT_PATH: path.join(analyticsDir, 'missing.json'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
serverProcess.stdout.on('data', chunk => (serverLog += chunk));
serverProcess.stderr.on('data', chunk => (serverLog += chunk));

const mcpBase = `http://127.0.0.1:${mcpPort}`;

async function shutdown(code) {
  serverProcess.kill();
  calApi.close();
  webApp.close();
  keyService.close();
  fs.rmSync(analyticsDir, { recursive: true, force: true });
  process.exit(code);
}

async function waitForHealth() {
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(`${mcpBase}/health`);
      if (res.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become healthy.\n${serverLog}`);
}

async function connect(url, headers) {
  const client = new Client({ name: 'smoke-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), headers ? { requestInit: { headers } } : undefined));
  return client;
}

const text = result => result.content.map(item => item.text).join('\n');
const lastCal = (method, route) => [...calRequests].reverse().find(request => request.method === method && (route instanceof RegExp ? route.test(request.route) : request.route === route));
const countCal = (method, route) => calRequests.filter(request => request.method === method && request.route === route).length;

async function rawPost(url, headers = {}, method = 'POST') {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: method === 'POST' ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

try {
  await waitForHealth();

  // ---------------------------------------------------------------------------
  console.log('\nHosted key-service mode (path), read access');
  const reader = await connect(`${mcpBase}/mcp/${KEYS.read}`);
  const readTools = (await reader.listTools()).tools;

  await check('17 read-only tools, no write tools', () => {
    assert.equal(readTools.length, 17);
    assert.ok(readTools.every(tool => tool.annotations.readOnlyHint === true));
    for (const name of ['create_booking', 'cancel_booking', 'create_event_type', 'create_private_link']) {
      assert.ok(!readTools.some(tool => tool.name === name), `should not expose ${name}`);
    }
  });

  await check('hello reports the connection without calling Cal', async () => {
    const before = calRequests.length;
    const output = text(await reader.callTool({ name: 'hello', arguments: {} }));
    assert.match(output, /"access_level": "read"/);
    assert.match(output, new RegExp(`"api_url": "${calUrl}/api/v2"`));
    assert.equal(calRequests.length, before);
  });

  await check('get_my_profile', async () => {
    const output = text(await reader.callTool({ name: 'get_my_profile', arguments: {} }));
    assert.match(output, /Time zone: Asia\/Kuala_Lumpur/);
    assert.equal(lastCal('GET', '/me').auth, `Bearer ${CAL_KEY}`);
  });

  await check('list_event_types sends cal-api-version 2024-06-14 and shows HitPay prices', async () => {
    const output = text(await reader.callTool({ name: 'list_event_types', arguments: {} }));
    assert.match(output, /\| 101 \| 30 Min Meeting \| 30 min \| free \| listed \|/);
    assert.match(output, /Paid Consultation \| 1 h \| MYR\s50\.00 \(hitpay\) \| hidden \| required/);
    assert.equal(lastCal('GET', '/event-types').version, '2024-06-14');
  });

  await check('get_event_type describes settings and the booking form', async () => {
    const output = text(await reader.callTool({ name: 'get_event_type', arguments: { event_type_id: 101 } }));
    assert.match(output, /minimum notice 2 h, 10 min buffer after/);
    assert.match(output, /\| company \| text \| Company \|/);
  });

  await check('list_private_links sends no version header (Cal 404s otherwise)', async () => {
    const output = text(await reader.callTool({ name: 'list_private_links', arguments: { event_type_id: 101 } }));
    assert.match(output, /pl1/);
    assert.equal(lastCal('GET', '/event-types/101/private-links').version, undefined);
  });

  await check('list_bookings defaults to upcoming + unconfirmed, as an agenda', async () => {
    const output = text(await reader.callTool({ name: 'list_bookings', arguments: {} }));
    assert.match(output, /## Upcoming bookings · Asia\/Kuala_Lumpur/);
    assert.match(output, /10:00–10:30 · 30 Min Meeting between Aliff and John Doe · John Doe <john@example\.com>, Jane Tan <jane@example\.com> · accepted · https:\/\/cal\.example\.com\/video\/abc · uid `up1`/);
    assert.match(output, /\*\*pending confirmation\*\*.*uid `pend1`/);
    assert.doesNotMatch(output, /canc1|past1/);
    const request = lastCal('GET', '/bookings');
    assert.equal(request.query.get('status'), 'upcoming,unconfirmed');
    assert.equal(request.version, '2024-08-13');
  });

  await check('list_bookings date ranges exclude cancelled bookings by default', async () => {
    await reader.callTool({ name: 'list_bookings', arguments: { when: 'past_7_days' } });
    const request = lastCal('GET', '/bookings');
    assert.equal(request.query.get('status'), 'upcoming,past,unconfirmed');
    assert.ok(request.query.get('afterStart') && request.query.get('beforeEnd'));
    const cancelled = text(await reader.callTool({ name: 'list_bookings', arguments: { when: 'cancelled' } }));
    assert.match(cancelled, /uid `canc1`/);
  });

  await check('get_booking with attendees, calendar links and a failing include', async () => {
    const output = text(await reader.callTool({ name: 'get_booking', arguments: { booking_uid: 'up1', include: ['attendees', 'calendar_links', 'recordings'] } }));
    assert.match(output, /Attendee: Jane Tan <jane@example\.com> \(Asia\/Singapore, attendee id 2\)/);
    assert.match(output, /company: TechMavie/);
    assert.match(output, /Google: https:\/\/calendar\.google\.com\/x/);
    assert.match(output, /### recordings\n_Unavailable: Cal Video is not configured_/);
  });

  await check('get_booking_summary computes stats and revenue client-side', async () => {
    const output = text(await reader.callTool({ name: 'get_booking_summary', arguments: { period: 'past_7_days' } }));
    assert.match(output, /\| bookings \(not cancelled\) \| 1 \| 0 \| new \|/);
    assert.match(output, /\| cancelled \/ declined \| 1 \(50%\) \|/);
    assert.match(output, /\| attendee no-shows \| 1 \|/);
    assert.match(output, /MYR\s50\.00/);
    assert.match(output, /Client sick \(1\)/);
  });

  let firstSlot;
  await check('get_available_slots sends 2024-09-04 + time zone and lists every day', async () => {
    const output = text(await reader.callTool({ name: 'get_available_slots', arguments: { event_type_id: 101, days: 3 } }));
    assert.match(output, /## Available slots · 30 Min Meeting \(id 101, 30 min\)/);
    assert.equal(output.split('\n').filter(line => line.startsWith('- ')).length, 3);
    const request = lastCal('GET', '/slots');
    assert.equal(request.version, '2024-09-04');
    assert.equal(request.query.get('timeZone'), 'Asia/Kuala_Lumpur');
    assert.equal(request.query.get('eventTypeId'), '101');
    const data = JSON.parse(text(await reader.callTool({ name: 'get_available_slots', arguments: { event_type_id: 101, format: 'json' } })));
    firstSlot = Object.values(data.slots).flat()[0];
    assert.match(firstSlot.start, /\+08:00$/);
  });

  await check('calendars: connected calendars, busy times (qs query) and Google events', async () => {
    assert.match(text(await reader.callTool({ name: 'list_calendars', arguments: {} })), /Work \| hello@example\.com \| yes \| yes/);
    const busy = text(await reader.callTool({ name: 'get_busy_times', arguments: { days: undefined } }));
    assert.match(busy, /13:00–14:00/);
    assert.match(busy, /1 calendar\(s\) checked/);
    assert.match(text(await reader.callTool({ name: 'list_calendar_events', arguments: {} })), /08:00–09:00 · Dentist/);
  });

  await check('schedules, video apps and webhooks (secrets never shown)', async () => {
    assert.match(text(await reader.callTool({ name: 'get_schedule', arguments: {} })), /Mon–Fri 09:00–17:00/);
    assert.equal(lastCal('GET', '/schedules/default').version, '2024-06-11');
    assert.match(text(await reader.callTool({ name: 'list_conferencing_apps', arguments: {} })), /Google Meet \| google_video/);
    const hooks = text(await reader.callTool({ name: 'list_webhooks', arguments: { format: 'json' } }));
    assert.match(hooks, /"has_secret": true/);
    assert.doesNotMatch(hooks, /super-secret/);
  });

  await check('get_instance_info: account, counts, calendars, rate limit', async () => {
    const output = text(await reader.callTool({ name: 'get_instance_info', arguments: {} }));
    assert.match(output, /API key: ok — Aliff \(aliff, hello@example\.com\)/);
    assert.match(output, /Event types: 2 \(1 hidden\)/);
    assert.match(output, /Google Calendar: 2 calendar\(s\), 1 checked for conflicts/);
    assert.match(output, /117 of 120 requests left/);
    assert.match(output, /Cal\.diy has no teams/);
  });
  await reader.close();

  // ---------------------------------------------------------------------------
  console.log('\nHosted key-service mode (query), bookings access');
  const booker = await connect(`${mcpBase}/mcp?api_key=${KEYS.bookings}`);
  const bookerTools = (await booker.listTools()).tools;

  await check('28 tools: + booking actions and private links, no configuration tools', () => {
    assert.equal(bookerTools.length, 28);
    assert.ok(bookerTools.some(tool => tool.name === 'create_booking'));
    assert.ok(!bookerTools.some(tool => tool.name === 'create_event_type'));
    assert.equal(bookerTools.find(tool => tool.name === 'cancel_booking').annotations.destructiveHint, true);
  });

  await check('create_booking refuses a time that is not an open slot (and suggests slots)', async () => {
    const before = countCal('POST', '/bookings');
    const start = new Date(new Date(firstSlot.start_utc).getTime() + 15 * 60_000);
    const result = await booker.callTool({
      name: 'create_booking',
      arguments: { event_type_id: 101, start: start.toISOString(), attendee: { name: 'Sam Lee', email: 'sam@example.com' } },
    });
    assert.equal(result.isError, true);
    assert.match(text(result), /is not an open slot/);
    assert.match(text(result), /Open times that day: /);
    assert.equal(countCal('POST', '/bookings'), before, 'nothing may be booked');
  });

  await check('create_booking refuses paid event types unless allow_unpaid', async () => {
    const result = await booker.callTool({
      name: 'create_booking',
      arguments: { event_type_id: 102, start: firstSlot.start, attendee: { name: 'Sam Lee', email: 'sam@example.com' } },
    });
    assert.equal(result.isError, true);
    assert.match(text(result), /paid event type \(MYR\s50\.00 via hitpay\)/);
    assert.match(text(result), /https:\/\/book\.example\.com\/aliff\/paid/);
  });

  await check('create_booking books an open slot with local wall time + defaults', async () => {
    const local = firstSlot.start.slice(0, 16).replace('T', ' ');
    const result = await booker.callTool({
      name: 'create_booking',
      arguments: { event_type_id: 101, start: local, attendee: { name: 'Sam Lee', email: 'sam@example.com' }, guests: ['boss@example.com'], notes: 'Agenda: pricing', booking_fields: { company: 'Acme' } },
    });
    const output = text(result);
    assert.ok(!result.isError, output);
    assert.match(output, /## Booked: 30 Min Meeting/);
    assert.match(output, /uid: `new1`/);
    const request = lastCal('POST', '/bookings');
    assert.equal(request.version, '2024-08-13');
    assert.equal(request.body.start, firstSlot.start_utc);
    assert.equal(request.body.eventTypeId, 101);
    assert.equal(request.body.attendee.timeZone, 'Asia/Kuala_Lumpur');
    assert.deepEqual(request.body.guests, ['boss@example.com']);
    assert.deepEqual(request.body.bookingFieldsResponses, { company: 'Acme', notes: 'Agenda: pricing' });
  });

  await check('reschedule_booking checks slots for the booking and moves it', async () => {
    const result = await booker.callTool({ name: 'reschedule_booking', arguments: { booking_uid: 'up1', start: firstSlot.start, reason: 'Clash' } });
    const output = text(result);
    assert.ok(!result.isError, output);
    assert.match(output, /## Rescheduled/);
    assert.match(output, /new uid `moved1`|Use the new uid `moved1`/);
    assert.equal(lastCal('GET', '/slots').query.get('bookingUidToReschedule'), 'up1');
    assert.deepEqual(lastCal('POST', '/bookings/up1/reschedule').body, { start: firstSlot.start_utc, reschedulingReason: 'Clash' });
  });

  await check('cancel_booking needs confirm, then sends the reason', async () => {
    const refused = await booker.callTool({ name: 'cancel_booking', arguments: { booking_uid: 'pend1' } });
    assert.equal(refused.isError, true);
    assert.equal(countCal('POST', '/bookings/pend1/cancel'), 0);
    const output = text(await booker.callTool({ name: 'cancel_booking', arguments: { booking_uid: 'pend1', reason: 'No longer needed', confirm: true } }));
    assert.match(output, /## Cancelled/);
    assert.deepEqual(lastCal('POST', '/bookings/pend1/cancel').body, { cancellationReason: 'No longer needed' });
  });

  await check('confirm / decline / no-show / guests / location', async () => {
    assert.match(text(await booker.callTool({ name: 'confirm_booking', arguments: { booking_uid: 'new1' } })), /## Confirmed/);
    assert.equal((await booker.callTool({ name: 'decline_booking', arguments: { booking_uid: 'new1' } })).isError, true);
    assert.match(text(await booker.callTool({ name: 'mark_no_show', arguments: { booking_uid: 'past1', attendees: [{ email: 'john@example.com' }] } })), /Absent: john@example\.com/);
    await booker.callTool({ name: 'add_booking_guests', arguments: { booking_uid: 'new1', guests: [{ email: 'cfo@example.com', time_zone: 'Europe/London' }] } });
    assert.deepEqual(lastCal('POST', '/bookings/new1/guests').body, { guests: [{ email: 'cfo@example.com', timeZone: 'Europe/London' }] });
    assert.match(text(await booker.callTool({ name: 'update_booking_location', arguments: { booking_uid: 'new1', location: { type: 'link', value: 'https://zoom.us/j/1' } } })), /Location: https:\/\/zoom\.us\/j\/1/);
    assert.equal(lastCal('PATCH', '/bookings/new1/location').version, '2024-08-13');
  });

  await check('remove_booking_attendee protects the primary attendee', async () => {
    const primary = await booker.callTool({ name: 'remove_booking_attendee', arguments: { booking_uid: 'moved1', attendee_email: 'john@example.com', confirm: true } });
    assert.equal(primary.isError, true);
    assert.match(text(primary), /primary attendee/);
    assert.match(text(await booker.callTool({ name: 'remove_booking_attendee', arguments: { booking_uid: 'moved1', attendee_email: 'jane@example.com', confirm: true } })), /Removed Jane Tan/);
  });

  await check('create_private_link (single use by default, no version header)', async () => {
    const output = text(await booker.callTool({ name: 'create_private_link', arguments: { event_type_id: 101 } }));
    assert.match(output, /URL: https:\/\/book\.example\.com\/d\/pl2\/30min/);
    const request = lastCal('POST', '/event-types/101/private-links');
    assert.equal(request.version, undefined);
    assert.deepEqual(request.body, {});
  });
  await booker.close();

  // ---------------------------------------------------------------------------
  console.log('\nHosted key-service mode (Bearer header), full access');
  const admin = await connect(`${mcpBase}/mcp`, { Authorization: `Bearer ${KEYS.full}` });

  await check('39 tools with full access', async () => {
    assert.equal((await admin.listTools()).tools.length, 39);
  });

  await check('create_event_type maps friendly fields', async () => {
    const output = text(await admin.callTool({
      name: 'create_event_type',
      arguments: { title: 'Strategy Session!', length_in_minutes: 45, requires_confirmation: true, booking_window_days: 30, locations: [{ type: 'integration', value: 'google-meet' }] },
    }));
    assert.match(output, /Created\./);
    const request = lastCal('POST', '/event-types');
    assert.equal(request.version, '2024-06-14');
    assert.deepEqual(request.body, {
      title: 'Strategy Session!', slug: 'strategy-session', lengthInMinutes: 45,
      locations: [{ type: 'integration', integration: 'google-meet' }],
      confirmationPolicy: { type: 'always', blockUnconfirmedBookingsInBooker: true },
      bookingWindow: { type: 'calendarDays', value: 30, rolling: true },
    });
  });

  await check('update_schedule blocks a date while keeping other overrides', async () => {
    const output = text(await admin.callTool({ name: 'update_schedule', arguments: { block_dates: ['2099-12-25'] } }));
    assert.match(output, /Fri 25 Dec 2099: unavailable all day/);
    assert.deepEqual(lastCal('PATCH', '/schedules/11').body.overrides, [
      { date: '2099-01-02', startTime: '10:00', endTime: '12:00' },
      { date: '2099-12-25', startTime: '00:00', endTime: '00:00' },
    ]);
  });

  await check('update_my_profile validates the time zone and updates the profile', async () => {
    assert.equal((await admin.callTool({ name: 'update_my_profile', arguments: { time_zone: 'Mars/Olympus' } })).isError, true);
    assert.match(text(await admin.callTool({ name: 'update_my_profile', arguments: { week_start: 'Sunday', time_format: 12 } })), /Clock: 12-hour/);
    assert.deepEqual(lastCal('PATCH', '/me').body, { weekStart: 'Sunday', timeFormat: 12 });
  });

  await check('webhooks and default video app', async () => {
    assert.match(text(await admin.callTool({ name: 'create_webhook', arguments: { subscriber_url: 'https://hooks.example.com/new' } })), /BOOKING_CREATED, BOOKING_RESCHEDULED, BOOKING_CANCELLED/);
    assert.equal((await admin.callTool({ name: 'delete_webhook', arguments: { webhook_id: 6 } })).isError, true);
    assert.match(text(await admin.callTool({ name: 'delete_webhook', arguments: { webhook_id: 6, confirm: true } })), /Webhook 6 deleted/);
    assert.match(text(await admin.callTool({ name: 'set_default_conferencing_app', arguments: { app: 'zoom' } })), /Zoom is now the default/);
  });
  await admin.close();

  // ---------------------------------------------------------------------------
  console.log('\nSelf-hosted header mode');
  await check('X-API-Key + X-Calcom-* headers', async () => {
    const client = await connect(`${mcpBase}/mcp`, { 'X-API-Key': ADMIN_KEY, 'X-Calcom-Api-Key': CAL_KEY, 'X-Calcom-Api-Url': calUrl, 'X-Calcom-Access': 'bookings' });
    assert.equal((await client.listTools()).tools.length, 28);
    assert.match(text(await client.callTool({ name: 'list_event_types', arguments: {} })), /30 Min Meeting/);
    await client.close();
  });

  // ---------------------------------------------------------------------------
  console.log('\nDiagnosing bad connections');
  await check('an API URL that serves the web app is diagnosed as "not API v2"', async () => {
    const client = await connect(`${mcpBase}/mcp/${KEYS.webApp}`);
    const info = text(await client.callTool({ name: 'get_instance_info', arguments: {} }));
    assert.match(info, /API key: failed — .*HTML page/);
    assert.match(info, /API v2 is not deployed there/);
    const result = await client.callTool({ name: 'list_event_types', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(text(result), /not Cal API v2/);
    await client.close();
  });

  await check('a wrong Cal API key surfaces a 401 with a fix', async () => {
    const client = await connect(`${mcpBase}/mcp/${KEYS.badCalKey}`);
    const result = await client.callTool({ name: 'list_bookings', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(text(result), /Cal\.com API error \(401\)/);
    assert.match(text(result), /Settings → Developer → API Keys/);
    await client.close();
  });

  // ---------------------------------------------------------------------------
  console.log('\nHTTP auth & safety');
  await check('invalid user key → 403', async () => {
    const { status, body } = await rawPost(`${mcpBase}/mcp/${KEYS.invalid}`);
    assert.equal(status, 403);
    assert.equal(body.error.data.reason, 'invalid_key');
  });
  await check('malformed user key → 403 without calling the key service', async () => {
    const before = keyServiceRequests.length;
    assert.equal((await rawPost(`${mcpBase}/mcp/usr_123`)).status, 403);
    assert.equal(keyServiceRequests.length, before);
  });
  await check('no credentials → 401; raw Cal key in the URL → 401 with guidance', async () => {
    assert.equal((await rawPost(`${mcpBase}/mcp`)).status, 401);
    const raw = await rawPost(`${mcpBase}/mcp?apiKey=${CAL_KEY}`);
    assert.equal(raw.status, 401);
    assert.match(raw.body.error.message, /not accepted/);
  });
  await check('wrong X-API-Key → 403', async () => {
    assert.equal((await rawPost(`${mcpBase}/mcp`, { 'X-API-Key': 'wrong', 'X-Calcom-Api-Key': CAL_KEY })).status, 403);
  });
  await check('JSON-only clients get JSON, SSE clients get SSE', async () => {
    const call = accept => fetch(`${mcpBase}/mcp/${KEYS.read}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: accept },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const jsonOnly = await call('application/json');
    assert.match(jsonOnly.headers.get('content-type'), /application\/json/);
    assert.equal((await jsonOnly.json()).result.tools.length, 17);
    const sse = await call('application/json, text/event-stream');
    assert.match(sse.headers.get('content-type'), /text\/event-stream/);
    await sse.text();
  });
  await check('tool calls inside JSON-RPC batches are counted', async () => {
    const totals = async () => (await (await fetch(`${mcpBase}/analytics`, { headers: { 'X-API-Key': ADMIN_KEY } })).json()).summary.totalToolCalls;
    const before = await totals();
    const call = id => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'hello', arguments: {} } });
    const res = await fetch(`${mcpBase}/mcp/${KEYS.read}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify([call(1), call(2)]),
    });
    await res.text();
    assert.equal((await totals()) - before, 2);
  });
  await check('GET on the stateless endpoint → 405', async () => {
    assert.equal((await rawPost(`${mcpBase}/mcp/${KEYS.read}`, {}, 'GET')).status, 405);
  });
  await check('private API URLs are rejected (SSRF guard)', async () => {
    const { status, body } = await rawPost(`${mcpBase}/mcp/${KEYS.privateUrl}`);
    assert.equal(status, 400);
    assert.match(body.error.message, /private or internal/);
  });
  await check('server card, OAuth metadata 404 and health', async () => {
    const card = await (await fetch(`${mcpBase}/.well-known/mcp/server-card.json`)).json();
    assert.equal(card.serverInfo.name, 'Cal.com MCP Server');
    assert.equal((await fetch(`${mcpBase}/.well-known/oauth-authorization-server`)).status, 404);
    const health = await (await fetch(`${mcpBase}/health`)).json();
    assert.equal(health.keyService, 'configured');
  });
  await check('analytics require MCP_API_KEY and never record user keys', async () => {
    assert.equal((await fetch(`${mcpBase}/analytics`)).status, 401);
    const data = await (await fetch(`${mcpBase}/analytics`, { headers: { 'X-API-Key': ADMIN_KEY } })).json();
    assert.ok(data.summary.totalToolCalls > 0);
    assert.ok(!JSON.stringify(data).includes('usr_'), 'analytics must not contain user keys');
    assert.ok(!JSON.stringify(data).includes(CAL_KEY), 'analytics must not contain Cal keys');
  });
  await check('server logs never contain API keys', () => {
    assert.ok(!serverLog.includes(CAL_KEY), 'Cal key leaked into logs');
    assert.ok(!serverLog.includes(KEYS.read), 'user key leaked into logs');
  });
  await check('key service down → 503', async () => {
    keyService.close();
    keyService.closeAllConnections?.();
    const { status, body } = await rawPost(`${mcpBase}/mcp/${KEYS.uncached}`);
    assert.equal(status, 503);
    assert.equal(body.error.data.reason, 'service_unavailable');
  });

  // ---------------------------------------------------------------------------
  console.log('\nCLI / stdio mode');
  await check('stdio: read-only by default, legacy CAL_API_KEY accepted', async () => {
    const client = new Client({ name: 'smoke-test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, 'dist/cli.js')],
      env: { ...process.env, CAL_API_KEY: CAL_KEY, CALCOM_API_URL: calUrl },
      stderr: 'ignore',
    }));
    assert.equal((await client.listTools()).tools.length, 17);
    assert.match(text(await client.callTool({ name: 'hello', arguments: {} })), /"transport": "stdio"/);
    assert.match(text(await client.callTool({ name: 'list_event_types', arguments: {} })), /30 Min Meeting/);
    await client.close();
  });
  await check('stdio: CALCOM_ACCESS=full exposes all 39 tools', async () => {
    const client = new Client({ name: 'smoke-test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, 'dist/cli.js')],
      env: { ...process.env, CALCOM_API_KEY: CAL_KEY, CALCOM_API_URL: calUrl, CALCOM_ACCESS: 'full' },
      stderr: 'ignore',
    }));
    assert.equal((await client.listTools()).tools.length, 39);
    await client.close();
  });

  console.log(`\nAll ${passed} smoke checks passed.`);
  await shutdown(0);
} catch (error) {
  console.error('\nSmoke test failed:', error);
  console.error('\n--- server log ---\n' + serverLog);
  await shutdown(1);
}
