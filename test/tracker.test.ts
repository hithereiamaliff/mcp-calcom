import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeFirebaseKey, encodeFirebaseKey } from '../src/analytics/tracker.js';

describe('Firebase key encoding', () => {
  it('removes every character Firebase forbids in keys', () => {
    const encoded = encodeFirebaseKey('Mozilla/5.0 [x] #1 $ foo\tbar\x00\x7f');
    assert.doesNotMatch(encoded, /[.#$/[\]\x00-\x1f\x7f]/);
  });

  it('round-trips keys exactly, so loaded keys match fresh in-memory keys', () => {
    for (const key of ['/mcp', '/mcp/:userKey', 'Mozilla/5.0 (X11; Linux)', '100% sure', 'tab\there', 'plain']) {
      assert.equal(decodeFirebaseKey(encodeFirebaseKey(key)), key);
    }
    assert.notEqual(encodeFirebaseKey('/mcp'), encodeFirebaseKey('_mcp'));
  });
});
