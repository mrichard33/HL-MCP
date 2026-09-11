import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getSupabaseClient } from '../clients/supabase.js';

// ─────────────────────────────────────────────────────────────────────────────
// Inbound connector OAuth (Claude.ai → this MCP server).
//
// v2: tokens are PERSISTED TO SUPABASE so they survive Railway redeploys and
// container restarts, and a refresh_token grant is supported so Claude.ai renews
// access silently. Mirrors the durable pattern in src/clients/ghl-oauth.ts.
//
// Why the old in-memory version forced repeated re-auth:
//   • clients / authCodes / accessTokens lived in process-local Maps that reset
//     on every deploy (HL auto-deploys from main) and every restart → the token
//     Claude.ai held failed validation → 401 → "reconnect" prompt.
//   • access tokens expired in 24h with no refresh grant → daily prompt.
//
// Tables: see migrations/006_create_mcp_oauth_tables.sql
// ─────────────────────────────────────────────────────────────────────────────

// Long-lived access token (belt-and-suspenders alongside refresh): even a client
// that never refreshes is not prompted for 90 days, and the token survives
// restarts via Supabase.
const ACCESS_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days
const AUTH_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// In-memory positive cache for hot-path /mcp validation (token → expiry ms).
// On a cache miss (e.g. right after a redeploy) we fall back to Supabase, which
// is the source of truth, then repopulate. Low per-request latency without
// reintroducing the "lost on restart" failure mode.
const validationCache = new Map<string, number>();

// ---- Helpers ----

