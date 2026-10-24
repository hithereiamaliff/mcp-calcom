/**
 * Typed Cal API v2 client — one method per endpoint the tools use.
 * Headers, versions, retries and error mapping live in http.ts.
 */

import { shortHash } from '../utils/mask.js';
import { type CalRequestOptions, type CalResponse, type Pagination, type QueryValue, type RateLimitInfo, calRequest } from './http.js';
import type {
  Booking,
  BookingAttendee,
  BookingReference,
  BusyTime,
  CalendarLink,
  ConferencingApp,
  ConnectedCalendars,
  DefaultConferencingApp,
  EventType,
  Me,
  MeetingSession,
  PrivateLink,
  Recording,
  Schedule,
  SlotsMap,
  UnifiedCalendarEvent,
  Webhook,
} from './types.js';

export type Body = Record<string, unknown>;

const enc = encodeURIComponent;

export class CalClient {
  /** Rate-limit headroom seen on the most recent response (reported by get_instance_info) */
  lastRateLimit?: RateLimitInfo;
  /** Cache key for per-account data: API URL + hash of the key (never the key itself) */
  readonly identity: string;

  constructor(
    readonly baseUrl: string,
    private readonly apiKey: string,
  ) {
    this.identity = `${baseUrl}|${shortHash(apiKey, 16)}`;
  }

  private async request<T>(path: string, options: CalRequestOptions = {}): Promise<CalResponse<T>> {
    const response = await calRequest<T>(this.baseUrl, this.apiKey, path, options);
    if (response.rateLimit) this.lastRateLimit = response.rateLimit;
    return response;
  }

  private async data<T>(path: string, options: CalRequestOptions = {}): Promise<T> {
    return (await this.request<T>(path, options)).data;
  }

  // ---------------------------------------------------------------------------
  // Profile
  // ---------------------------------------------------------------------------

  getMe(): Promise<Me> {
    return this.data<Me>('/me');
  }

  updateMe(body: Body): Promise<Me> {
    return this.data<Me>('/me', { method: 'PATCH', body });
  }

  // ---------------------------------------------------------------------------
  // Bookings (cal-api-version 2024-08-13)
  // ---------------------------------------------------------------------------

  async listBookings(query: Record<string, QueryValue>): Promise<{ bookings: Booking[]; pagination?: Pagination }> {
    const response = await this.request<Booking[]>('/bookings', { query });
    return { bookings: Array.isArray(response.data) ? response.data : [], pagination: response.pagination };
  }

  /** A recurring series comes back as an array of occurrences */
  getBooking(uid: string): Promise<Booking | Booking[]> {
    return this.data(`/bookings/${enc(uid)}`);
  }

  getBookingBySeat(seatUid: string): Promise<Booking | Booking[]> {
    return this.data(`/bookings/by-seat/${enc(seatUid)}`);
  }

  createBooking(body: Body): Promise<Booking | Booking[]> {
    return this.data('/bookings', { method: 'POST', body });
  }

  rescheduleBooking(uid: string, body: Body): Promise<Booking | Booking[]> {
    return this.data(`/bookings/${enc(uid)}/reschedule`, { method: 'POST', body });
  }

  cancelBooking(uid: string, body: Body): Promise<Booking | Booking[]> {
    return this.data(`/bookings/${enc(uid)}/cancel`, { method: 'POST', body });
  }

  confirmBooking(uid: string): Promise<Booking | Booking[]> {
    return this.data(`/bookings/${enc(uid)}/confirm`, { method: 'POST' });
  }

  declineBooking(uid: string, body: Body): Promise<Booking | Booking[]> {
    return this.data(`/bookings/${enc(uid)}/decline`, { method: 'POST', body });
  }

  markAbsent(uid: string, body: Body): Promise<Booking | Booking[]> {
    return this.data(`/bookings/${enc(uid)}/mark-absent`, { method: 'POST', body });
  }

  addGuests(uid: string, guests: Body[]): Promise<Booking | Booking[]> {
    return this.data(`/bookings/${enc(uid)}/guests`, { method: 'POST', body: { guests } });
  }

  listAttendees(uid: string): Promise<BookingAttendee[]> {
    return this.data(`/bookings/${enc(uid)}/attendees`);
  }

  removeAttendee(uid: string, attendeeId: number): Promise<unknown> {
    return this.data(`/bookings/${enc(uid)}/attendees/${attendeeId}`, { method: 'DELETE' });
  }

  updateLocation(uid: string, location: Body): Promise<Booking | Booking[]> {
    return this.data(`/bookings/${enc(uid)}/location`, { method: 'PATCH', body: { location } });
  }

  getCalendarLinks(uid: string): Promise<CalendarLink[]> {
    return this.data(`/bookings/${enc(uid)}/calendar-links`);
  }

  getReferences(uid: string): Promise<BookingReference[]> {
    return this.data(`/bookings/${enc(uid)}/references`);
  }

  getRecordings(uid: string): Promise<Recording[]> {
    return this.data(`/bookings/${enc(uid)}/recordings`);
  }

  getTranscripts(uid: string): Promise<string[]> {
    return this.data(`/bookings/${enc(uid)}/transcripts`);
  }

  getConferencingSessions(uid: string): Promise<MeetingSession[]> {
    return this.data(`/bookings/${enc(uid)}/conferencing-sessions`);
  }

  // ---------------------------------------------------------------------------
  // Slots (cal-api-version 2024-09-04)
  // ---------------------------------------------------------------------------

  getSlots(query: Record<string, QueryValue>): Promise<SlotsMap> {
    return this.data('/slots', { query });
  }

