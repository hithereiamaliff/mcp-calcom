/**
 * Server usage analytics — request / tool-call counters.
 *
 * Persisted to Firebase Realtime Database (primary, when credentials are mounted) and a
 * local JSON file (backup). Client IPs are stored only as short sha256 hashes and hosted
 * user keys never appear in recorded routes.
 */

import fs from 'fs';
import path from 'path';
import type { Request } from 'express';
import { shortHash } from '../utils/mask.js';
import { type Analytics, FirebaseAnalytics } from './firebase-analytics.js';

const MAX_RECENT_CALLS = 100;

function emptyAnalytics(): Analytics {
  return {
    serverStartTime: new Date().toISOString(),
    totalRequests: 0,
    totalToolCalls: 0,
    requestsByMethod: {},
    requestsByEndpoint: {},
    toolCalls: {},
    recentToolCalls: [],
    clientsByIp: {},
    clientsByUserAgent: {},
    hourlyRequests: {},
  };
}

const FIREBASE_TIMEOUT_MS = 10_000;

// Firebase keys may not contain . # $ / [ ] or ASCII control characters (0-31, 127).
// Percent-encode them (and %) reversibly, so keys loaded back from Firebase match the
// in-memory keys exactly instead of colliding with them.
export function encodeFirebaseKey(key: string): string {
  return key.replace(/[%.#$/[\]\x00-\x1f\x7f]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

export function decodeFirebaseKey(key: string): string {
  return key.replace(/%([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function mapKeys(value: unknown, transform: (key: string) => string): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map(item => mapKeys(item, transform));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, inner]) => [transform(key), mapKeys(inner, transform)]),
  );
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${FIREBASE_TIMEOUT_MS / 1000}s`)), FIREBASE_TIMEOUT_MS);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sortedEntries(record: Record<string, number>, limit?: number): Record<string, number> {
  const entries = Object.entries(record).sort(([, a], [, b]) => b - a);
  return Object.fromEntries(limit ? entries.slice(0, limit) : entries);
}

export function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

export class UsageAnalytics {
  private data: Analytics = emptyAnalytics();
  private readonly firebase: FirebaseAnalytics;
  private readonly file: string;
  private saveTimer?: NodeJS.Timeout;

  constructor(serverName: string, private readonly dataDir: string) {
    this.firebase = new FirebaseAnalytics(serverName);
    this.file = path.join(dataDir, 'analytics.json');
  }

  get firebaseEnabled(): boolean {
    return this.firebase.isInitialized();
  }

  async load(): Promise<void> {
    if (this.firebase.isInitialized()) {
      try {
        // RTDB reads wait indefinitely while the database is unreachable — never block startup on them
        const remote = await withTimeout(this.firebase.loadAnalytics(), 'Firebase analytics load');
        if (remote) {
          this.data = { ...emptyAnalytics(), ...(mapKeys(remote, decodeFirebaseKey) as Analytics) };
          console.log(`📊 Loaded analytics from Firebase (${this.data.totalRequests} requests, ${this.data.totalToolCalls} tool calls)`);
          return;
        }
      } catch (error) {
        console.error('⚠️ Firebase analytics load failed, falling back to the local file:', error instanceof Error ? error.message : error);
      }
    }
    try {
      if (fs.existsSync(this.file)) {
        this.data = { ...emptyAnalytics(), ...JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Analytics };
        console.log(`📊 Loaded analytics from ${this.file}`);
      } else {
        console.log('📊 No existing analytics found, starting fresh');
      }
    } catch (error) {
      console.error('⚠️ Failed to load analytics, starting fresh:', error);
    }
  }

  async save(): Promise<void> {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (error) {
      console.error('⚠️ Failed to save analytics locally:', error);
    }
    if (this.firebase.isInitialized()) {
      try {
        await withTimeout(this.firebase.saveAnalytics(mapKeys(this.data, encodeFirebaseKey) as Analytics), 'Firebase analytics save');
      } catch (error) {
        console.error('⚠️ Failed to save analytics to Firebase:', error instanceof Error ? error.message : error);
      }
    }
  }

  start(intervalMs = 60_000): void {
    this.saveTimer = setInterval(() => void this.save(), intervalMs);
    this.saveTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.saveTimer) clearInterval(this.saveTimer);
    await this.save();
  }

  trackRequest(req: Request, endpoint: string): void {
    const data = this.data;
    data.totalRequests++;
    data.requestsByMethod[req.method] = (data.requestsByMethod[req.method] || 0) + 1;
    data.requestsByEndpoint[endpoint] = (data.requestsByEndpoint[endpoint] || 0) + 1;

    const ipHash = shortHash(clientIp(req));
    data.clientsByIp[ipHash] = (data.clientsByIp[ipHash] || 0) + 1;

    const userAgent = (req.get('user-agent') || 'unknown').substring(0, 50);
    data.clientsByUserAgent[userAgent] = (data.clientsByUserAgent[userAgent] || 0) + 1;

    const hour = new Date().toISOString().substring(0, 13);
    data.hourlyRequests[hour] = (data.hourlyRequests[hour] || 0) + 1;
  }

  trackToolCall(toolName: string, req: Request): void {
    const data = this.data;
    data.totalToolCalls++;
    data.toolCalls[toolName] = (data.toolCalls[toolName] || 0) + 1;
    data.recentToolCalls.unshift({
      tool: toolName,
      timestamp: new Date().toISOString(),
      clientIp: shortHash(clientIp(req)),
      userAgent: (req.get('user-agent') || 'unknown').substring(0, 50),
    });
    if (data.recentToolCalls.length > MAX_RECENT_CALLS) data.recentToolCalls.length = MAX_RECENT_CALLS;
  }

  importTotals(totals: { totalRequests?: unknown; totalToolCalls?: unknown }): void {
    if (typeof totals.totalRequests === 'number' && totals.totalRequests > 0) this.data.totalRequests += totals.totalRequests;
    if (typeof totals.totalToolCalls === 'number' && totals.totalToolCalls > 0) this.data.totalToolCalls += totals.totalToolCalls;
  }

  uptime(): string {
    const diff = Date.now() - new Date(this.data.serverStartTime).getTime();
    const days = Math.floor(diff / 86_400_000);
    const hours = Math.floor((diff % 86_400_000) / 3_600_000);
    const minutes = Math.floor((diff % 3_600_000) / 60_000);
    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  summary(serverName: string) {
    const data = this.data;
    const last24Hours = Object.fromEntries(
      Object.entries(data.hourlyRequests).sort(([a], [b]) => b.localeCompare(a)).slice(0, 24).reverse(),
    );
    return {
      server: serverName,
      uptime: this.uptime(),
      serverStartTime: data.serverStartTime,
      firebase: this.firebaseEnabled ? 'enabled' : 'disabled',
      summary: {
        totalRequests: data.totalRequests,
        totalToolCalls: data.totalToolCalls,
        uniqueClients: Object.keys(data.clientsByIp).length,
      },
      breakdown: {
        byMethod: data.requestsByMethod,
        byEndpoint: data.requestsByEndpoint,
        byTool: sortedEntries(data.toolCalls),
      },
      hourlyRequests: last24Hours,
      clients: {
        byIpHash: sortedEntries(data.clientsByIp, 20),
        byUserAgent: sortedEntries(data.clientsByUserAgent, 20),
      },
      recentToolCalls: data.recentToolCalls.slice(0, 20),
    };
  }

  toolsSummary() {
    const data = this.data;
    return {
      totalToolCalls: data.totalToolCalls,
      tools: Object.entries(data.toolCalls)
        .sort(([, a], [, b]) => b - a)
        .map(([tool, count]) => ({
          tool,
          count,
          percentage: data.totalToolCalls > 0 ? `${((count / data.totalToolCalls) * 100).toFixed(1)}%` : '0%',
        })),
      recentCalls: data.recentToolCalls.slice(0, 50),
    };
  }
}
