import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toBookingLocation, toEventTypeLocation, toUpdateLocation } from '../src/calcom/locations.js';
import { ToolInputError } from '../src/errors.js';

describe('toBookingLocation', () => {
  it('picks one of the event type locations', () => {
    assert.deepEqual(toBookingLocation({ type: 'integration', value: 'Google-Meet' }), { type: 'integration', integration: 'google-meet' });
    assert.deepEqual(toBookingLocation({ type: 'link', value: 'ignored' }), { type: 'link' });
    assert.deepEqual(toBookingLocation({ type: 'address' }), { type: 'address' });
    assert.deepEqual(toBookingLocation({ type: 'attendee_phone', value: '+60123456789' }), { type: 'attendeePhone', phone: '+60123456789' });
    assert.deepEqual(toBookingLocation({ type: 'attendee_defined', value: 'Starbucks KLCC' }), { type: 'attendeeDefined', location: 'Starbucks KLCC' });
  });

  it('asks for missing values and unknown apps', () => {
    assert.throws(() => toBookingLocation({ type: 'attendee_address' }), ToolInputError);
    assert.throws(() => toBookingLocation({ type: 'integration', value: 'teams' }), /Unknown video app/);
  });
});

describe('toUpdateLocation', () => {
  it('carries the new value', () => {
    assert.deepEqual(toUpdateLocation({ type: 'link', value: 'https://meet.example.com/x' }), { type: 'link', link: 'https://meet.example.com/x' });
    assert.deepEqual(toUpdateLocation({ type: 'address', value: 'Menara KL' }), { type: 'address', address: 'Menara KL' });
    assert.deepEqual(toUpdateLocation({ type: 'integration', value: 'zoom' }), { type: 'integration', integration: 'zoom' });
  });

  it('validates links and refuses team-only locations', () => {
    assert.throws(() => toUpdateLocation({ type: 'link', value: 'meet.example.com' }), /not a valid http\(s\) URL/);
    assert.throws(() => toUpdateLocation({ type: 'organizers_default_app' }), /team event types/);
  });
});

describe('toEventTypeLocation', () => {
  it('maps to event type locations with visibility', () => {
    assert.deepEqual(toEventTypeLocation({ type: 'address', value: 'Menara KL', public: false }), { type: 'address', address: 'Menara KL', public: false });
    assert.deepEqual(toEventTypeLocation({ type: 'phone', value: '+60123' }), { type: 'phone', phone: '+60123', public: true });
    assert.deepEqual(toEventTypeLocation({ type: 'attendee_phone' }), { type: 'attendeePhone' });
    assert.throws(() => toEventTypeLocation({ type: 'organizers_default_app' }), /not available on Cal\.diy/);
  });
});
