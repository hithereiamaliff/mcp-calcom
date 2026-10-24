#!/usr/bin/env node
/**
 * Cal.com MCP Server - Streamable HTTP Transport
 *
 * Production HTTP server for self-hosting on a VPS behind nginx.
 * Auth modes:
 *   - hosted key-service:  /mcp/usr_<key>, /mcp?api_key=usr_<key>, or /mcp + Authorization: Bearer usr_<key>
 *   - self-hosted:         /mcp + X-API-Key (MCP_API_KEY) + X-Calcom-* headers
 * Per-request McpServer/Transport isolation (stateless), following the mcp-github v2 pattern.
 *
 * Usage:
 *   npm run build
 *   node dist/http-server.js
 */

import crypto from 'crypto';
import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { renderDashboard } from './analytics/dashboard.js';
import { UsageAnalytics } from './analytics/tracker.js';
import { configurePrivateAddressGuard } from './calcom/http.js';
import {
  type CalcomConnection,
  ConnectionConfigError,
  type ConnectionInput,
  assertPublicHost,
  normalizeConnection,
} from './config.js';
import { createAppServer } from './index.js';
import { HttpError } from './utils/http-error.js';
import {
  USER_KEY_PATTERN,
  isKeyServiceEnabled,
  isKeyServicePartiallyConfigured,
  resolveKeyCredentials,
} from './utils/key-service.js';
import { maskSecret, shortUserKey } from './utils/mask.js';
import { ANALYTICS_ID, REPOSITORY_URL, SERVER_NAME, SERVER_VERSION } from './version.js';

// =============================================================================
// Configuration
// =============================================================================

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const MCP_API_KEY = process.env.MCP_API_KEY || '';
const ENABLE_MCP_DIAGNOSTICS = process.env.ENABLE_MCP_DIAGNOSTICS === 'true';
const MCP_TRACE_HTTP = process.env.MCP_TRACE_HTTP === 'true';
const ANALYTICS_DIR = process.env.ANALYTICS_DIR || '/app/data';
const PUBLIC_BASE_PATH = normalizePublicBasePath(process.env.PUBLIC_BASE_PATH || '');
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
const ALLOW_ALL_ORIGINS = ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes('*');
const ALLOW_PRIVATE_CALCOM_HOSTS = (process.env.ALLOW_PRIVATE_CALCOM_HOSTS || '')
  .split(',')
  .map(host => host.trim().toLowerCase())
  .filter(Boolean);

type AuthMode = 'hosted-key-service' | 'self-hosted' | 'diagnostics';

if (isKeyServicePartiallyConfigured()) {
  console.error('Hosted key-service mode requires both KEY_SERVICE_URL and KEY_SERVICE_TOKEN. Set both or neither.');
  process.exit(1);
}

if (!MCP_API_KEY) {
  console.warn('MCP_API_KEY is not set. Self-hosted /mcp mode and /analytics access are disabled.');
}

// User-supplied API URLs: refuse private addresses at connect time
configurePrivateAddressGuard(true, ALLOW_PRIVATE_CALCOM_HOSTS);

// =============================================================================
// Utility functions
// =============================================================================

function normalizePublicBasePath(basePath: string): string {
  const trimmed = basePath.trim();
  if (!trimmed || trimmed === '/') return '';
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, '');
}

function withPublicBasePath(route: string): string {
  return `${PUBLIC_BASE_PATH}${route}`;
}

function safeEqual(a: string, b: string): boolean {
  const left = crypto.createHash('sha256').update(a).digest();
  const right = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(left, right);
}

const KNOWN_ROUTES = new Set(['/', '/health', '/mcp', '/mcp-debug/open', '/.well-known/mcp/server-card.json']);

/** Bounded route labels — unknown paths must not create new analytics keys */
function normalizeRouteForAnalytics(req: Request): string {
  if (req.path.startsWith('/mcp/')) return '/mcp/:userKey';
  if (KNOWN_ROUTES.has(req.path)) return req.path;
  if (req.path.startsWith('/.well-known/')) return '/.well-known/*';
  return 'other';
}