  // ---------------------------------------------------------------------------
  // Event types (cal-api-version 2024-06-14) and private links (unversioned)
  // ---------------------------------------------------------------------------

  async listEventTypes(): Promise<EventType[]> {
    const data = await this.data<EventType[]>('/event-types');
    return Array.isArray(data) ? data : [];
  }

  getEventType(id: number): Promise<EventType> {
    return this.data(`/event-types/${id}`);
  }

  createEventType(body: Body): Promise<EventType> {
    return this.data('/event-types', { method: 'POST', body });
  }

  updateEventType(id: number, body: Body): Promise<EventType> {
    return this.data(`/event-types/${id}`, { method: 'PATCH', body });
  }

  deleteEventType(id: number): Promise<unknown> {
    return this.data(`/event-types/${id}`, { method: 'DELETE' });
  }

  async listPrivateLinks(eventTypeId: number): Promise<PrivateLink[]> {
    const data = await this.data<PrivateLink[]>(`/event-types/${eventTypeId}/private-links`);
    return Array.isArray(data) ? data : [];
  }

  createPrivateLink(eventTypeId: number, body: Body): Promise<PrivateLink> {
    return this.data(`/event-types/${eventTypeId}/private-links`, { method: 'POST', body });
  }

  deletePrivateLink(eventTypeId: number, linkId: string): Promise<unknown> {
    return this.data(`/event-types/${eventTypeId}/private-links/${enc(linkId)}`, { method: 'DELETE' });
  }

  // ---------------------------------------------------------------------------
  // Schedules (cal-api-version 2024-06-11)
  // ---------------------------------------------------------------------------

  async listSchedules(): Promise<Schedule[]> {
    const data = await this.data<Schedule[]>('/schedules');
    return Array.isArray(data) ? data : [];
  }

  getSchedule(id: number): Promise<Schedule> {
    return this.data(`/schedules/${id}`);
  }

  getDefaultSchedule(): Promise<Schedule | null> {
    return this.data('/schedules/default');
  }

  createSchedule(body: Body): Promise<Schedule> {
    return this.data('/schedules', { method: 'POST', body });
  }

  updateSchedule(id: number, body: Body): Promise<Schedule> {
    return this.data(`/schedules/${id}`, { method: 'PATCH', body });
  }

  deleteSchedule(id: number): Promise<unknown> {
    return this.data(`/schedules/${id}`, { method: 'DELETE' });
  }

  // ---------------------------------------------------------------------------
  // Calendars
  // ---------------------------------------------------------------------------

  listCalendars(): Promise<ConnectedCalendars> {
    return this.data('/calendars');
  }

  /**
   * Busy times across the given calendars. The API reads calendarsToLoad as an array of
   * objects (qs syntax) and requires a time zone.
   */
  async getBusyTimes(params: {
    dateFrom: string;
    dateTo: string;
    timeZone: string;
    calendars: Array<{ credentialId: number; externalId: string }>;
  }): Promise<BusyTime[]> {
    const query: Record<string, QueryValue> = {
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      timeZone: params.timeZone,
    };
    params.calendars.forEach((calendar, index) => {
      query[`calendarsToLoad[${index}][credentialId]`] = calendar.credentialId;
      query[`calendarsToLoad[${index}][externalId]`] = calendar.externalId;
    });
    const data = await this.data<BusyTime[]>('/calendars/busy-times', { query });
    return Array.isArray(data) ? data : [];
  }

  async listCalendarEvents(calendar: 'google', query: Record<string, QueryValue>): Promise<UnifiedCalendarEvent[]> {
    const data = await this.data<UnifiedCalendarEvent[]>(`/calendars/${calendar}/events`, { query });
    return Array.isArray(data) ? data : [];
  }

  // ---------------------------------------------------------------------------
  // Conferencing
  // ---------------------------------------------------------------------------

  async listConferencingApps(): Promise<ConferencingApp[]> {
    const data = await this.data<ConferencingApp[]>('/conferencing');
    return Array.isArray(data) ? data : [];
  }

  getDefaultConferencingApp(): Promise<DefaultConferencingApp | null> {
    return this.data('/conferencing/default');
  }

  setDefaultConferencingApp(app: string): Promise<unknown> {
    return this.data(`/conferencing/${enc(app)}/default`, { method: 'POST' });
  }

  // ---------------------------------------------------------------------------
  // Webhooks (account-wide, or scoped to one event type)
  // ---------------------------------------------------------------------------

  private webhooksPath(eventTypeId?: number): string {
    return eventTypeId ? `/event-types/${eventTypeId}/webhooks` : '/webhooks';
  }

  async listWebhooks(eventTypeId?: number): Promise<Webhook[]> {
    const data = await this.data<Webhook[]>(this.webhooksPath(eventTypeId), { query: { take: 250 } });
    return Array.isArray(data) ? data : [];
  }

  getWebhook(id: number, eventTypeId?: number): Promise<Webhook> {
    return this.data(`${this.webhooksPath(eventTypeId)}/${id}`);
  }

  createWebhook(body: Body, eventTypeId?: number): Promise<Webhook> {
    return this.data(this.webhooksPath(eventTypeId), { method: 'POST', body });
  }

  updateWebhook(id: number, body: Body, eventTypeId?: number): Promise<Webhook> {
    return this.data(`${this.webhooksPath(eventTypeId)}/${id}`, { method: 'PATCH', body });
  }

  deleteWebhook(id: number, eventTypeId?: number): Promise<unknown> {
    return this.data(`${this.webhooksPath(eventTypeId)}/${id}`, { method: 'DELETE' });
  }
}
