/**
 * Locations: one friendly input shape for the model, mapped to the three shapes Cal API v2
 * uses (booking input, booking-location update, event-type location), plus readable labels.
 */

import { z } from 'zod';
import { ToolInputError } from '../errors.js';
import type { EventTypeLocation } from './types.js';

/** Conferencing apps accepted by Cal API v2 location objects */
export const INTEGRATIONS = [
  'cal-video', 'google-meet', 'zoom', 'whereby-video', 'whatsapp-video', 'webex-video', 'telegram-video', 'tandem',
  'sylaps-video', 'skype-video', 'sirius-video', 'signal-video', 'shimmer-video', 'salesroom-video', 'roam-video',
  'riverside-video', 'ping-video', 'office365-video', 'mirotalk-video', 'jitsi', 'jelly-video', 'jelly-conferencing',
  'huddle', 'facetime-video', 'element-call-video', 'eightxeight-video', 'discord-video', 'demodesk-video', 'campfire-video',
] as const;

const INTEGRATION_LABELS: Record<string, string> = {
  'cal-video': 'Cal Video',
  'google-meet': 'Google Meet',
  zoom: 'Zoom',
  'office365-video': 'Microsoft Teams',
  'whereby-video': 'Whereby',
  'whatsapp-video': 'WhatsApp',
  'webex-video': 'Webex',
  'telegram-video': 'Telegram',
  'skype-video': 'Skype',
  'signal-video': 'Signal',
  'facetime-video': 'FaceTime',
  'discord-video': 'Discord',
  'element-call-video': 'Element Call',
  'eightxeight-video': '8x8',
  jitsi: 'Jitsi',
  huddle: 'Huddle01',
};

/** Values stored in Booking.location for app-based meetings (before a meeting URL exists) */
const BOOKING_APP_LABELS: Record<string, string> = {
  daily: 'Cal Video',
  'google:meet': 'Google Meet',
  zoom: 'Zoom',
  office365_video: 'Microsoft Teams',
  whereby_video: 'Whereby',
  jitsi: 'Jitsi',
};

export const LOCATION_TYPES = [
  'integration',
  'link',
  'address',
  'phone',
  'attendee_address',
  'attendee_phone',
  'attendee_defined',
  'organizers_default_app',
] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];

export const locationInputSchema = z.object({
  type: z
    .enum(LOCATION_TYPES)
    .describe(
      'integration = video app (value: app slug such as "cal-video", "google-meet", "zoom"); link = meeting link; ' +
      'address = in person; phone = organizer phone; attendee_address / attendee_phone / attendee_defined = the ' +
      "attendee's address / phone / own choice; organizers_default_app = the organizer's default video app.",
    ),
  value: z
    .string()
    .optional()
    .describe('The app slug, URL, address or phone number, where the type needs one. Phone numbers in international format (+60…).'),
  public: z
    .boolean()
    .optional()
    .describe('Event types only: show this link / address / phone on the public booking page (default true).'),
});
export type LocationInput = z.infer<typeof locationInputSchema>;

function requireValue(input: LocationInput, what: string): string {
  const value = input.value?.trim();
  if (!value) throw new ToolInputError(`Location type "${input.type}" needs a value: ${what}.`);
  return value;
}

function checkIntegration(input: LocationInput): string {
  const value = requireValue(input, 'the app slug, e.g. "google-meet"').toLowerCase();
  if (!(INTEGRATIONS as readonly string[]).includes(value)) {
    throw new ToolInputError(`Unknown video app "${input.value}". Use one of: ${INTEGRATIONS.join(', ')}.`);
  }
  return value;
}

function checkUrl(input: LocationInput): string {
  const value = requireValue(input, 'the meeting URL');
  if (!/^https?:\/\/\S+$/i.test(value)) throw new ToolInputError(`"${value}" is not a valid http(s) URL.`);
  return value;
}

/**
 * POST /bookings: choose one of the event type's locations. link / address / phone refer to
 * what the organizer configured on the event type; attendee_* carry the attendee's value.
 */