function generateId(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  const hash = createHash('sha256').update(codeVerifier).digest('base64url');
  return hash === codeChallenge;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function jsonResponse(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ---- OAuth Metadata (RFC 8414) ----

export function getOAuthMetadata(issuerUrl: string): Record<string, unknown> {
  return {
    issuer: issuerUrl,
    authorization_endpoint: `${issuerUrl}/authorize`,
    token_endpoint: `${issuerUrl}/token`,
    registration_endpoint: `${issuerUrl}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    scopes_supported: ['claudeai'],
  };
}

// ---- Protected Resource Metadata (RFC 9728) ----
// ChatGPT's MCP connector (and the current MCP auth spec) discovers auth here:
// 401 WWW-Authenticate → this document → authorization server metadata.
export function getProtectedResourceMetadata(issuerUrl: string): Record<string, unknown> {
  return {
    resource: `${issuerUrl}/mcp`,
    authorization_servers: [issuerUrl],
    bearer_methods_supported: ['header'],
    scopes_supported: ['claudeai'],
  };
}

// ---- Dynamic Client Registration (RFC 7591) ----

export async function handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);
    const data = JSON.parse(body || '{}');
    const redirectUris: string[] = data.redirect_uris || [];

    const clientId = generateId();
    const clientSecret = generateId();

    const supabase = getSupabaseClient();
    const { error } = await supabase.from('mcp_oauth_clients').insert({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uris: redirectUris,
    });
    if (error) {
      console.error('[OAuth] register: supabase insert failed —', error.message);
      jsonResponse(res, 500, { error: 'server_error' });
      return;
    }

    console.log(`[OAuth] register: client registered (id: ${clientId.slice(0, 8)}…, redirectUris: ${redirectUris.length})`);

    jsonResponse(res, 201, {
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uris: redirectUris,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret_expires_at: 0, // does not expire
    });
  } catch (err) {
    console.error('[OAuth] register: error', err instanceof Error ? err.message : err);
    jsonResponse(res, 400, { error: 'invalid_request' });
  }
}

// ---- Authorization Endpoint ----

export async function handleAuthorize(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (req.method === 'GET') {
    return handleAuthorizeGet(res, url);
  }
  if (req.method === 'POST') {
    return handleAuthorizePost(req, res);
  }
  res.writeHead(405);
  res.end();
}

async function handleAuthorizeGet(res: ServerResponse, url: URL): Promise<void> {
  const clientId = url.searchParams.get('client_id') || '';
  const redirectUri = url.searchParams.get('redirect_uri') || '';
  const codeChallenge = url.searchParams.get('code_challenge') || '';
  const codeChallengeMethod = url.searchParams.get('code_challenge_method') || 'S256';
  const state = url.searchParams.get('state') || '';

  try {
    if (!redirectUri) {
      console.error(`[OAuth] authorize GET: missing redirect_uri (client: ${clientId.slice(0, 8)}…)`);
      jsonResponse(res, 400, { error: 'invalid_request', error_description: 'redirect_uri is required' });
      return;
    }

    console.log(`[OAuth] authorize GET: client=${clientId.slice(0, 8)}…, redirect=${redirectUri}, hasChallenge=${!!codeChallenge}`);

    if (!(await isRegisteredRedirect(clientId, redirectUri))) {
      console.error(`[OAuth] authorize GET: unregistered client/redirect (client: ${clientId.slice(0, 8)}…)`);
      jsonResponse(res, 400, { error: 'invalid_request', error_description: 'Unknown client_id or unregistered redirect_uri' });
      return;
    }
    if (!process.env.OAUTH_AUTHORIZE_SECRET) {
      console.error('[OAuth] authorize GET: OAUTH_AUTHORIZE_SECRET not set — failing closed');
      jsonResponse(res, 503, { error: 'server_error', error_description: 'Authorization is not configured' });
      return;
    }

    // Passcode gate — no code is issued until the correct passcode is POSTed.
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderPasscodePage({ clientId, redirectUri, codeChallenge, codeChallengeMethod, state }, false));
  } catch (err) {
    console.error('[OAuth] authorize GET: error', err instanceof Error ? err.message : err);
    jsonResponse(res, 400, { error: 'server_error', error_description: 'Failed to process authorization request' });
  }
}

async function handleAuthorizePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);
    const params = new URLSearchParams(body);

    const clientId = params.get('client_id') || '';
    const redirectUri = params.get('redirect_uri') || '';
    const codeChallenge = params.get('code_challenge') || '';
    const codeChallengeMethod = params.get('code_challenge_method') || 'S256';
    const state = params.get('state') || '';

    if (!redirectUri) {
      console.error(`[OAuth] authorize POST: missing redirect_uri (client: ${clientId.slice(0, 8)}…)`);
      jsonResponse(res, 400, { error: 'invalid_request', error_description: 'redirect_uri is required' });
      return;
    }

    console.log(`[OAuth] authorize POST: client=${clientId.slice(0, 8)}…, redirect=${redirectUri}, hasChallenge=${!!codeChallenge}`);

    if (!(await isRegisteredRedirect(clientId, redirectUri))) {
      console.error(`[OAuth] authorize POST: unregistered client/redirect (client: ${clientId.slice(0, 8)}…)`);
      jsonResponse(res, 400, { error: 'invalid_request', error_description: 'Unknown client_id or unregistered redirect_uri' });
      return;
    }
    if (!process.env.OAUTH_AUTHORIZE_SECRET) {
      console.error('[OAuth] authorize POST: OAUTH_AUTHORIZE_SECRET not set — failing closed');
      jsonResponse(res, 503, { error: 'server_error', error_description: 'Authorization is not configured' });
      return;
    }
    if (!codeChallenge) {
      jsonResponse(res, 400, { error: 'invalid_request', error_description: 'PKCE code_challenge required' });
      return;
    }
    if (!passcodeMatches(params.get('passcode') || '')) {
      console.warn(`[OAuth] authorize POST: wrong passcode (client: ${clientId.slice(0, 8)}…)`);
      await new Promise((r) => setTimeout(r, 1000)); // slow brute force
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(renderPasscodePage({ clientId, redirectUri, codeChallenge, codeChallengeMethod, state }, true));
      return;
    }

    const code = await createAuthorizationCode(clientId, redirectUri, codeChallenge, codeChallengeMethod);
    const location = buildRedirectUrl(redirectUri, code, state);
    res.writeHead(302, { Location: location });
    res.end();
  } catch (err) {
    console.error('[OAuth] authorize POST: error', err instanceof Error ? err.message : err);
    jsonResponse(res, 400, { error: 'server_error', error_description: 'Failed to process authorization request' });
  }
}

interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

export function passcodeMatches(input: string): boolean {
  const secret = process.env.OAUTH_AUTHORIZE_SECRET || '';
  if (!secret || !input) return false;
  const a = createHash('sha256').update(input).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

async function isRegisteredRedirect(clientId: string, redirectUri: string): Promise<boolean> {
  if (!clientId || !redirectUri) return false;
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('mcp_oauth_clients')
    .select('redirect_uris')
    .eq('client_id', clientId)
    .maybeSingle();
  if (error || !data) return false;
  const uris: string[] = Array.isArray(data.redirect_uris) ? data.redirect_uris : [];
  return uris.includes(redirectUri);
}

function renderPasscodePage(p: AuthorizeParams, failed: boolean): string {
  const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reece HL MCP — Connect</title>
<style>body{font-family:'Nunito Sans',Arial,sans-serif;background:#0D2240;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}form{background:#fff;color:#0D2240;padding:32px;border-radius:12px;width:320px}input[type=password]{width:100%;padding:10px;margin:12px 0;border:1px solid #87898B;border-radius:6px;box-sizing:border-box}button{width:100%;padding:10px;background:#FF0012;color:#fff;border:0;border-radius:6px;font-weight:700;cursor:pointer}.err{color:#FF0012}</style></head><body>
<form method="POST" action="/authorize"><h2>Reece HL MCP</h2><p>Enter the access passcode to connect.</p>${failed ? '<p class="err">Incorrect passcode.</p>' : ''}
${hidden('client_id', p.clientId)}${hidden('redirect_uri', p.redirectUri)}${hidden('code_challenge', p.codeChallenge)}${hidden('code_challenge_method', p.codeChallengeMethod)}${hidden('state', p.state)}
<input type="password" name="passcode" autocomplete="current-password" required autofocus><button type="submit">Connect</button></form></body></html>`;
}

async function createAuthorizationCode(
  clientId: string,
  redirectUri: string,
  codeChallenge: string,
  codeChallengeMethod: string,
): Promise<string> {
  const code = generateId();
  const supabase = getSupabaseClient();
  const { error } = await supabase.from('mcp_oauth_auth_codes').insert({
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge || null,
    code_challenge_method: codeChallengeMethod || null,
    expires_at: new Date(Date.now() + AUTH_CODE_TTL_MS).toISOString(),
  });
  if (error) throw new Error(`auth code persist failed: ${error.message}`);
  console.log(`[OAuth] auth code created (code: ${code.slice(0, 8)}…, client: ${clientId.slice(0, 8)}…)`);
  return code;
}

function buildRedirectUrl(redirectUri: string, code: string, state: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  return url.toString();
}

// ---- Token Endpoint ----

export async function handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);

    let grantType: string;
    let code = '';
    let clientId = '';
    let redirectUri = '';
    let codeVerifier = '';
    let refreshToken = '';

    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('application/json')) {
      const data = JSON.parse(body);
      grantType = data.grant_type;
      code = data.code || '';
      clientId = data.client_id || '';
      redirectUri = data.redirect_uri || '';
      codeVerifier = data.code_verifier || '';
      refreshToken = data.refresh_token || '';
    } else {
      const params = new URLSearchParams(body);
      grantType = params.get('grant_type') || '';
      code = params.get('code') || '';
      clientId = params.get('client_id') || '';
      redirectUri = params.get('redirect_uri') || '';
      codeVerifier = params.get('code_verifier') || '';
      refreshToken = params.get('refresh_token') || '';
    }

    console.log(`[OAuth] token: grant_type=${grantType}, client=${(clientId || '').slice(0, 8)}…, hasCode=${!!code}, hasVerifier=${!!codeVerifier}, hasRefresh=${!!refreshToken}`);

    // ── Refresh grant ──
    if (grantType === 'refresh_token') {
      return handleRefreshGrant(res, refreshToken);
    }

    if (grantType !== 'authorization_code') {
      console.log(`[OAuth] token: rejected unsupported grant_type: ${grantType}`);
      jsonResponse(res, 400, { error: 'unsupported_grant_type' });
      return;
    }

    const supabase = getSupabaseClient();

    // Look up the authorization code
    const { data: stored, error: lookupErr } = await supabase
      .from('mcp_oauth_auth_codes')
      .select('code, client_id, redirect_uri, code_challenge, expires_at')
      .eq('code', code)
      .maybeSingle();

    if (lookupErr) {
      console.error('[OAuth] token: auth code lookup failed —', lookupErr.message);
      jsonResponse(res, 500, { error: 'server_error' });
      return;
    }
    if (!stored) {
      console.error(`[OAuth] token: unknown auth code (code: ${(code || '').slice(0, 8)}…)`);
      jsonResponse(res, 400, { error: 'invalid_grant', error_description: 'Unknown authorization code' });
      return;
    }

    // Codes are single-use — delete immediately
    await supabase.from('mcp_oauth_auth_codes').delete().eq('code', code);

    // Check expiry
    if (Date.now() > new Date(stored.expires_at).getTime()) {
      console.error('[OAuth] token: auth code expired');
      jsonResponse(res, 400, { error: 'invalid_grant', error_description: 'Authorization code expired' });
      return;
    }

    // Validate redirect_uri matches
    if (redirectUri && redirectUri !== stored.redirect_uri) {
      console.error(`[OAuth] token: redirect_uri mismatch (got: ${redirectUri}, expected: ${stored.redirect_uri})`);
      jsonResponse(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      return;
    }

    // Verify PKCE
    if (stored.code_challenge) {
      if (!codeVerifier) {
        console.error('[OAuth] token: PKCE code_verifier missing');
        jsonResponse(res, 400, { error: 'invalid_request', error_description: 'code_verifier required' });
        return;
      }
      if (!verifyPkce(codeVerifier, stored.code_challenge)) {
        console.error('[OAuth] token: PKCE verification failed');
        jsonResponse(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return;
      }
    }

    // Issue access + refresh tokens
    const tokens = await issueTokens(stored.client_id);

    console.log(`[OAuth] token: issued access+refresh (client: ${stored.client_id.slice(0, 8)}…)`);

    jsonResponse(res, 200, {
      access_token: tokens.accessToken,
      token_type: 'bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: tokens.refreshToken,
    });
  } catch (err) {
    console.error('[OAuth] token: error', err instanceof Error ? err.message : err);
    jsonResponse(res, 400, { error: 'invalid_request' });
  }
}

async function handleRefreshGrant(res: ServerResponse, refreshToken: string): Promise<void> {
  if (!refreshToken) {
    jsonResponse(res, 400, { error: 'invalid_request', error_description: 'refresh_token required' });
    return;
  }
  try {
    const supabase = getSupabaseClient();
    const { data: stored, error } = await supabase
      .from('mcp_oauth_refresh_tokens')
      .select('token, client_id, revoked')
      .eq('token', refreshToken)
      .maybeSingle();

    if (error) {
      console.error('[OAuth] refresh: lookup failed —', error.message);
      jsonResponse(res, 500, { error: 'server_error' });
      return;
    }
    if (!stored || stored.revoked) {
      console.error('[OAuth] refresh: unknown or revoked refresh token');
      jsonResponse(res, 400, { error: 'invalid_grant', error_description: 'Invalid refresh token' });
      return;
    }

    // Mint a new access token; keep the same (non-rotating) refresh token to
    // avoid rotation-persistence bugs — the classic cause of refresh failures.
    const accessToken = await issueAccessToken(stored.client_id);

    console.log(`[OAuth] refresh: issued new access token (client: ${stored.client_id.slice(0, 8)}…)`);

    jsonResponse(res, 200, {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
    });
  } catch (err) {
    console.error('[OAuth] refresh: error', err instanceof Error ? err.message : err);
    jsonResponse(res, 400, { error: 'invalid_request' });
  }
}

// ---- Token Issuance ----

async function issueAccessToken(clientId: string): Promise<string> {
  const token = generateId();
  const expiresAtMs = Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000;
  const supabase = getSupabaseClient();
  const { error } = await supabase.from('mcp_oauth_access_tokens').insert({
    token,
    client_id: clientId,
    expires_at: new Date(expiresAtMs).toISOString(),
  });
  if (error) throw new Error(`access token persist failed: ${error.message}`);
  validationCache.set(token, expiresAtMs);
  return token;
}

async function issueTokens(clientId: string): Promise<{ accessToken: string; refreshToken: string }> {
  const accessToken = await issueAccessToken(clientId);
  const refreshToken = generateId();
  const supabase = getSupabaseClient();
  const { error } = await supabase.from('mcp_oauth_refresh_tokens').insert({
    token: refreshToken,
    client_id: clientId,
    revoked: false,
  });
  if (error) throw new Error(`refresh token persist failed: ${error.message}`);
  return { accessToken, refreshToken };
}

// ---- Token Validation ----

export async function validateAccessToken(token: string): Promise<boolean> {
  // Hot path: in-memory positive cache
  const cached = validationCache.get(token);
  if (cached !== undefined) {
    if (Date.now() < cached) return true;
    validationCache.delete(token);
    return false; // access tokens are never reissued under the same value
  }

  // Cache miss (e.g. right after a redeploy) — Supabase is the source of truth.
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('mcp_oauth_access_tokens')
      .select('expires_at')
      .eq('token', token)
      .maybeSingle();

    if (error) {
      console.error('[OAuth] validate: supabase lookup failed —', error.message);
      return false; // fail closed
    }
    if (!data) return false;

    const expiresAtMs = new Date(data.expires_at).getTime();
    if (Date.now() > expiresAtMs) {
      await supabase.from('mcp_oauth_access_tokens').delete().eq('token', token);
      return false;
    }
    validationCache.set(token, expiresAtMs);
    return true;
  } catch (err) {
    console.error('[OAuth] validate: error —', err instanceof Error ? err.message : err);
    return false;
  }
}
