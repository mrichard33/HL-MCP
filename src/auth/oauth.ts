import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ---- In-memory stores ----

interface RegisteredClient {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
}

interface StoredAuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  expiresAt: number;
}

interface StoredToken {
  token: string;
  clientId: string;
  expiresAt: number;
}

const clients = new Map<string, RegisteredClient>();
const authCodes = new Map<string, StoredAuthCode>();
const accessTokens = new Map<string, StoredToken>();

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
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post'],
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

    const client: RegisteredClient = { clientId, clientSecret, redirectUris };
    clients.set(clientId, client);

    console.log(`[OAuth] register: client registered (id: ${clientId.slice(0, 8)}…, redirectUris: ${redirectUris.length}, total clients: ${clients.size})`);

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

function handleAuthorizeGet(res: ServerResponse, url: URL): void {
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

    console.log(`[OAuth] authorize GET: client=${clientId.slice(0, 8)}…, redirect=${redirectUri}, hasChallenge=${!!codeChallenge}, registered clients: ${clients.size}`);

    // Auto-approve — issue authorization code and redirect immediately
    const code = createAuthorizationCode(clientId, redirectUri, codeChallenge, codeChallengeMethod);
    const location = buildRedirectUrl(redirectUri, code, state);
    res.writeHead(302, { Location: location });
    res.end();
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

    console.log(`[OAuth] authorize POST: client=${clientId.slice(0, 8)}…, redirect=${redirectUri}, hasChallenge=${!!codeChallenge}, registered clients: ${clients.size}`);

    const code = createAuthorizationCode(clientId, redirectUri, codeChallenge, codeChallengeMethod);
    const location = buildRedirectUrl(redirectUri, code, state);
    res.writeHead(302, { Location: location });
    res.end();
  } catch (err) {
    console.error('[OAuth] authorize POST: error', err instanceof Error ? err.message : err);
    jsonResponse(res, 400, { error: 'server_error', error_description: 'Failed to process authorization request' });
  }
}

function createAuthorizationCode(
  clientId: string,
  redirectUri: string,
  codeChallenge: string,
  codeChallengeMethod: string,
): string {
  const code = generateId();
  authCodes.set(code, {
    code,
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
  });
  console.log(`[OAuth] auth code created (code: ${code.slice(0, 8)}…, client: ${clientId.slice(0, 8)}…, authCodes size: ${authCodes.size})`);
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

    // Support both JSON and form-urlencoded
    let grantType: string;
    let code: string;
    let clientId: string;
    let redirectUri: string;
    let codeVerifier: string;

    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('application/json')) {
      const data = JSON.parse(body);
      grantType = data.grant_type;
      code = data.code;
      clientId = data.client_id;
      redirectUri = data.redirect_uri;
      codeVerifier = data.code_verifier;
    } else {
      const params = new URLSearchParams(body);
      grantType = params.get('grant_type') || '';
      code = params.get('code') || '';
      clientId = params.get('client_id') || '';
      redirectUri = params.get('redirect_uri') || '';
      codeVerifier = params.get('code_verifier') || '';
    }

    console.log(`[OAuth] token: grant_type=${grantType}, client=${(clientId || '').slice(0, 8)}…, hasCode=${!!code}, hasVerifier=${!!codeVerifier}`);

    if (grantType !== 'authorization_code') {
      console.log(`[OAuth] token: rejected unsupported grant_type: ${grantType}`);
      jsonResponse(res, 400, { error: 'unsupported_grant_type' });
      return;
    }

    // Look up the authorization code
    const stored = authCodes.get(code);
    if (!stored) {
      console.error(`[OAuth] token: unknown auth code (code: ${(code || '').slice(0, 8)}…, authCodes size: ${authCodes.size})`);
      jsonResponse(res, 400, { error: 'invalid_grant', error_description: 'Unknown authorization code' });
      return;
    }

    // Codes are single-use
    authCodes.delete(code);

    // Check expiry
    if (Date.now() > stored.expiresAt) {
      console.error('[OAuth] token: auth code expired');
      jsonResponse(res, 400, { error: 'invalid_grant', error_description: 'Authorization code expired' });
      return;
    }

    // Validate redirect_uri matches
    if (redirectUri && redirectUri !== stored.redirectUri) {
      console.error(`[OAuth] token: redirect_uri mismatch (got: ${redirectUri}, expected: ${stored.redirectUri})`);
      jsonResponse(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      return;
    }

    // Verify PKCE
    if (stored.codeChallenge) {
      if (!codeVerifier) {
        console.error('[OAuth] token: PKCE code_verifier missing');
        jsonResponse(res, 400, { error: 'invalid_request', error_description: 'code_verifier required' });
        return;
      }
      if (!verifyPkce(codeVerifier, stored.codeChallenge)) {
        console.error('[OAuth] token: PKCE verification failed');
        jsonResponse(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return;
      }
    }

    // Issue access token (24 hours)
    const expiresIn = 24 * 60 * 60;
    const token = generateId();
    accessTokens.set(token, {
      token,
      clientId: stored.clientId,
      expiresAt: Date.now() + expiresIn * 1000,
    });

    console.log(`[OAuth] token: issued access token (token: ${token.slice(0, 8)}…, client: ${stored.clientId.slice(0, 8)}…, accessTokens size: ${accessTokens.size})`);

    jsonResponse(res, 200, {
      access_token: token,
      token_type: 'bearer',
      expires_in: expiresIn,
    });
  } catch (err) {
    console.error('[OAuth] token: error', err instanceof Error ? err.message : err);
    jsonResponse(res, 400, { error: 'invalid_request' });
  }
}

// ---- Token Validation ----

export function validateAccessToken(token: string): boolean {
  const stored = accessTokens.get(token);
  if (!stored) {
    console.log(`[OAuth] validate: token not found (accessTokens size: ${accessTokens.size})`);
    return false;
  }
  if (Date.now() > stored.expiresAt) {
    console.log(`[OAuth] validate: token expired (client: ${stored.clientId.slice(0, 8)}…)`);
    accessTokens.delete(token);
    return false;
  }
  return true;
}
