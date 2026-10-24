import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  agenda,
  bookingLine,
  formatMoney,
  formatSlots,
  hintForError,
  paymentInfo,
  weeklyHours,
} from '../src/calcom/format.js';
import { CalApiError } from '../src/calcom/http.js';
import { describeBookingLocation, describeEventTypeLocation } from '../src/calcom/locations.js';
import type { Booking } from '../src/calcom/types.js';

const KL = 'Asia/Kuala_Lumpur';

function booking(overrides: Partial<Booking>): Booking {
  return {
    id: 1,
    uid: 'uid1',
    title: '30 Min Meeting',
    status: 'accepted',
    start: '2026-10-27T02:00:00Z',
    end: '2026-10-27T02:30:00Z',
    attendees: [{ name: 'John Doe', email: 'john@example.com' }],
    ...overrides,
  };
}

describe('weeklyHours', () => {
  it('merges consecutive days with identical hours and lists closed days', () => {
    assert.deepEqual(
      weeklyHours([{ days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], startTime: '09:00', endTime: '17:00' }]),
      ['Mon–Fri 09:00–17:00', 'Unavailable: Sat, Sun'],
    );
  });

  it('keeps split days (lunch breaks) together', () => {
    assert.deepEqual(
      weeklyHours([
        { days: ['Monday', 'Tuesday'], startTime: '09:00', endTime: '12:00' },
        { days: ['Monday', 'Tuesday'], startTime: '13:00', endTime: '17:00' },
        { days: ['Saturday'], startTime: '10:00', endTime: '14:00' },
      ]),
      ['Mon–Tue 09:00–12:00, 13:00–17:00', 'Sat 10:00–14:00', 'Unavailable: Wed, Thu, Fri, Sun'],
    );
  });
});

describe('agenda', () => {
  it('groups bookings by day in the display zone', () => {
    const lines = agenda([
      booking({ uid: 'late', start: '2026-10-27T15:30:00Z', end: '2026-10-27T16:00:00Z' }), // 23:30 Tue in KL
      booking({ uid: 'after-midnight', start: '2026-10-27T16:30:00Z', end: '2026-10-27T17:00:00Z' }), // 00:30 Wed in KL
    ], KL, 24);
    assert.equal(lines.length, 4);
    assert.match(lines[0], /^### Tue 27 Oct/);
    assert.match(lines[1], /23:30–00:00|23:30–Wed 28 Oct/);
    assert.match(lines[2], /^### Wed 28 Oct/);
    assert.match(lines[3], /uid `after-midnight`/);
  });

  it('formats one booking line with status, attendees and location', () => {
    const line = bookingLine(booking({ status: 'pending', location: 'integrations:daily', guests: ['g@example.com'] }), KL, 24);
    assert.equal(line, '- 10:00–10:30 · 30 Min Meeting · John Doe <john@example.com> +1 more · **pending confirmation** · Cal Video · uid `uid1`');
  });
});

describe('formatSlots', () => {
  it('lists every day, including days without slots', () => {
    const summary = formatSlots(
      { '2026-10-27': [{ start: '2026-10-27T09:00:00.000+08:00' }, { start: '2026-10-27T09:30:00.000+08:00' }] },
      ['2026-10-27', '2026-10-28'],
      KL,
      24,
    );
    assert.equal(summary.total, 2);
    assert.equal(summary.first?.toISOString(), '2026-10-27T01:00:00.000Z');
    assert.match(summary.lines[0], /Tue 27 Oct.*: 09:00 09:30$/);
    assert.match(summary.lines[1], /Wed 28 Oct.*: none$/);
  });
});

describe('prices', () => {
  it('reads payment app prices before the legacy price column', () => {
    assert.deepEqual(paymentInfo({ metadata: { apps: { hitpay: { enabled: true, price: 5000, currency: 'myr' } } }, price: 0, currency: 'usd' }), {
      amount: 5000,
      currency: 'myr',
      app: 'hitpay',
    });
    assert.deepEqual(paymentInfo({ metadata: { apps: { stripe: { enabled: false, price: 100 } } }, price: 2500, currency: 'usd' }), {
      amount: 2500,
      currency: 'usd',
    });
    assert.equal(paymentInfo({ metadata: {}, price: 0 }), undefined);
  });

  it('formats smallest-unit amounts, including zero-decimal currencies', () => {
    assert.match(formatMoney(5000, 'myr'), /MYR\s50\.00/);
    assert.equal(formatMoney(1999, 'usd'), '$19.99');
    assert.equal(formatMoney(5000, 'jpy'), '¥5,000');
    assert.equal(formatMoney(0, 'usd'), 'free');
  });
});

describe('locations', () => {
  it('describes booking and event type locations', () => {
    assert.equal(describeBookingLocation('integrations:daily'), 'Cal Video');
    assert.equal(describeBookingLocation('https://meet.google.com/abc'), 'https://meet.google.com/abc');
    assert.equal(describeEventTypeLocation({ type: 'integration', integration: 'google-meet' }), 'Google Meet');
    assert.equal(describeEventTypeLocation({ type: 'address', address: 'Menara KL' }), 'In person: Menara KL');
    assert.equal(describeEventTypeLocation({ type: 'attendeePhone' }), "Phone call to the attendee's number");
  });
});

describe('hintForError', () => {
  it('explains the common failures', () => {
    assert.match(hintForError(new CalApiError(404, 'x', 'GET /me', { html: true })) ?? '', /not Cal API v2/);
    assert.match(hintForError(new CalApiError(401, 'invalid', 'GET /me')) ?? '', /Settings → Developer → API Keys/);
    assert.match(hintForError(new CalApiError(429, 'slow down', 'GET /me', { retryAfterSeconds: 30 })) ?? '', /about 30 s/);
    assert.match(hintForError(new CalApiError(400, 'no_available_users_found_error', 'POST /bookings')) ?? '', /get_available_slots/);
    assert.match(hintForError(new CalApiError(0, 'down', 'GET /me')) ?? '', /Could not reach/);
    assert.equal(hintForError(new CalApiError(400, 'something else', 'POST /bookings')), undefined);
  });
});
