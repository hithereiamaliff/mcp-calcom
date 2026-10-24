/**
 * MCP Key Service client for credential resolution.
 *
 * When KEY_SERVICE_URL and KEY_SERVICE_TOKEN are configured, hosted user keys
 * (usr_<32 hex>) are resolved via the key service, which returns the user's
 * Cal.com connection fields (connector "calcom").
 *
 * KEY_SERVICE_URL is the full resolve URL, e.g. http://mcp-key-service:8090/internal/resolve
 */

import type { ConnectionInput } from '../config.js';
import { shortUserKey } from './mask.js';

export type ResolveResult =
  | { ok: true; credentials: ConnectionInput }
  | { ok: false; reason: 'invalid_key' | 'service_unavailable' | 'malformed_response' };

const KEY_SERVICE_URL = process.env.KEY_SERVICE_URL || '';
const KEY_SERVICE_TOKEN = process.env.KEY_SERVICE_TOKEN || '';
const KEY_SERVICE_SERVER_ID = 'calcom';

export const USER_KEY_PATTERN = /^usr_[a-f0-9]{32}$/;

const CACHE_TTL_MS = 60_000; // 60 seconds
const CLEANUP_INTERVAL_MS = 5 * 60_000; // 5 minutes
const REQUEST_TIMEOUT_MS = 5_000; // 5 seconds

// Cache: only successful resolutions are cached
interface CacheEntry {
  credentials: ConnectionInput;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

// In-flight promise deduplication
const pending = new Map<string, Promise<ResolveResult>>();

// Periodic cache cleanup to prevent unbounded growth
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now >= entry.expiresAt) cache.delete(key);
  }
}, CLEANUP_INTERVAL_MS);
cleanupInterval.unref?.();

/**
 * Returns true if the key service is configured and should be used.
 */
export function isKeyServiceEnabled(): boolean {
  return Boolean(KEY_SERVICE_URL && KEY_SERVICE_TOKEN);
}

export function isKeyServicePartiallyConfigured(): boolean {
  return Boolean(KEY_SERVICE_URL) !== Boolean(KEY_SERVICE_TOKEN);
}

/**
 * Resolve a user API key via the MCP Key Service.
 *
 * Returns a typed result so the caller can distinguish between
 * "invalid key" (403) and "service down" (503).
 */
export async function resolveKeyCredentials(userKey: string): Promise<ResolveResult> {
  const cached = cache.get(userKey);
  if (cached && Date.now() < cached.expiresAt) {
    return { ok: true, credentials: cached.credentials };
  }

  const inflight = pending.get(userKey);
  if (inflight) return inflight;

  const promise = doResolve(userKey);
  pending.set(userKey, promise);

  try {
    return await promise;
  } finally {
    pending.delete(userKey);
  }
}

async function doResolve(userKey: string): Promise<ResolveResult> {
  const shortKey = shortUserKey(userKey);

  try {
    const res = await fetch(KEY_SERVICE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KEY_SERVICE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ key: userKey, server_id: KEY_SERVICE_SERVER_ID }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const contentType = res.headers.get('content-type') || '';
    const isJson = contentType.includes('application/json');

    if (!res.ok) {
      let bodySnippet = '';
      let parsedBody: { valid?: boolean; error?: string; message?: string } | undefined;

      try {
        if (isJson) {
          parsedBody = await res.json() as { valid?: boolean; error?: string; message?: string };
          bodySnippet = JSON.stringify(parsedBody).slice(0, 200);
        } else {
          bodySnippet = (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 200);
        }
      } catch {
        bodySnippet = '';
      }

      // 401 = invalid / revoked / suspended user key (or a key for another connector).
      // 400 / 403 / 500 = problems with this server's own request or token → service problem.
      if (res.status === 401 || res.status === 404) {
        return { ok: false, reason: 'invalid_key' };
      }

      console.error(
        `Key service returned unexpected ${res.status} (${contentType || 'unknown content-type'}) for key ${shortKey}` +
        (bodySnippet ? ` Body: ${bodySnippet}` : ''),
      );
      return { ok: false, reason: 'service_unavailable' };
    }

    if (!isJson) {
      console.error(`Key service returned non-JSON success response (${contentType || 'unknown content-type'}) for key ${shortKey}`);
      return { ok: false, reason: 'malformed_response' };
    }

    const data = await res.json() as { valid?: boolean; credentials?: Record<string, unknown> };

    if (data.valid === false) return { ok: false, reason: 'invalid_key' };
    if (data.valid !== true) {
      console.error(`Key service success response missing valid=true for key ${shortKey}`);
      return { ok: false, reason: 'malformed_response' };
    }

    const creds = data.credentials ?? {};
    const field = (name: string) => (typeof creds[name] === 'string' ? (creds[name] as string) : undefined);

    if (!field('calcom_api_key')?.trim()) {
      console.error(`Key service returned credentials without calcom_api_key for key ${shortKey} (fields: ${Object.keys(creds).join(', ') || 'none'})`);
      return { ok: false, reason: 'malformed_response' };
    }

    const credentials: ConnectionInput = {
      apiUrl: field('calcom_api_url'),
      apiKey: field('calcom_api_key'),
      access: field('calcom_access'),
    };

    cache.set(userKey, { credentials, expiresAt: Date.now() + CACHE_TTL_MS });
    return { ok: true, credentials };
  } catch (error: unknown) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      console.error(`Key service request timed out for key ${shortKey}`);
    } else {
      console.error(`Key service request failed for key ${shortKey}:`, error);
    }
    return { ok: false, reason: 'service_unavailable' };
  }
}
