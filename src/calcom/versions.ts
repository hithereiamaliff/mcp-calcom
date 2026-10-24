/**
 * cal-api-version per endpoint — the single source of truth.
 *
 * Cal API v2 picks the handler by the cal-api-version header and silently falls back to the
 * old 2024-04-15 handlers when it is missing, so the versioned resources must always send theirs.
 * Unversioned controllers (webhooks, calendars, conferencing, me, …) accept any version or none.
 * Event-type private links only exist under the default version: sending the event-types
 * header there makes them 404, so sub-resources of /event-types/{id} get no header.
 */

export const API_VERSIONS = {
  bookings: '2024-08-13',
  eventTypes: '2024-06-14',
  schedules: '2024-06-11',
  slots: '2024-09-04',
} as const;

export function apiVersionFor(path: string): string | undefined {
  const clean = path.split('?')[0];
  if (/^\/bookings(\/|$)/.test(clean)) return API_VERSIONS.bookings;
  if (/^\/event-types(\/\d+)?\/?$/.test(clean)) return API_VERSIONS.eventTypes;
  if (/^\/schedules(\/|$)/.test(clean)) return API_VERSIONS.schedules;
  if (/^\/slots(\/|$)/.test(clean)) return API_VERSIONS.slots;
  return undefined;
}
