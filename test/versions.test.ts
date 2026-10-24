import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { API_VERSIONS, apiVersionFor } from '../src/calcom/versions.js';

describe('apiVersionFor', () => {
  it('sends the bookings version to every booking endpoint', () => {
    for (const path of ['/bookings', '/bookings/abc', '/bookings/abc/attendees', '/bookings/abc/attendees/12', '/bookings/abc/guests', '/bookings/abc/location', '/bookings/by-seat/x']) {
      assert.equal(apiVersionFor(path), API_VERSIONS.bookings, path);
    }
  });

  it('sends the event-types version only to the event type resources themselves', () => {
    assert.equal(apiVersionFor('/event-types'), API_VERSIONS.eventTypes);
    assert.equal(apiVersionFor('/event-types/42'), API_VERSIONS.eventTypes);
    // Private links only exist under the default version: a 2024-06-14 header makes them 404
    assert.equal(apiVersionFor('/event-types/42/private-links'), undefined);
    assert.equal(apiVersionFor('/event-types/42/private-links/abc'), undefined);
    assert.equal(apiVersionFor('/event-types/42/webhooks'), undefined);
  });

  it('versions schedules and slots', () => {
    assert.equal(apiVersionFor('/schedules'), API_VERSIONS.schedules);
    assert.equal(apiVersionFor('/schedules/default'), API_VERSIONS.schedules);
    assert.equal(apiVersionFor('/schedules/7'), API_VERSIONS.schedules);
    assert.equal(apiVersionFor('/slots'), API_VERSIONS.slots);
    assert.equal(apiVersionFor('/slots?eventTypeId=1'), API_VERSIONS.slots);
  });

  it('leaves unversioned controllers alone', () => {
    for (const path of ['/me', '/webhooks', '/webhooks/3', '/calendars', '/calendars/busy-times', '/calendars/google/events', '/conferencing', '/conferencing/zoom/default']) {
      assert.equal(apiVersionFor(path), undefined, path);
    }
  });
});
