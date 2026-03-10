/**
 * GHL OAuth 2.0 token management.
 *
 * Handles automatic token refresh using the same pattern as the Firebase auth
 * in ghl.ts. Tokens are persisted to Supabase so they survive restarts.
 *
 * One-time setup:
 *   1. Set GHL_OAUTH_CLIENT_ID and GHL_OAUTH_CLIENT_SECRET in .env
 *   2. Visit GET /ghl-oauth/authorize — redirects to GHL consent screen
 *   3. GHL redirects back to /ghl-oauth/callback with an auth code
 *   4. The callback exchanges the code for tokens and stores them
 *
 * After that, getOAuthAccessToken() auto-refreshes as needed.
 */

import { getSupabaseClient } from './supabase.js';

const GHL_TOKEN_URL = 'https://services.leadconnectorhq.com/oauth/token';
const GHL_AUTHORIZE_URL = 'https://marketplace.gohighlevel.com/oauth/chooselocation';

// In-memory cache (populated from Supabase on first call)
let cachedToken: {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
} | null = null;

function getClientId(): string {
  const id = process.env.GHL_OAUTH_CLIENT_ID;
  if (!id) throw new Error('GHL_OAUTH_CLIENT_ID not set');
  return id;
}

function getClientSecret(): string {
  const secret = process.env.GHL_OAUTH_CLIENT_SECRET;
  if (!secret) throw new Error('GHL_OAUTH_CLIENT_SECRET not set');
  return secret;
}

/** Whether OAuth credentials are configured (client ID + secret). */
export function isOAuthConfigured(): boolean {
  return !!(process.env.GHL_OAUTH_CLIENT_ID && process.env.GHL_OAUTH_CLIENT_SECRET);
}

// ---- Token Persistence (Supabase) ----

async function loadTokenFromSupabase(): Promise<typeof cachedToken> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('ghl_oauth_tokens')
    .select('access_token, refresh_token, expires_at')
    .eq('location_id', process.env.GHL_LOCATION_ID || 'default')
    .single();

  if (error || !data) return null;

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(data.expires_at).getTime(),
  };
}

async function saveTokenToSupabase(
  accessToken: string,
  refreshToken: string,
  expiresAt: number,
): Promise<void> {
  const supabase = getSupabaseClient();
  await supabase.from('ghl_oauth_tokens').upsert(
    {
      location_id: process.env.GHL_LOCATION_ID || 'default',
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: new Date(expiresAt).toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'location_id' },
  );
}

// ---- Token Refresh ----

async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const response = await fetch(GHL_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: getClientId(),
      client_secret: getClientSecret(),
      refresh_token: refreshToken,
    }).toString(),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GHL OAuth refresh failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

/**
 * Get a valid OAuth access token, refreshing if needed.
 * Follows the same caching pattern as getFirebaseToken() in ghl.ts.
 */
export async function getOAuthAccessToken(): Promise<string> {
  // Load from Supabase if not in memory
  if (!cachedToken) {
    cachedToken = await loadTokenFromSupabase();
  }

  if (!cachedToken) {
    throw new Error(
      'GHL OAuth not authorized yet. Visit /ghl-oauth/authorize to complete the one-time setup.',
    );
  }

  // Return cached token if still valid (with 5-min buffer)
  if (Date.now() < cachedToken.expiresAt - 300_000) {
    return cachedToken.accessToken;
  }

  // Refresh
  console.error('[GHL-OAuth] Refreshing access token...');
  const result = await refreshAccessToken(cachedToken.refreshToken);
  const expiresAt = Date.now() + result.expiresIn * 1000;

  cachedToken = {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt,
  };

  await saveTokenToSupabase(result.accessToken, result.refreshToken, expiresAt);
  console.error('[GHL-OAuth] Token refreshed successfully');

  return result.accessToken;
}

// ---- Authorization Code Exchange (one-time setup) ----

/**
 * Build the GHL authorization URL for the consent screen.
 */
export function getAuthorizeUrl(redirectUri: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: getClientId(),
    redirect_uri: redirectUri,
    scope: 'conversations.readonly conversations.write conversations/message.readonly conversations/message.write contacts.readonly',
  });
  return `${GHL_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Exchange an authorization code for tokens and persist them.
 */
export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
): Promise<void> {
  const response = await fetch(GHL_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: getClientId(),
      client_secret: getClientSecret(),
      code,
      redirect_uri: redirectUri,
    }).toString(),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GHL OAuth code exchange failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
  };

  const expiresAt = Date.now() + data.expires_in * 1000;

  cachedToken = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt,
  };

  await saveTokenToSupabase(data.access_token, data.refresh_token, expiresAt);
  console.error('[GHL-OAuth] Authorization complete — tokens stored');
}
