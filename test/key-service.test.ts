import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';

// The resolver reads its configuration at import time
process.env.KEY_SERVICE_URL = 'http://key-service.test/internal/resolve';
process.env.KEY_SERVICE_TOKEN = 'server-token';

type KeyServiceModule = typeof import('../src/utils/key-service.js');
let keyService: KeyServiceModule;

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; init?: RequestInit }> = [];

function mockFetch(status: number, body: unknown, contentType = 'application/json') {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { 'content-type': contentType } });
  }) as typeof fetch;
}

let counter = 0;
const freshKey = () => `usr_${(counter++).toString(16).padStart(32, '0')}`;

describe('key-service resolver', () => {
  before(async () => {
    keyService = await import('../src/utils/key-service.js');
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    calls = [];
  });

  it('is enabled when URL and token are set', () => {
    assert.equal(keyService.isKeyServiceEnabled(), true);
    assert.equal(keyService.isKeyServicePartiallyConfigured(), false);
    assert.equal(keyService.USER_KEY_PATTERN.test(freshKey()), true);
    assert.equal(keyService.USER_KEY_PATTERN.test('usr_short'), false);
  });

  it('maps calcom connector fields and caches the result', async () => {
    mockFetch(200, {
      valid: true,
      connector_id: 'calcom',
      credentials: { calcom_api_url: 'https://book.example.com/api/v2', calcom_api_key: 'cal_abc', calcom_access: 'bookings' },
    });
    const key = freshKey();
    const first = await keyService.resolveKeyCredentials(key);
    assert.deepEqual(first, {
      ok: true,
      credentials: { apiUrl: 'https://book.example.com/api/v2', apiKey: 'cal_abc', access: 'bookings' },
    });

    const second = await keyService.resolveKeyCredentials(key);
    assert.deepEqual(second, first);
    assert.equal(calls.length, 1, 'second call should be served from cache');

    const request = calls[0];
    assert.equal((request.init?.headers as Record<string, string>).Authorization, 'Bearer server-token');
    assert.deepEqual(JSON.parse(String(request.init?.body)), { key, server_id: 'calcom' });
  });

  it('de-duplicates concurrent lookups', async () => {
    mockFetch(200, { valid: true, credentials: { calcom_api_key: 'cal_abc' } });
    const key = freshKey();
    await Promise.all([keyService.resolveKeyCredentials(key), keyService.resolveKeyCredentials(key)]);
    assert.equal(calls.length, 1);
  });

  it('treats 401 and 404 as an invalid user key', async () => {
    mockFetch(401, { valid: false, error: 'Invalid, revoked, or suspended API key, or server not authorized' });
    assert.deepEqual(await keyService.resolveKeyCredentials(freshKey()), { ok: false, reason: 'invalid_key' });
    mockFetch(404, { valid: false });
    assert.deepEqual(await keyService.resolveKeyCredentials(freshKey()), { ok: false, reason: 'invalid_key' });
  });

  it('treats 403 (bad server token) and 500 as service problems', async () => {
    mockFetch(403, { valid: false, error: 'Unauthorized' });
    assert.deepEqual(await keyService.resolveKeyCredentials(freshKey()), { ok: false, reason: 'service_unavailable' });
    mockFetch(500, { valid: false, error: 'Failed to decrypt credentials' });
    assert.deepEqual(await keyService.resolveKeyCredentials(freshKey()), { ok: false, reason: 'service_unavailable' });
  });

  it('flags malformed responses, including credentials of another connector', async () => {
    mockFetch(200, '<html>oops</html>', 'text/html');
    assert.deepEqual(await keyService.resolveKeyCredentials(freshKey()), { ok: false, reason: 'malformed_response' });
    mockFetch(200, { valid: true, credentials: { plausible_api_key: 'x' } });
    assert.deepEqual(await keyService.resolveKeyCredentials(freshKey()), { ok: false, reason: 'malformed_response' });
  });

  it('treats network failures as unavailable and does not cache failures', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const key = freshKey();
    assert.deepEqual(await keyService.resolveKeyCredentials(key), { ok: false, reason: 'service_unavailable' });
    mockFetch(200, { valid: true, credentials: { calcom_api_key: 'cal_abc' } });
    assert.equal((await keyService.resolveKeyCredentials(key)).ok, true);
  });
});
