/**
 * Account profile (/v2/me): the user's time zone, username, week start and time format drive
 * defaults and formatting in almost every tool. Cached per (API URL, key) for 10 minutes and
 * shared across requests; concurrent lookups share one call.
 */

import { pruneExpired } from '../config.js';
import type { CalClient } from './client.js';
import { isValidTimeZone, type TimeFormat } from './time.js';
import type { Me } from './types.js';

export interface AccountProfile {
  id: number;
  username: string;
  email: string;
  name?: string | null;
  /** Always a valid IANA zone (UTC when the profile has none) */
  timeZone: string;
  timeZoneFromProfile: boolean;
  weekStart: string;
  timeFormat: TimeFormat;
  defaultScheduleId?: number | null;
  locale?: string | null;
  bio?: string | null;
  organizationId?: number | null;
}

const PROFILE_TTL_MS = 10 * 60_000;

const cache = new Map<string, { profile: AccountProfile; expiresAt: number }>();
const pending = new Map<string, Promise<AccountProfile>>();

export function toProfile(me: Me): AccountProfile {
  const timeZoneFromProfile = Boolean(me.timeZone && isValidTimeZone(me.timeZone));
  return {
    id: me.id,
    username: me.username,
    email: me.email,
    name: me.name,
    timeZone: timeZoneFromProfile ? (me.timeZone as string) : 'UTC',
    timeZoneFromProfile,
    weekStart: me.weekStart || 'Monday',
    timeFormat: me.timeFormat === 12 ? 12 : 24,
    defaultScheduleId: me.defaultScheduleId,
    locale: me.locale,
    bio: me.bio,
    organizationId: me.organizationId,
  };
}

export function rememberProfile(client: CalClient, me: Me): AccountProfile {
  const profile = toProfile(me);
  pruneExpired(cache, 500);
  cache.set(client.identity, { profile, expiresAt: Date.now() + PROFILE_TTL_MS });
  return profile;
}

export async function getProfile(client: CalClient, options: { fresh?: boolean } = {}): Promise<AccountProfile> {
  const key = client.identity;

  if (!options.fresh) {
    const cached = cache.get(key);
    if (cached && Date.now() < cached.expiresAt) return cached.profile;
  }

  const inflight = pending.get(key);
  if (inflight) return inflight;

  const promise = client
    .getMe()
    .then(me => rememberProfile(client, me))
    .finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}

/** Profile if already cached (no network) */
export function getCachedProfile(client: CalClient): AccountProfile | undefined {
  const cached = cache.get(client.identity);
  return cached && Date.now() < cached.expiresAt ? cached.profile : undefined;
}
