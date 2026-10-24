import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ConnectionConfigError,
  DEFAULT_CALCOM_API_URL,
  allowsAccess,
  assertPublicHost,
  createGuardedLookup,
  isPrivateAddress,
  normalizeApiKey,
  normalizeApiUrl,
  normalizeConnection,
  parseAccess,
} from '../src/config.js';

describe('normalizeApiUrl', () => {
  it('defaults to Cal.com Cloud and maps cal.com hosts to its API', () => {
    assert.equal(normalizeApiUrl(undefined), DEFAULT_CALCOM_API_URL);
    assert.equal(normalizeApiUrl('  '), DEFAULT_CALCOM_API_URL);
    assert.equal(normalizeApiUrl('https://app.cal.com'), DEFAULT_CALCOM_API_URL);
    assert.equal(normalizeApiUrl('api.cal.com'), DEFAULT_CALCOM_API_URL);
    assert.equal(normalizeApiUrl('https://api.cal.com/v2/bookings'), DEFAULT_CALCOM_API_URL);
  });

  it('appends /api/v2 to a bare self-hosted instance URL', () => {
    assert.equal(normalizeApiUrl('https://book.techmavie.digital'), 'https://book.techmavie.digital/api/v2');
    assert.equal(normalizeApiUrl('book.techmavie.digital/'), 'https://book.techmavie.digital/api/v2');
    assert.equal(normalizeApiUrl('https://example.com/cal'), 'https://example.com/cal/api/v2');
    assert.equal(normalizeApiUrl('http://10.0.0.5:5555'), 'http://10.0.0.5:5555/api/v2');
  });

  it('keeps explicit v2 paths and trims pasted endpoint URLs', () => {
    assert.equal(normalizeApiUrl('https://book.techmavie.digital/api/v2'), 'https://book.techmavie.digital/api/v2');
    assert.equal(normalizeApiUrl('https://api.example.com/v2/'), 'https://api.example.com/v2');
    assert.equal(normalizeApiUrl('https://book.techmavie.digital/api/v2/bookings/abc'), 'https://book.techmavie.digital/api/v2');
    assert.equal(normalizeApiUrl('https://api.cal.eu/v2'), 'https://api.cal.eu/v2');
  });

  it('rejects unsupported URLs', () => {
    assert.throws(() => normalizeApiUrl('ftp://example.com'), ConnectionConfigError);
    assert.throws(() => normalizeApiUrl('https://user:pass@example.com'), ConnectionConfigError);
    assert.throws(() => normalizeApiUrl('https://example.com/?x=1'), ConnectionConfigError);
    assert.throws(() => normalizeApiUrl('https://exa mple.com'), ConnectionConfigError);
  });
});

describe('parseAccess / allowsAccess', () => {
  it('maps aliases to the three levels', () => {
    for (const value of [undefined, '', 'read', 'READ', 'readonly', 'no', 'false']) assert.equal(parseAccess(value).access, 'read', String(value));
    for (const value of ['bookings', 'booking', ' Book ']) assert.equal(parseAccess(value).access, 'bookings', value);
    for (const value of ['full', 'admin', 'write', 'yes', 'true', 'all']) assert.equal(parseAccess(value).access, 'full', value);
  });

  it('falls back to read with a warning for unknown values (including prototype keys)', () => {
    for (const value of ['everything', 'constructor', '__proto__']) {
      const result = parseAccess(value);
      assert.equal(result.access, 'read');
      assert.match(result.warning ?? '', /Unknown access level/);
    }
  });

  it('orders access levels', () => {
    assert.equal(allowsAccess({ access: 'read' }, 'bookings'), false);
    assert.equal(allowsAccess({ access: 'bookings' }, 'bookings'), true);
    assert.equal(allowsAccess({ access: 'bookings' }, 'full'), false);
    assert.equal(allowsAccess({ access: 'full' }, 'bookings'), true);
  });
});

describe('normalizeApiKey', () => {
  it('trims and strips a pasted Bearer prefix', () => {
    assert.deepEqual(normalizeApiKey('  Bearer cal_abc123  '), { apiKey: 'cal_abc123', warnings: [] });
  });

  it('warns about unusual prefixes and refuses key-service keys', () => {
    assert.equal(normalizeApiKey('custom_abc').warnings.length, 1);
    assert.throws(() => normalizeApiKey(`usr_${'a'.repeat(32)}`), /MCP Key Service key/);
    assert.throws(() => normalizeApiKey(''), ConnectionConfigError);
    assert.throws(() => normalizeApiKey('cal_ab cd'), ConnectionConfigError);
  });
});

describe('normalizeConnection', () => {
  it('builds a complete connection', () => {
    const connection = normalizeConnection({ apiKey: ' cal_key ', apiUrl: 'https://book.techmavie.digital', access: 'bookings' });
    assert.deepEqual(connection, {
      baseUrl: 'https://book.techmavie.digital/api/v2',
      apiKey: 'cal_key',
      access: 'bookings',
      isCloud: false,
      warnings: [],
    });
  });

  it('treats a blank URL as Cal.com Cloud and collects warnings', () => {
    const connection = normalizeConnection({ apiKey: 'cal_key', apiUrl: '', access: 'sometimes' });
    assert.equal(connection.isCloud, true);
    assert.equal(connection.access, 'read');
    assert.equal(connection.warnings.length, 1);
  });
});

describe('SSRF guard', () => {
  it('classifies private and public addresses', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '172.17.0.2', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fe80::1', 'fc00::1', '::ffff:10.0.0.1', '::ffff:a00:1']) {
      assert.equal(isPrivateAddress(ip), true, ip);
    }
    for (const ip of ['1.1.1.1', '138.199.46.65', '8.8.8.8', '::ffff:8.8.8.8', '2a01:4f8:c0c:d5f::1']) {
      assert.equal(isPrivateAddress(ip), false, ip);
    }
  });

  it('rejects private IP literals unless allow-listed', async () => {
    await assert.rejects(assertPublicHost('http://10.1.2.3:5555/api/v2'), ConnectionConfigError);
    await assert.rejects(assertPublicHost('http://[::1]:5555/api/v2'), ConnectionConfigError);
    await assertPublicHost('http://10.1.2.3:5555/api/v2', ['10.1.2.3']);
    await assertPublicHost('https://1.1.1.1/api/v2');
  });

  it('defers hostnames to the connect-time guard', async () => {
    await assertPublicHost('http://localhost:5555/api/v2');
    await assertPublicHost('https://does-not-exist.invalid/api/v2');
  });

  it('refuses private addresses at connect time unless allow-listed', async () => {
    const lookup = (allowed: string[]) =>
      new Promise<{ error: NodeJS.ErrnoException | null; address: unknown }>(resolve =>
        createGuardedLookup(allowed)('localhost', {}, (error, address) => resolve({ error, address })),
      );

    const blocked = await lookup([]);
    assert.match(String(blocked.error?.message), /private or internal/);
    assert.equal(blocked.error?.code, 'EPRIVATEADDRESS');

    const allowed = await lookup(['localhost']);
    assert.equal(allowed.error, null);
    assert.equal(typeof allowed.address, 'string');
  });
});