export function toBookingLocation(input: LocationInput): Record<string, unknown> {
  switch (input.type) {
    case 'integration':
      return { type: 'integration', integration: checkIntegration(input) };
    case 'link':
      return { type: 'link' };
    case 'address':
      return { type: 'address' };
    case 'phone':
      return { type: 'phone' };
    case 'attendee_address':
      return { type: 'attendeeAddress', address: requireValue(input, "the attendee's address") };
    case 'attendee_phone':
      return { type: 'attendeePhone', phone: requireValue(input, "the attendee's phone number") };
    case 'attendee_defined':
      return { type: 'attendeeDefined', location: requireValue(input, 'where the attendee wants to meet') };
    case 'organizers_default_app':
      return { type: 'organizersDefaultApp' };
  }
}

/** PATCH /bookings/{uid}/location: the new location itself */
export function toUpdateLocation(input: LocationInput): Record<string, unknown> {
  switch (input.type) {
    case 'integration':
      return { type: 'integration', integration: checkIntegration(input) };
    case 'link':
      return { type: 'link', link: checkUrl(input) };
    case 'address':
      return { type: 'address', address: requireValue(input, 'the address') };
    case 'phone':
      return { type: 'phone', phone: requireValue(input, 'the phone number') };
    case 'attendee_address':
      return { type: 'attendeeAddress', address: requireValue(input, "the attendee's address") };
    case 'attendee_phone':
      return { type: 'attendeePhone', phone: requireValue(input, "the attendee's phone number") };
    case 'attendee_defined':
      return { type: 'attendeeDefined', location: requireValue(input, 'the location') };
    case 'organizers_default_app':
      throw new ToolInputError('organizers_default_app only applies to team event types. Pick a concrete location instead.');
  }
}

/** Event types: the locations offered to bookers */
export function toEventTypeLocation(input: LocationInput): Record<string, unknown> {
  switch (input.type) {
    case 'integration':
      return { type: 'integration', integration: checkIntegration(input) };
    case 'link':
      return { type: 'link', link: checkUrl(input), public: input.public ?? true };
    case 'address':
      return { type: 'address', address: requireValue(input, 'the address'), public: input.public ?? true };
    case 'phone':
      return { type: 'phone', phone: requireValue(input, 'the phone number'), public: input.public ?? true };
    case 'attendee_address':
      return { type: 'attendeeAddress' };
    case 'attendee_phone':
      return { type: 'attendeePhone' };
    case 'attendee_defined':
      return { type: 'attendeeDefined' };
    case 'organizers_default_app':
      throw new ToolInputError('organizers_default_app only applies to team event types (not available on Cal.diy).');
  }
}

export function integrationLabel(slug?: string | null): string {
  if (!slug) return 'Video call';
  return INTEGRATION_LABELS[slug] ?? slug.replace(/-video$/, '').replace(/(^|-)(\w)/g, (_, dash: string, char: string) => `${dash ? ' ' : ''}${char.toUpperCase()}`);
}

export function describeEventTypeLocation(location: EventTypeLocation): string {
  switch (location.type) {
    case 'integration':
      return location.link ? `${integrationLabel(location.integration)} (${location.link})` : integrationLabel(location.integration);
    case 'link':
      return location.link ? `Link ${location.link}` : 'Link';
    case 'address':
      return location.address ? `In person: ${location.address}` : 'In person';
    case 'phone':
      return location.phone ? `Phone ${location.phone}` : 'Phone';
    case 'attendeeAddress':
      return "At the attendee's address";
    case 'attendeePhone':
      return "Phone call to the attendee's number";
    case 'attendeeDefined':
      return "Attendee's choice";
    case 'organizersDefaultApp':
      return "Organizer's default app";
    default:
      return location.location || location.type;
  }
}

/** Booking.location: a meeting URL, an address / phone, or an app id like "integrations:daily" */
export function describeBookingLocation(location?: string | null): string {
  if (!location) return '';
  const app = /^integrations:(.+)$/.exec(location);
  if (app) return BOOKING_APP_LABELS[app[1]] ?? app[1];
  return location;
}
