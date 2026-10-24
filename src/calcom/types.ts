/**
 * The parts of Cal API v2 responses this server relies on (subset of the OpenAPI spec,
 * Cal.diy @ 366c88e). Optional fields are optional because instances and versions differ.
 */

export interface Me {
  id: number;
  username: string;
  email: string;
  name?: string | null;
  avatarUrl?: string | null;
  bio?: string | null;
  timeFormat?: number | null;
  defaultScheduleId?: number | null;
  weekStart?: string | null;
  timeZone?: string | null;
  locale?: string | null;
  organizationId?: number | null;
  organization?: { id: number; isPlatform?: boolean } | null;
}

export type BookingStatus = 'accepted' | 'pending' | 'cancelled' | 'rejected';

export interface BookingHost {
  id: number;
  name?: string | null;
  email: string;
  displayEmail?: string;
  username?: string;
  timeZone?: string;
}

export interface BookingAttendee {
  id?: number;
  name: string;
  email: string;
  displayEmail?: string;
  timeZone?: string;
  language?: string;
  absent?: boolean;
  phoneNumber?: string | null;
  seatUid?: string;
  bookingFieldsResponses?: Record<string, unknown>;
}

export interface Booking {
  id: number;
  uid: string;
  title: string;
  description?: string | null;
  hosts?: BookingHost[];
  status: BookingStatus | string;
  cancellationReason?: string | null;
  cancelledByEmail?: string | null;
  reschedulingReason?: string | null;
  rescheduledByEmail?: string | null;
  rescheduledFromUid?: string | null;
  rescheduledToUid?: string | null;
  start: string;
  end: string;
  duration?: number;
  eventTypeId?: number;
  eventType?: { id: number; slug?: string } | null;
  meetingUrl?: string | null;
  location?: string | null;
  absentHost?: boolean;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown> | null;
  rating?: number | null;
  icsUid?: string | null;
  attendees?: BookingAttendee[];
  guests?: string[];
  bookingFieldsResponses?: Record<string, unknown>;
  recurringBookingUid?: string;
  seatUid?: string;
}

export interface CalendarLink {
  label: string;
  link: string;
}

export interface BookingReference {
  id: number;
  type: string;
  eventUid?: string | null;
  destinationCalendarId?: string | null;
}

export interface Recording {
  id: string;
  roomName?: string;
  startTs?: number;
  status?: string;
  maxParticipants?: number;
  duration?: number;
  shareToken?: string;
  downloadLink?: string | null;
  error?: string | null;
}

export interface MeetingSession {
  id: string;
  room?: string;
  startTime?: number;
  duration?: number;
  ongoing?: boolean;
  maxParticipants?: number;
  participants?: Array<{ userId?: string; userName?: string; joinTime?: number; duration?: number }>;
}

export type Slot = string | { start: string; end?: string; attendeesCount?: number; bookingUid?: string };
/** Available slots keyed by date ("2026-10-27") in the requested time zone */
export type SlotsMap = Record<string, Slot[]>;

export interface EventTypeLocation {
  type: string;
  address?: string;
  link?: string;
  phone?: string;
  integration?: string;
  location?: string;
  public?: boolean;
  credentialId?: number;
}

export interface BookingField {
  type: string;
  slug?: string;
  label?: string;
  required?: boolean | unknown;
  hidden?: boolean;
  options?: string[];
  isDefault?: unknown;
  placeholder?: string;
}

export interface EventType {
  id: number;
  title: string;
  slug: string;
  description?: string | null;
  lengthInMinutes: number;
  lengthInMinutesOptions?: number[] | null;
  locations?: EventTypeLocation[];
  bookingFields?: BookingField[];
  disableGuests?: boolean;
  slotInterval?: number | null;
  minimumBookingNotice?: number | null;
  beforeEventBuffer?: number | null;
  afterEventBuffer?: number | null;
  recurrence?: { interval: number; occurrences: number; frequency: string } | null;
  metadata?: Record<string, unknown> | null;
  price?: number | null;
  currency?: string | null;
  lockTimeZoneToggleOnBookingPage?: boolean;
  seatsPerTimeSlot?: number | null;
  isInstantEvent?: boolean;
  scheduleId?: number | null;
  bookingLimitsCount?: Record<string, unknown> | null;
  bookerActiveBookingsLimit?: { maximumActiveBookings?: number; offerReschedule?: boolean } | null;
  onlyShowFirstAvailableSlot?: boolean;
  bookingLimitsDuration?: Record<string, unknown> | null;
  bookingWindow?: unknown;
  confirmationPolicy?: unknown;
  requiresBookerEmailVerification?: boolean;
  hideCalendarNotes?: boolean;
  seats?: { seatsPerTimeSlot: number; showAttendeeInfo?: boolean; showAvailabilityCount?: boolean } | null;
  offsetStart?: number | null;
  customName?: string | null;
  destinationCalendar?: { integration: string; externalId: string } | null;
  hidden: boolean;
  bookingRequiresAuthentication?: boolean;
  disableCancelling?: { disabled?: boolean } | null;
  disableRescheduling?: { disabled?: boolean; minutesBefore?: number } | null;
  successRedirectUrl?: string | null;
  ownerId?: number;
  bookingUrl?: string;
}

export interface PrivateLink {
  linkId: string;
  eventTypeId: number;
  isExpired: boolean;
  bookingUrl: string;
  expiresAt?: string | null;
  maxUsageCount?: number | null;
  usageCount?: number | null;
}

export interface ScheduleAvailability {
  days: string[];
  startTime: string;
  endTime: string;
}

export interface ScheduleOverride {
  date: string;
  startTime: string;
  endTime: string;
}

export interface Schedule {
  id: number;
  ownerId?: number;
  name: string;
  timeZone: string;
  availability: ScheduleAvailability[];
  isDefault: boolean;
  overrides: ScheduleOverride[];
}

export interface ExternalCalendar {
  externalId: string;
  integration?: string | null;
  name?: string | null;
  primary?: boolean | null;
  readOnly?: boolean;
  email?: string | null;
  isSelected: boolean;
  credentialId: number;
}

export interface ConnectedCalendar {
  integration: { name?: string; title?: string; slug?: string; type?: string };
  credentialId: number;
  primary?: ExternalCalendar | null;
  calendars?: ExternalCalendar[];
}

export interface ConnectedCalendars {
  connectedCalendars: ConnectedCalendar[];
  destinationCalendar?: {
    integration?: string;
    externalId?: string;
    name?: string | null;
    primaryEmail?: string | null;
    integrationTitle?: string | null;
  } | null;
}

export interface BusyTime {
  start: string;
  end: string;
  source?: string | null;
}

export interface UnifiedCalendarEvent {
  id: string;
  title?: string | null;
  description?: string | null;
  start: { time: string; timeZone?: string } | string;
  end: { time: string; timeZone?: string } | string;
  locations?: Array<{ type: string; url?: string; label?: string }>;
  attendees?: Array<{ email: string; name?: string; responseStatus?: string; self?: boolean }>;
  status?: string;
  hosts?: Array<{ email: string; name?: string }>;
  source?: string;
}

export interface ConferencingApp {
  id: number;
  type: string;
  userId?: number;
  invalid?: boolean | null;
}

export interface DefaultConferencingApp {
  appSlug?: string | null;
  appLink?: string | null;
}

export interface Webhook {
  id: number;
  subscriberUrl: string;
  triggers: string[];
  active: boolean;
  payloadTemplate?: string | null;
  secret?: string | null;
  userId?: number;
  eventTypeId?: number;
}
