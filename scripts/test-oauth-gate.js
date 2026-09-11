/**
 * Guards the two defects fixed in fix/oauth-chatgpt-and-passcode-gate:
 *
 *   1. ChatGPT's MCP connector discovers auth through RFC 9728 protected-resource
 *      metadata. If `resource` stops pointing at /mcp, ChatGPT silently fails to
 *      connect (no client ever reaches /register).
 *   2. /authorize used to auto-approve every request. The passcode gate is the
 *      only thing standing between a known URL and a 90-day token for every tool,
 *      so passcodeMatches must fail closed on an unset secret and on a wrong or
 *      empty input.
 *
 * Runs against the BUILT module, so `npm run build` must precede it —
 * `npm run test:oauth` chains both. Importing auth/oauth needs no env vars and
 * opens no connections: the Supabase client is constructed lazily, not at module
 * load.
 */
import { test } from 'node:test';
import assert from 'node:assert';

import {
  getOAuthMetadata,
  getProtectedResourceMetadata,
  passcodeMatches,
  escapeHtml,
} from '../dist/auth/oauth.js';

test('protected-resource metadata points at /mcp and back at the issuer', () => {
  const meta = getProtectedResourceMetadata('https://x');
  assert.strictEqual(meta.resource, 'https://x/mcp');
  assert.deepStrictEqual(meta.authorization_servers, ['https://x']);
  assert.deepStrictEqual(meta.bearer_methods_supported, ['header']);
});

test("authorization-server metadata advertises the 'none' auth method", () => {
  // ChatGPT registers as a public client and posts no client_secret.
  const meta = getOAuthMetadata('https://x');
  assert.ok(meta.token_endpoint_auth_methods_supported.includes('none'));
  assert.ok(meta.token_endpoint_auth_methods_supported.includes('client_secret_post'));
});

test('passcodeMatches accepts only the exact secret', () => {
  const prev = process.env.OAUTH_AUTHORIZE_SECRET;
  process.env.OAUTH_AUTHORIZE_SECRET = 'abc';
  try {
    assert.strictEqual(passcodeMatches('abc'), true);
    assert.strictEqual(passcodeMatches('abd'), false);
    assert.strictEqual(passcodeMatches('ab'), false);
    assert.strictEqual(passcodeMatches('abcd'), false);
    assert.strictEqual(passcodeMatches(''), false);
  } finally {
    if (prev === undefined) delete process.env.OAUTH_AUTHORIZE_SECRET;
    else process.env.OAUTH_AUTHORIZE_SECRET = prev;
  }
});

test('passcodeMatches fails closed when no secret is configured', () => {
  const prev = process.env.OAUTH_AUTHORIZE_SECRET;
  delete process.env.OAUTH_AUTHORIZE_SECRET;
  try {
    assert.strictEqual(passcodeMatches('abc'), false);
    assert.strictEqual(passcodeMatches(''), false);
  } finally {
    if (prev !== undefined) process.env.OAUTH_AUTHORIZE_SECRET = prev;
  }
});

test('escapeHtml neutralises markup in the passcode form hidden fields', () => {
  const escaped = escapeHtml('"><script>alert(1)</script>');
  assert.ok(!escaped.includes('<'));
  assert.ok(!escaped.includes('>'));
  assert.ok(!escaped.includes('"'));
  assert.strictEqual(escapeHtml("it's & so"), 'it&#39;s &amp; so');
});
