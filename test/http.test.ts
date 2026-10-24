import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { CalApiError, calRequest, configurePrivateAddressGuard, extractCalError } from '../src/calcom/http.js';

let server: http.Server;
let baseUrl: string;
const seen: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];
let rateLimitHits = 0;
let longRateLimitHits = 0;

before(async () => {
  server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(body));
    const path = (req.url ?? '').split('?')[0];

    switch (path) {
      case '/api/v2/bookings':
        return json(200, { status: 'success', data: [{ uid: 'a' }], pagination: { totalItems: 1, hasNextPage: false } }, {
          'X-RateLimit-Limit-Default': '120',
          'X-RateLimit-Remaining-Default': '119',
          'X-RateLimit-Reset-Default': '60',
        });
      case '/api/v2/event-types/5/private-links':
        return json(200, { status: 'success', data: [] });
      case '/api/v2/me':
        return json(200, { status: 'success', data: { id: 1, username: 'aliff' } });
      case '/api/v2/validation':
        return json(400, {
          status: 'error',
          timestamp: 'x',
          path: '/v2/bookings',
          error: {
            code: 'BadRequestException',
            message: 'Bad Request Exception',
            details: {
              errors: [
                { property: 'start', constraints: { isISO8601: 'start must be a valid ISO 8601 date string' }, children: [] },
                { property: 'attendee', children: [{ property: 'timeZone', constraints: { isTimeZone: 'invalid time zone' }, children: [] }] },
              ],
            },
          },
        });
      case '/api/v2/zod':
        return json(400, { status: 'error', error: { code: 'BAD_REQUEST', message: 'start - Invalid date, ' } });
      case '/api/v2/unavailable':
        return json(400, { status: 'error', error: { code: 'BadRequestException', message: 'no_available_users_found_error', details: { message: 'no_available_users_found_error', error: 'Bad Request', statusCode: 400 } } });
      case '/api/v2/html-404':
        return res.writeHead(404, { 'Content-Type': 'text/html' }).end('<!DOCTYPE html><html><body>This page could not be found</body></html>');
      case '/api/v2/html-200':
        return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html><body>Cal web app</body></html>');
      case '/api/v2/rate':
        rateLimitHits++;
        return rateLimitHits === 1
          ? json(429, { status: 'error', error: { code: 'ThrottlerException', message: 'Too many requests' } }, { 'X-RateLimit-Reset-Default': '1' })
          : json(200, { status: 'success', data: { ok: true } });
      case '/api/v2/rate-long':
        longRateLimitHits++;
        return json(429, { status: 'error', error: { code: 'ThrottlerException', message: 'Too many requests' } }, { 'X-RateLimit-Reset-Default': '60' });
      case '/api/v2/redirect':
        return res.writeHead(301, { Location: 'https://elsewhere.example.com/' }).end();
      case '/api/v2/empty':
        return res.writeHead(200).end();
      default:
        return json(404, { status: 'error', error: { code: 'NotFoundException', message: 'Cannot GET' } });
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v2`;
});

after(() => server.close());

const lastRequest = () => seen[seen.length - 1];

describe('calRequest', () => {
  it('sends the API key and the endpoint version, and unwraps the envelope', async () => {
    const response = await calRequest<Array<{ uid: string }>>(baseUrl, 'cal_key', '/bookings', { query: { status: ['upcoming', 'past'], take: 5, skip: undefined } });
    assert.deepEqual(response.data, [{ uid: 'a' }]);
    assert.equal(response.pagination?.totalItems, 1);
    assert.deepEqual(response.rateLimit, { limit: 120, remaining: 119, resetSeconds: 60 });
    const request = lastRequest();
    assert.equal(request.headers.authorization, 'Bearer cal_key');
    assert.equal(request.headers['cal-api-version'], '2024-08-13');
    assert.equal(request.url, '/api/v2/bookings?status=upcoming%2Cpast&take=5');
  });

  it('sends no version header to unversioned endpoints such as private links', async () => {
    await calRequest(baseUrl, 'cal_key', '/event-types/5/private-links');
    assert.equal(lastRequest().headers['cal-api-version'], undefined);
    await calRequest(baseUrl, 'cal_key', '/me');
    assert.equal(lastRequest().headers['cal-api-version'], undefined);
  });

  it('encodes qs-style array-of-object query keys', async () => {
    await calRequest(baseUrl, 'cal_key', '/me', { query: { 'calendarsToLoad[0][credentialId]': 3, 'calendarsToLoad[0][externalId]': 'a@b.c' } });
    assert.equal(lastRequest().url, '/api/v2/me?calendarsToLoad%5B0%5D%5BcredentialId%5D=3&calendarsToLoad%5B0%5D%5BexternalId%5D=a%40b.c');
  });

  it('flattens class-validator details', async () => {
    await assert.rejects(calRequest(baseUrl, 'cal_key', '/validation'), (error: unknown) => {
      assert.ok(error instanceof CalApiError);
      assert.equal(error.status, 400);
      assert.equal(error.code, 'BadRequestException');
      assert.deepEqual(error.details, ['start must be a valid ISO 8601 date string', 'attendee.timeZone: invalid time zone']);
      return true;
    });
  });

  it('keeps zod and booking error codes readable', async () => {
    await assert.rejects(calRequest(baseUrl, 'cal_key', '/zod'), (error: unknown) => error instanceof CalApiError && error.message === 'start - Invalid date');
    await assert.rejects(calRequest(baseUrl, 'cal_key', '/unavailable'), (error: unknown) =>
      error instanceof CalApiError && error.message === 'no_available_users_found_error' && error.details.length === 0);
  });

  it('flags HTML pages (the web app instead of API v2), even with status 200', async () => {
    await assert.rejects(calRequest(baseUrl, 'cal_key', '/html-404'), (error: unknown) =>
      error instanceof CalApiError && error.status === 404 && error.html && !error.message.includes('<html'));
    await assert.rejects(calRequest(baseUrl, 'cal_key', '/html-200'), (error: unknown) => error instanceof CalApiError && error.html);
  });

  it('retries a short 429 and reports a long one', async () => {
    const { data } = await calRequest<{ ok: boolean }>(baseUrl, 'cal_key', '/rate');
    assert.deepEqual(data, { ok: true });
    assert.equal(rateLimitHits, 2);

    await assert.rejects(calRequest(baseUrl, 'cal_key', '/rate-long'), (error: unknown) =>
      error instanceof CalApiError && error.status === 429 && error.retryAfterSeconds === 60);
    assert.equal(longRateLimitHits, 1, 'a 60 s wait is reported, not slept through');
  });

  it('refuses to follow redirects', async () => {
    await assert.rejects(calRequest(baseUrl, 'cal_key', '/redirect'), (error: unknown) =>
      error instanceof CalApiError && error.status === 301 && /elsewhere\.example\.com/.test(error.message));
  });

  it('returns empty bodies as null', async () => {
    const { data } = await calRequest(baseUrl, 'cal_key', '/empty');
    assert.equal(data, null);
  });

  it('reports network failures as status 0', async () => {
    await assert.rejects(calRequest('http://127.0.0.1:1/api/v2', 'cal_key', '/me', { timeoutMs: 2000 }), (error: unknown) =>
      error instanceof CalApiError && error.status === 0);
  });

  it('blocks private addresses at connect time when the guard is enabled', async () => {
    const port = new URL(baseUrl).port;
    configurePrivateAddressGuard(true);
    try {
      await assert.rejects(calRequest(`http://localhost:${port}/api/v2`, 'cal_key', '/me'), (error: unknown) =>
        error instanceof CalApiError && error.status === 0 && /private or internal/.test(error.message));
      configurePrivateAddressGuard(true, ['localhost']);
      const { data } = await calRequest<{ username: string }>(`http://localhost:${port}/api/v2`, 'cal_key', '/me');
      assert.equal(data.username, 'aliff');
    } finally {
      configurePrivateAddressGuard(false);
    }
  });
});

describe('extractCalError', () => {
  it('handles plain Nest errors and non-objects', () => {
    assert.deepEqual(extractCalError({ message: ['a', 'b'], error: 'Bad Request', statusCode: 400 }), { message: 'a; b', details: [] });
    assert.deepEqual(extractCalError('text'), { details: [] });
  });
});
