/**
 * Low-level HTTP helper for Cal API v2.
 *
 * - Bearer API key + the endpoint's cal-api-version header (versions.ts)
 * - per-request timeout (AbortSignal)
 * - no automatic redirects (instance URLs are user-supplied; never follow them to another host)
 * - limited retry on 429, honouring Retry-After / X-RateLimit-Reset-*
 * - uniform CalApiError with Cal's own error code, message and validation details
 * - success envelopes ({ status: "success", data, pagination }) unwrapped
 */

import { Agent, type Dispatcher, fetch } from 'undici';
import { createGuardedLookup } from '../config.js';
import { REPOSITORY_URL, SERVER_VERSION } from '../version.js';
import { apiVersionFor } from './versions.js';

let guardedDispatcher: Dispatcher | undefined;

/**
 * HTTP server mode: validate every connection's resolved address (SSRF / DNS rebinding).
 * CLI mode leaves this off so local and private instances keep working.
 */
export function configurePrivateAddressGuard(enabled: boolean, allowedHosts: string[] = []): void {
  guardedDispatcher = enabled ? new Agent({ connect: { lookup: createGuardedLookup(allowedHosts) } }) : undefined;
}

const configuredTimeout = Number(process.env.CALCOM_TIMEOUT_MS);
export const DEFAULT_TIMEOUT_MS = Number.isInteger(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 30_000;
const MAX_429_RETRIES = 2;
/** Longer rate-limit waits are reported to the caller instead of slept through */
const MAX_RETRY_WAIT_SECONDS = 10;
const USER_AGENT = `mcp-calcom/${SERVER_VERSION} (+${REPOSITORY_URL})`;

export type QueryValue = string | number | boolean | null | undefined | Array<string | number>;

export interface CalRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  query?: Record<string, QueryValue>;
  body?: unknown;
  timeoutMs?: number;
}

export interface Pagination {
  totalItems?: number;
  remainingItems?: number;
  returnedItems?: number;
  itemsPerPage?: number;
  currentPage?: number;
  totalPages?: number;
  hasNextPage?: boolean;
  hasPreviousPage?: boolean;
}

export interface RateLimitInfo {
  limit?: number;
  remaining?: number;
  /** Seconds until the window (or block) resets */
  resetSeconds?: number;
}

export interface CalResponse<T> {
  status: number;
  data: T;
  pagination?: Pagination;
  rateLimit?: RateLimitInfo;
}

export class CalApiError extends Error {
  public readonly code?: string;
  /** Flattened validation messages ("attendee.timeZone must be a valid IANA time zone") */
  public readonly details: string[];
  /** The server answered with an HTML page — usually the Cal web app, not API v2 */
  public readonly html: boolean;
  public readonly retryAfterSeconds?: number;

  constructor(
    /** HTTP status, or 0 for network errors / timeouts */
    public readonly status: number,
    message: string,
    public readonly endpoint: string,
    extra: { code?: string; details?: string[]; html?: boolean; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = 'CalApiError';
    this.code = extra.code;
    this.details = extra.details ?? [];
    this.html = extra.html ?? false;
    this.retryAfterSeconds = extra.retryAfterSeconds;
  }
}

// =============================================================================
// Error bodies
// =============================================================================

/** Flatten class-validator errors ({ property, constraints, children }) into readable lines */
export function flattenValidationErrors(errors: unknown, parent = ''): string[] {
  if (!Array.isArray(errors)) return [];
  const lines: string[] = [];
  for (const item of errors) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { property?: unknown; constraints?: Record<string, unknown>; children?: unknown };
    const property = typeof record.property === 'string' ? record.property : '';
    const path = [parent, property].filter(Boolean).join('.');
    for (const message of Object.values(record.constraints ?? {})) {
      if (typeof message !== 'string') continue;
      // class-validator messages usually start with the property name already
      if (property && message.startsWith(property)) {
        lines.push(parent ? `${parent}.${message}` : message);
      } else {
        lines.push(path ? `${path}: ${message}` : message);
      }
    }
    lines.push(...flattenValidationErrors(record.children, path));
  }
  return lines;
}

function detailLines(details: unknown, message?: string): string[] {
  if (!details) return [];
  if (typeof details === 'string') return details === message ? [] : [details];
  if (typeof details !== 'object') return [];

  const record = details as Record<string, unknown>;
  const validation = flattenValidationErrors(record.errors);
  if (validation.length) return validation;
  if (Array.isArray(record.message)) {
    return record.message.filter((line): line is string => typeof line === 'string');
  }
  if (typeof record.message === 'string' && record.message !== message) return [record.message];
  return [];
}

/**
 * Pull code / message / details out of Cal's error shapes:
 *   { status: "error", error: { code, message, details } }   (HttpException, Zod, Prisma, tRPC filters)
 *   { message, error, statusCode }                             (plain Nest errors)
 */