function traceHttp(req: Request, res: Response, details: Record<string, unknown> = {}): void {
  if (!MCP_TRACE_HTTP) return;
  console.log('[mcp-http]', {
    method: req.method,
    path: normalizeRouteForAnalytics(req),
    accept: req.get('accept'),
    contentType: req.get('content-type'),
    protocolVersion: req.get('mcp-protocol-version'),
    rpcMethod: req.body?.method,
    status: res.statusCode,
    ...details,
  });
}

function getHostedUserKeyFromQuery(req: Request): string | undefined {
  const candidate = req.query.api_key ?? req.query.apiKey;
  return typeof candidate === 'string' && candidate.startsWith('usr_') ? candidate : undefined;
}

/** Authorization: Bearer usr_… keeps the hosted key out of URLs */
function getHostedUserKeyFromHeader(req: Request): string | undefined {
  const match = /^Bearer\s+(usr_\S+)$/i.exec(req.get('Authorization') ?? '');
  return match?.[1];
}

function hostedUserKey(req: Request): string | undefined {
  return req.params.userKey ?? getHostedUserKeyFromQuery(req) ?? getHostedUserKeyFromHeader(req);
}

function jsonRpcErrorCode(status: number): number {
  if (status === 401 || status === 403) return -32001;
  if (status === 405) return -32000;
  if (status >= 500) return -32603;
  return -32600;
}

function sendHttpError(res: Response, error: HttpError): void {
  if (res.headersSent) return;
  res.status(error.status).json({
    jsonrpc: '2.0',
    error: { code: jsonRpcErrorCode(error.status), message: error.message, data: { reason: error.code } },
    id: null,
  });
}

// =============================================================================
// Analytics
// =============================================================================

const analytics = new UsageAnalytics(ANALYTICS_ID, ANALYTICS_DIR);
// Load before serving: load() replaces the in-memory counters
await analytics.load();
analytics.start();

function requireApiKey(req: Request, res: Response): boolean {
  if (!MCP_API_KEY) {
    res.status(503).json({
      error: 'server_misconfigured',
      message: 'MCP_API_KEY is required to access analytics on this deployment.',
    });
    return false;
  }
  const providedKey = req.get('X-API-Key');
  if (providedKey && safeEqual(providedKey, MCP_API_KEY)) return true;
  res.status(401).json({ error: 'unauthorized', message: 'Valid X-API-Key header required' });
  return false;
}

// =============================================================================
// Credential resolution
// =============================================================================

async function resolveHostedConnection(req: Request): Promise<ConnectionInput> {
  const userKey = hostedUserKey(req);

  if (typeof userKey !== 'string' || !USER_KEY_PATTERN.test(userKey)) {
    throw new HttpError(403, 'invalid_key', 'Missing or malformed user key. Expected usr_ followed by 32 hex characters.');
  }
  if (!isKeyServiceEnabled()) {
    throw new HttpError(503, 'service_unavailable', 'Hosted key-service mode is not configured on this server.');
  }

  const result = await resolveKeyCredentials(userKey);
  if (!result.ok) {
    if (result.reason === 'invalid_key') {
      throw new HttpError(403, 'invalid_key', 'Invalid or expired API key. Check or rotate it at https://mcpkeys.techmavie.digital');
    }
    if (result.reason === 'malformed_response') {
      throw new HttpError(502, 'malformed_response', 'Key service returned an unexpected response.');
    }
    throw new HttpError(503, 'service_unavailable', 'Key service temporarily unavailable. Please retry shortly.');
  }

  return result.credentials;
}

