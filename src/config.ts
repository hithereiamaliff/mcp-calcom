/**
 * Connection configuration for a single Cal.com / Cal.diy account.
 *
 * Credentials arrive from three places (key-service, self-hosted headers, CLI env)
 * as loosely-typed strings. normalizeConnection() turns them into one validated
 * shape so the rest of the server never deals with raw input.
 */

import dns from 'dns';
import net, { type LookupFunction } from 'net';

export const DEFAULT_CALCOM_API_URL = 'https://api.cal.com/v2';

/** read: view only · bookings: + booking actions · full: + configuration changes */
export const ACCESS_LEVELS = ['read', 'bookings', 'full'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export interface ConnectionInput {
  apiUrl?: string | null;
  apiKey?: string | null;
  access?: string | null;
}

export interface CalcomConnection {
  /** API v2 base URL without trailing slash, e.g. https://cal.example.com/api/v2 */
  baseUrl: string;
  /** Cal API key, sent as a Bearer token (cal_…) */
  apiKey: string;
  access: AccessLevel;
  /** Cal.com Cloud (api.cal.com) rather than a self-hosted instance */
  isCloud: boolean;
  /** Non-fatal configuration problems, surfaced by hello / get_instance_info */
  warnings: string[];
}

export class ConnectionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionConfigError';
  }
}

// =============================================================================
// Parsing helpers
// =============================================================================

const CLOUD_API_HOST = 'api.cal.com';
const CLOUD_WEB_HOSTS = new Set(['cal.com', 'www.cal.com', 'app.cal.com']);

/**
 * Turn whatever the user pasted into the API v2 base URL:
 *   (blank) / cal.com / app.cal.com / api.cal.com  → https://api.cal.com/v2
 *   https://host/…/v2[/anything]                    → cut back to …/v2
 *   https://host[/path]                             → …/api/v2  (API v2 serves /api/v2/* by default)
 */
export function normalizeApiUrl(raw?: string | null): string {
  const value = (raw ?? '').trim();
  if (!value) return DEFAULT_CALCOM_API_URL;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ConnectionConfigError(`Invalid Cal.com API URL "${value}".`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConnectionConfigError(`Cal.com API URL must use http or https (got "${url.protocol}").`);
  }
  if (url.username || url.password) {
    throw new ConnectionConfigError('Cal.com API URL must not contain credentials.');
  }
  if (url.search || url.hash) {
    throw new ConnectionConfigError('Cal.com API URL must not contain a query string or fragment.');
  }

  const host = url.hostname.toLowerCase();
  if (host === CLOUD_API_HOST || CLOUD_WEB_HOSTS.has(host)) return DEFAULT_CALCOM_API_URL;

  let path = url.pathname.replace(/\/+$/, '');
  const v2 = /\/v2(?=\/|$)/i.exec(path);
  path = v2 ? path.slice(0, v2.index + 3) : `${path}/api/v2`;
  return `${url.protocol}//${url.host}${path}`;
}

const ACCESS_ALIASES = new Map<string, AccessLevel>([
  ...['', 'read', 'readonly', 'read-only', 'read_only', 'ro', 'view', 'none', 'no', 'false', '0'].map(value => [value, 'read'] as const),
  ...['bookings', 'booking', 'book'].map(value => [value, 'bookings'] as const),
  ...['full', 'all', 'admin', 'manage', 'write', 'writes', 'yes', 'true', '1'].map(value => [value, 'full'] as const),
]);

export function parseAccess(raw?: string | null): { access: AccessLevel; warning?: string } {
  const access = ACCESS_ALIASES.get((raw ?? '').trim().toLowerCase());
  if (access) return { access };
  return {
    access: 'read',
    warning: `Unknown access level "${raw}" — using read-only. Use "read", "bookings" or "full".`,
  };
}

export function allowsAccess(connection: Pick<CalcomConnection, 'access'>, level: AccessLevel): boolean {
  return ACCESS_LEVELS.indexOf(connection.access) >= ACCESS_LEVELS.indexOf(level);
}