export function extractCalError(body: unknown): { code?: string; message?: string; details: string[] } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { details: [] };
  const record = body as Record<string, unknown>;

  if (record.error && typeof record.error === 'object') {
    const error = record.error as { code?: unknown; message?: unknown; details?: unknown };
    const message = typeof error.message === 'string' ? error.message.replace(/,\s*$/, '').trim() : undefined;
    return {
      code: typeof error.code === 'string' ? error.code : undefined,
      message,
      details: detailLines(error.details, message),
    };
  }

  const message = typeof record.message === 'string'
    ? record.message
    : Array.isArray(record.message)
      ? record.message.filter(line => typeof line === 'string').join('; ')
      : typeof record.error === 'string' ? record.error : undefined;
  return { message, details: [] };
}

// =============================================================================
// Request
// =============================================================================

function buildUrl(baseUrl: string, path: string, query?: CalRequestOptions['query']): string {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length) url.searchParams.set(key, value.join(','));
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function readRateLimit(headers: { forEach(callback: (value: string, key: string) => void): void }): RateLimitInfo | undefined {
  const info: RateLimitInfo = {};
  let found = false;
  headers.forEach((value, key) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return;
    const name = key.toLowerCase();
    if (name.startsWith('x-ratelimit-limit')) {
      info.limit = info.limit === undefined ? number : Math.min(info.limit, number);
      found = true;
    } else if (name.startsWith('x-ratelimit-remaining')) {
      info.remaining = info.remaining === undefined ? number : Math.min(info.remaining, number);
      found = true;
    } else if (name.startsWith('x-ratelimit-reset')) {
      info.resetSeconds = info.resetSeconds === undefined ? number : Math.max(info.resetSeconds, number);
      found = true;
    }
  });
  return found ? info : undefined;
}

function retryAfterSeconds(headers: { get(name: string): string | null }, rateLimit?: RateLimitInfo): number | undefined {
  const retryAfter = Number(headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter;
  return rateLimit?.resetSeconds && rateLimit.resetSeconds > 0 ? rateLimit.resetSeconds : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function calRequest<T = unknown>(
  baseUrl: string,
  apiKey: string,
  path: string,
  options: CalRequestOptions = {},
): Promise<CalResponse<T>> {
  const method = options.method ?? 'GET';
  const url = buildUrl(baseUrl, path, options.query);
  const endpoint = `${method} ${path}`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'User-Agent': USER_AGENT,
  };
  const apiVersion = apiVersionFor(path);
  if (apiVersion) headers['cal-api-version'] = apiVersion;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  for (let attempt = 0; ; attempt++) {
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        dispatcher: guardedDispatcher,
      });
    } catch (error) {
      const isTimeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      const reason = isTimeout
        ? `timed out after ${Math.round(timeoutMs / 1000)}s`
        : `failed (${error instanceof Error ? (error.cause as Error | undefined)?.message || error.message : String(error)})`;
      throw new CalApiError(0, `Request to the Cal.com API ${reason}.`, endpoint);
    }

    const rateLimit = readRateLimit(response.headers);

    if (response.status === 429) {
      const wait = retryAfterSeconds(response.headers, rateLimit);
      if (attempt < MAX_429_RETRIES && (wait === undefined || wait <= MAX_RETRY_WAIT_SECONDS)) {
        // Release the connection before retrying
        await response.body?.cancel().catch(() => {});
        await sleep(wait !== undefined ? wait * 1000 : 1000 * 2 ** attempt);
        continue;
      }
    }

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      const location = response.headers.get('location') || 'another URL';
      throw new CalApiError(
        response.status,
        `The Cal.com API redirected the request to ${location}. Set the API URL to the final address (https, correct host and path).`,
        endpoint,
      );
    }

    const text = await response.text();
    const contentType = response.headers.get('content-type') || '';
    const isJson = contentType.includes('json');
    let body: unknown = null;
    if (text) {
      if (isJson) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      } else {
        body = text;
      }
    }
    const html = !isJson && /^\s*</.test(text);

    if (!response.ok) {
      const { code, message, details } = extractCalError(body);
      const fallback = html
        ? `The server returned an HTML page (HTTP ${response.status}) instead of a JSON API response.`
        : typeof body === 'string' && body
          ? body.slice(0, 300)
          : response.statusText || `HTTP ${response.status}`;
      throw new CalApiError(response.status, message || fallback, endpoint, {
        code,
        details,
        html,
        retryAfterSeconds: response.status === 429 ? retryAfterSeconds(response.headers, rateLimit) : undefined,
      });
    }

    if (html) {
      throw new CalApiError(response.status, 'The server returned an HTML page instead of a JSON API response.', endpoint, { html: true });
    }

    if (body && typeof body === 'object' && !Array.isArray(body) && 'data' in body && (body as { status?: unknown }).status === 'success') {
      const envelope = body as { data: T; pagination?: Pagination };
      return { status: response.status, data: envelope.data, pagination: envelope.pagination, rateLimit };
    }
    return { status: response.status, data: body as T, rateLimit };
  }
}