function resolveSelfHostedConnection(req: Request): ConnectionInput {
  if (!MCP_API_KEY) {
    throw new HttpError(503, 'server_misconfigured', 'MCP_API_KEY is required to use self-hosted /mcp mode.');
  }

  const apiKey = req.get('X-API-Key');
  if (!apiKey || !safeEqual(apiKey, MCP_API_KEY)) {
    throw new HttpError(403, 'invalid_key', 'Invalid or missing X-API-Key header.');
  }

  const calcomKey = req.get('X-Calcom-Api-Key');
  if (!calcomKey) {
    throw new HttpError(400, 'missing_config', 'Missing X-Calcom-Api-Key header (your Cal.com / Cal.diy API key).');
  }

  return {
    apiKey: calcomKey,
    apiUrl: req.get('X-Calcom-Api-Url'),
    access: req.get('X-Calcom-Access'),
  };
}

async function resolveConnection(req: Request, authMode: AuthMode): Promise<CalcomConnection> {
  const input = authMode === 'hosted-key-service'
    ? await resolveHostedConnection(req)
    : resolveSelfHostedConnection(req);

  try {
    const connection = normalizeConnection(input);
    await assertPublicHost(connection.baseUrl, ALLOW_PRIVATE_CALCOM_HOSTS);
    return connection;
  } catch (error) {
    if (error instanceof ConnectionConfigError) {
      throw new HttpError(400, 'invalid_config', error.message);
    }
    throw error;
  }
}

// =============================================================================
// MCP server factories
// =============================================================================

function createDiagnosticsServer(): McpServer {
  const server = new McpServer({ name: `${SERVER_NAME} (Diagnostics)`, version: SERVER_VERSION });
  server.registerTool(
    'diagnostics_ping',
    { description: 'Minimal tool to verify transport and initialization', inputSchema: {} },
    async () => ({ content: [{ type: 'text', text: 'pong' }] }),
  );
  return server;
}

function buildServerCard() {
  return {
    $schema: 'https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json',
    version: '1.0',
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    transport: { type: 'streamable-http', endpoint: withPublicBasePath('/mcp') },
    authentication: { required: true },
    tools: ['dynamic'],
  };
}

// =============================================================================
// Per-request MCP handler
// =============================================================================

async function handleMcpRequest(req: Request, res: Response, authMode: AuthMode): Promise<void> {
  // Stateless server: no standalone SSE stream (GET) and no sessions to delete (DELETE)
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    throw new HttpError(405, 'method_not_allowed', 'Method not allowed. This stateless MCP endpoint only accepts POST.');
  }

  // The SDK requires both media types in Accept; clients that can't take SSE get plain JSON back
  const accept = req.headers.accept || '';
  const acceptsEventStream = accept.includes('text/event-stream') || accept.includes('*/*');
  if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
    req.headers.accept = 'application/json, text/event-stream';
  }

  let server: McpServer;
  let maskedKey: string | undefined;
  if (authMode === 'diagnostics') {
    server = createDiagnosticsServer();
  } else {
    const connection = await resolveConnection(req, authMode);
    if (authMode === 'hosted-key-service') {
      const userKey = hostedUserKey(req);
      maskedKey = userKey ? shortUserKey(userKey) : undefined;
    } else {
      maskedKey = maskSecret(connection.apiKey);
    }
    server = createAppServer(connection, { transport: 'streamable-http', authMode });
  }

  // A POST body may be a single JSON-RPC message or a batch array
  const messages: unknown[] = Array.isArray(req.body) ? req.body : [req.body];
  for (const message of messages) {
    const rpc = message as { method?: unknown; params?: { name?: unknown } } | undefined;
    if (rpc?.method === 'tools/call' && typeof rpc.params?.name === 'string') {
      analytics.trackToolCall(rpc.params.name, req);
    }
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: !acceptsEventStream,
  });

  // Idempotent cleanup — only on res.finish/res.close, not in finally
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    void transport.close();
    void server.close();
  };
  res.once('finish', cleanup);
  res.once('close', cleanup);

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    traceHttp(req, res, { authMode, maskedKey });
  } catch (error) {
    cleanup();
    throw error;
  }
}