export function normalizeApiKey(raw?: string | null): { apiKey: string; warnings: string[] } {
  const apiKey = (raw ?? '').trim().replace(/^bearer\s+/i, '').trim();
  if (!apiKey) {
    throw new ConnectionConfigError('Missing Cal.com API key.');
  }
  if (/\s/.test(apiKey)) {
    throw new ConnectionConfigError('The Cal.com API key must not contain spaces.');
  }
  if (/^usr_[a-f0-9]{32}$/i.test(apiKey)) {
    throw new ConnectionConfigError(
      'That is an MCP Key Service key (usr_…), not a Cal.com API key. Create a Cal API key at Settings → Developer → API Keys.',
    );
  }

  const warnings: string[] = [];
  if (!apiKey.startsWith('cal_')) {
    warnings.push(
      'The API key does not start with "cal_". That is fine if your instance uses a custom API_KEY_PREFIX; ' +
      'otherwise create a key at Settings → Developer → API Keys.',
    );
  }
  return { apiKey, warnings };
}

export function isCloudUrl(baseUrl: string): boolean {
  return new URL(baseUrl).hostname.toLowerCase() === CLOUD_API_HOST;
}

export function normalizeConnection(input: ConnectionInput): CalcomConnection {
  const { apiKey, warnings } = normalizeApiKey(input.apiKey);
  const baseUrl = normalizeApiUrl(input.apiUrl);
  const { access, warning } = parseAccess(input.access);
  if (warning) warnings.push(warning);

  return {
    baseUrl,
    apiKey,
    access,
    isCloud: isCloudUrl(baseUrl),
    warnings,
  };
}

// =============================================================================
// SSRF guard — user-supplied instance URLs must not reach internal services
// =============================================================================

// Separate lists: Node's BlockList maps IPv4 into ::ffff:0:0/96, so mixing families
// in one list makes IPv6 rules match IPv4 addresses.
const privateIpv4 = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
  privateIpv4.addSubnet(address, prefix, 'ipv4');
}

const privateIpv6 = new net.BlockList();
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) {
  privateIpv6.addSubnet(address, prefix, 'ipv6');
}

/** IPv4-mapped IPv6 (::ffff:10.0.0.1 or ::ffff:a00:1) → embedded IPv4 */
function embeddedIpv4(address: string): string | undefined {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
  }
  return undefined;
}

export function isPrivateAddress(address: string): boolean {
  const mapped = embeddedIpv4(address);
  if (mapped) return privateIpv4.check(mapped, 'ipv4');

  const family = net.isIP(address);
  if (family === 4) return privateIpv4.check(address, 'ipv4');
  if (family === 6) return privateIpv6.check(address, 'ipv6');
  return true;
}

/**
 * net/tls `lookup` hook that refuses private addresses at connect time, so the address
 * that was checked is the address actually connected to (no DNS-rebinding window).
 * Node does not call `lookup` for IP literals — assertPublicHost covers those.
 */
export function createGuardedLookup(allowedHosts: string[] = []): LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error, '', 4);
        return;
      }
      if (!allowedHosts.includes(hostname.toLowerCase()) && addresses.some(({ address }) => isPrivateAddress(address))) {
        const blocked = Object.assign(
          new Error(`Cal.com host "${hostname}" resolves to a private or internal address, which is not allowed on this server.`),
          { code: 'EPRIVATEADDRESS' },
        );
        callback(blocked, '', 4);
        return;
      }
      if (options.all) {
        callback(null, addresses);
      } else {
        callback(null, addresses[0].address, addresses[0].family);
      }
    });
  };
}

/** Drop expired entries once a cache grows past maxSize */
export function pruneExpired<V extends { expiresAt: number }>(map: Map<string, V>, maxSize: number): void {
  if (map.size < maxSize) return;
  const now = Date.now();
  for (const [key, entry] of map) {
    if (now >= entry.expiresAt) map.delete(key);
  }
}

/**
 * Reject API URLs whose host is a private / loopback / link-local IP literal, unless
 * allow-listed by the operator. Node never calls `lookup` for IP literals, so this covers
 * what the connect-time guard (createGuardedLookup) cannot; hostnames are checked there,
 * on the address actually connected to.
 */
export async function assertPublicHost(baseUrl: string, allowedHosts: string[] = []): Promise<void> {
  const hostname = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (allowedHosts.includes(hostname) || !net.isIP(hostname)) return;

  if (isPrivateAddress(hostname)) {
    throw new ConnectionConfigError(
      `Cal.com host "${hostname}" is a private or internal address, which is not allowed on this server.`,
    );
  }
}
