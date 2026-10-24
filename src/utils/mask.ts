import crypto from 'crypto';

/**
 * Mask a secret for logs: keeps the first and last 4 characters.
 */
export function maskSecret(value?: string): string | undefined {
  if (!value) return undefined;
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

/**
 * Short prefix of a hosted user key (usr_xxxxxxxx...) for logs.
 */
export function shortUserKey(userKey: string): string {
  return `${userKey.substring(0, 12)}...`;
}

/**
 * One-way hash used for analytics (client IPs) and cache keys (API keys).
 */
export function shortHash(value: string, length = 12): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, length);
}