function mcpRoute(resolveAuthMode: (req: Request) => AuthMode) {
  return async (req: Request, res: Response) => {
    try {
      await handleMcpRequest(req, res, resolveAuthMode(req));
    } catch (error) {
      if (error instanceof HttpError) {
        traceHttp(req, res, { errorCode: error.code });
        sendHttpError(res, error);
        return;
      }
      console.error('Unhandled MCP HTTP error:', error);
      sendHttpError(res, new HttpError(500, 'internal_error', 'Unexpected server error'));
    }
  };
}

// =============================================================================
// Express app
// =============================================================================

const app = express();

// nginx runs on the host and reaches the container via the docker bridge
app.set('trust proxy', 'loopback, linklocal, uniquelocal');
app.disable('x-powered-by');

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOW_ALL_ORIGINS || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Accept',
    'Authorization',
    'Mcp-Session-Id',
    'Mcp-Protocol-Version',
    'Last-Event-ID',
    'X-API-Key',
    'X-Calcom-Api-Key',
    'X-Calcom-Api-Url',
    'X-Calcom-Access',
  ],
  exposedHeaders: ['Mcp-Session-Id'],
}));

app.use(express.json({ limit: '1mb' }));

// Malformed JSON → JSON-RPC parse error
app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (error instanceof SyntaxError) {
    res.status(400).json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: invalid JSON' }, id: null });
    return;
  }
  next(error);
});

// Track requests (analytics endpoints and health checks excluded)
app.use((req: Request, _res: Response, next: NextFunction) => {
  if (!req.path.startsWith('/analytics') && req.path !== '/health') {
    analytics.trackRequest(req, normalizeRouteForAnalytics(req));
  }
  next();
});

// =============================================================================
// Health, discovery, info
// =============================================================================

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    server: SERVER_NAME,
    version: SERVER_VERSION,
    transport: 'streamable-http',
    keyService: isKeyServiceEnabled() ? 'configured' : 'not configured',
    selfHostedAuth: MCP_API_KEY ? 'enabled' : 'disabled',
    firebase: analytics.firebaseEnabled ? 'connected' : 'disabled',
    timestamp: new Date().toISOString(),
  });
});

app.get('/.well-known/mcp/server-card.json', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json(buildServerCard());
});

// OAuth metadata — deliberate 404s (this server does not implement OAuth)
app.all(/^\/\.well-known\/(oauth-protected-resource|oauth-authorization-server|openid-configuration)(\/.*)?$/, (_req: Request, res: Response) => {
  res.status(404).json({ error: 'oauth_metadata_not_supported' });
});

app.get('/', (_req: Request, res: Response) => {
  res.json({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    description: 'MCP server for Cal.com and self-hosted Cal.diy (API v2)',
    transport: 'streamable-http',
    endpoints: {
      mcpHosted: withPublicBasePath('/mcp/usr_YOUR_USER_KEY'),
      mcpSelfHosted: withPublicBasePath('/mcp'),
      health: withPublicBasePath('/health'),
      discovery: withPublicBasePath('/.well-known/mcp/server-card.json'),
      analytics: withPublicBasePath('/analytics'),
      analyticsDashboard: withPublicBasePath('/analytics/dashboard'),
      ...(ENABLE_MCP_DIAGNOSTICS ? { diagnostics: withPublicBasePath('/mcp-debug/open') } : {}),
    },
    documentation: REPOSITORY_URL,
  });
});

// =============================================================================
// Analytics endpoints (protected by MCP_API_KEY)
// =============================================================================

app.get('/analytics', (req: Request, res: Response) => {
  if (!requireApiKey(req, res)) return;
  res.json(analytics.summary(SERVER_NAME));
});

app.get('/analytics/tools', (req: Request, res: Response) => {
  if (!requireApiKey(req, res)) return;
  res.json(analytics.toolsSummary());
});

