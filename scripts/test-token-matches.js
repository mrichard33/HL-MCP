/**
 * test-token-matches.js — constant-time static-token compare (2026-10-03,
 * security review). /mcp, /diagnostics and /internal/* compared the static
 * bearer token with `===`/`!==`, which leaks match length through timing.
 * tokenMatches keeps the same accept/reject results and refuses an empty
 * expected value, which is what closes /diagnostics when MCP_AUTH_TOKEN is unset.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { tokenMatches } from '../dist/auth/oauth.js';

test('tokenMatches accepts only the exact token', () => {
  assert.strictEqual(tokenMatches('abc123', 'abc123'), true);
  assert.strictEqual(tokenMatches('abc124', 'abc123'), false);
  assert.strictEqual(tokenMatches('abc1234', 'abc123'), false);
  assert.strictEqual(tokenMatches('', 'abc123'), false);
});

test('tokenMatches refuses everything when the expected token is unset', () => {
  assert.strictEqual(tokenMatches('anything', undefined), false);
  assert.strictEqual(tokenMatches('anything', ''), false);
  assert.strictEqual(tokenMatches('', ''), false);
});