app.post('/analytics/import', async (req: Request, res: Response) => {
  if (!requireApiKey(req, res)) return;
  analytics.importTotals(req.body ?? {});
  await analytics.save();
  res.json({ message: 'Analytics imported successfully', current: analytics.summary(SERVER_NAME).summary });
});

app.get('/analytics/dashboard', (_req: Request, res: Response) => {
  res.type('html').send(renderDashboard(SERVER_NAME));
});

// =============================================================================
// MCP endpoints
// =============================================================================

if (ENABLE_MCP_DIAGNOSTICS) {
  app.all('/mcp-debug/open', mcpRoute(() => 'diagnostics'));
}

// Hosted key-service mode: /mcp/:userKey (registered before /mcp)
app.all('/mcp/:userKey', mcpRoute(() => 'hosted-key-service'));

// /mcp: hosted key in the query string or a Bearer header, or self-hosted headers
app.all('/mcp', mcpRoute(req => {
  if (getHostedUserKeyFromQuery(req) || getHostedUserKeyFromHeader(req)) return 'hosted-key-service';
  if (req.get('X-API-Key') || req.get('X-Calcom-Api-Key')) return 'self-hosted';

  if (req.query.apiKey || req.query.api_key || req.query.apiUrl) {
    throw new HttpError(
      401,
      'missing_auth',
      'Raw Cal.com API keys in the URL are not accepted. Register your key at https://mcpkeys.techmavie.digital ' +
      'and use /mcp/usr_YOUR_USER_KEY, or use the self-hosted X-API-Key + X-Calcom-Api-Key headers.',
    );
  }
  throw new HttpError(
    401,
    'missing_auth',
    'Provide /mcp/usr_YOUR_USER_KEY (or ?api_key=usr_..., or Authorization: Bearer usr_...) for hosted key-service mode, ' +
    'or X-API-Key + X-Calcom-Api-Key headers for self-hosted mode.',
  );
}));

// =============================================================================
// Start & graceful shutdown
// =============================================================================

const httpServer = app.listen(PORT, HOST, () => {
  console.log('='.repeat(60));
  console.log(`${SERVER_NAME} (Streamable HTTP) v${SERVER_VERSION}`);
  console.log('='.repeat(60));
  console.log(`Server: http://${HOST}:${PORT}`);
  console.log(`MCP endpoint: ${withPublicBasePath('/mcp/:userKey')} (hosted), ${withPublicBasePath('/mcp')} (hosted query/Bearer or self-hosted)`);
  console.log(`Health: ${withPublicBasePath('/health')}`);
  console.log(`Analytics: ${withPublicBasePath('/analytics/dashboard')} (Firebase: ${analytics.firebaseEnabled ? 'enabled' : 'disabled'})`);
  console.log(`Diagnostics: ${ENABLE_MCP_DIAGNOSTICS ? `${withPublicBasePath('/mcp-debug/open')} (enabled)` : 'disabled'}`);
  console.log(`HTTP tracing: ${MCP_TRACE_HTTP ? 'enabled' : 'disabled'}`);
  console.log(`Self-hosted auth: ${MCP_API_KEY ? 'enabled' : 'disabled (set MCP_API_KEY to enable /mcp headers mode and /analytics)'}`);
  console.log(`Key service: ${isKeyServiceEnabled() ? 'configured' : 'not configured'}`);
  console.log(`Private Cal.com hosts allowed: ${ALLOW_PRIVATE_CALCOM_HOSTS.length ? ALLOW_PRIVATE_CALCOM_HOSTS.join(', ') : 'none'}`);
  console.log(`Public base path: ${PUBLIC_BASE_PATH || '/'}`);
  console.log(`CORS origins: ${ALLOW_ALL_ORIGINS ? '*' : ALLOWED_ORIGINS.join(', ')}`);
  console.log('='.repeat(60));
});

async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`\nReceived ${signal}, shutting down gracefully...`);
  httpServer.close();
  await analytics.stop();
  console.log('Analytics saved. Goodbye!');
  process.exit(0);
}

process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
