// ─── GHL API Client — src/clients/ghl.ts ─────────────────────────
//
// v1.9 (2026-04-27) — Added getLossReasons() to fetch the location's
//         configured built-in Lost Reasons. Pairs with the
//         lostReasonId param added to the update_opportunity MCP tool
//         in the same change-set. Reason: WF1 P1 Loss Router (and any
//         workflow that gates on lost-marking) reads GHL's built-in
//         `lostReasonId` field, not the custom "Lost Type" field. The
//         MCP previously had no way to populate it, so loss-needs-reason
//         tags re-applied on every agentic loss-marking attempt
//         (surfaced during 2026-04-27 Lisa Mackinnon cleanup).
//
// v1.8 (T2.3) — Added searchOpportunities() + getOpportunitiesUpdatedSince()
//         for incremental opportunity sync via POST /opportunities/search
//         with a dateUpdated filter. Mirrors the v1.6 contacts pattern.
//         Caller in entity-syncer.ts tries this first and falls back to
//         the existing GET /opportunities/search + client-side diff when
//         the filter is unsupported or appears ignored. The opportunity
//         search endpoint is less stable than contacts — the fallback
//         path (and daily full reconcile) keeps the sync safe even if
//         GHL changes the schema.
//         2026-04-24 production fix: searchOpportunities body sends
//         `locationId` (camelCase) not `location_id` (snake_case). GHL's
//         POST body convention differs from the GET query-param
//         convention on the same resource (matches searchContacts which
//         has always used locationId).
//         2026-04-24 follow-up fix: body uses `limit` (not `pageLimit`)
//         for pagination. After the locationId fix, GHL responded with
//         HTTP 422 "property pageLimit should not exist" — the opp
//         search DTO uses a different pagination property name than
//         the contacts search DTO. The caller-facing parameter name
//         stays `pageLimit` for consistency with searchContacts; only
//         the wire format changes.
//
// v1.7 — Extended getConversations() with sortBy/sort params and
//         richer return type (meta, total) so callers can walk
//         /conversations/search as a location-wide feed ordered by
//         last_message_date. Extended getAllMessages() with an
//         optional sinceIso cutoff that breaks pagination early and
//         filters results to messages dateAdded >= sinceIso. Together
//         these enable the watermark-based incremental sync in
//         entity-syncer.ts — replacing the per-contact iteration that
//         was the root cause of the 2026-04-07 message sync hang.
//
// v1.6 — Added searchContacts() + getContactsUpdatedSince() for
//         incremental contact sync via POST /contacts/search with
//         a dateUpdated filter. Lets the 15-min cron fetch only
//         changed records instead of re-pulling all 3,400+ contacts
//         every cycle.
//
// v1.3 — Added 429 retry logic to request() and requestWithOAuth().
//         Per CONVERSATION_SYNC_CHANGES.md, this was the planned 2026-04-04
//         fix for 71% of conversations having metadata but zero stored
//         messages. Root cause: message fetches hit GHL rate limits,
//         silently failed, but `synced_at` got bumped anyway so the
//         round-robin scheduler moved on and never retried.
//         The fix never made it into the code (or was reverted) — both
//         request() and requestWithOAuth() just throw immediately on 429.
//         This v1.3 adds the retry pattern: up to 3 attempts with
//         exponential backoff (2s, 4s, 8s) on 429 responses only. Other
//         errors still throw immediately. Each retry re-acquires a token
//         from the rate limiter, which will wait if the bucket is paused.
//
// v1.1 — Added per-request timeout to every fetch() call.
//         Node's fetch has NO default timeout; a stalled response pins
//         the sync mutex (runningJobs) forever, silently killing all
//         subsequent scheduled runs of that entity sync. This was the
//         root cause of opportunities/appointments/conversations/messages
//         going stale from 2026-04-07 onward — the initial call hung,
//         `isJobRunning(name)` stayed true, and every later cron fire
//         was skipped without logging an error.
//         All 5 fetch() sites now route through fetchWithTimeout() which
//         aborts with a readable error after REQUEST_TIMEOUT_MS (default
//         60s, override via env GHL_REQUEST_TIMEOUT_MS).

import type {
  GHLContact,
  GHLPipeline,
  GHLOpportunity,
  GHLWorkflow,
  GHLConversation,
  GHLMessage,
  GHLCalendar,
  GHLAppointment,
  GHLPaginationMeta,
  FirebaseTokenResponse,
  GHLCustomField,
  GHLCustomValue,
  GHLTag,
  GHLLink,
} from '../types/ghl.js';
import { isOAuthConfigured, getOAuthAccessToken } from './ghl-oauth.js';
import { isRealMessage } from '../utils/message-filter.js';
import { acquireToken, report429, reportSuccess } from './ghl-rate-limiter.js';

const DEFAULT_BASE_URL = 'https://services.leadconnectorhq.com';
const BACKEND_BASE_URL = 'https://backend.leadconnectorhq.com';
const FIREBASE_TOKEN_URL = 'https://securetoken.googleapis.com/v1/token';

// v1.1: Per-request timeout. Without this, a hung TCP connection to the
// GHL API pins the containing sync job's runJob() mutex forever, causing
// the recurring cron for that entity to silently skip all future runs.
// Override via env: GHL_REQUEST_TIMEOUT_MS=120000
const REQUEST_TIMEOUT_MS = parseInt(process.env.GHL_REQUEST_TIMEOUT_MS || '60000', 10);

// v1.3: 429 retry policy. Matches intent of the 2026-04-04 planned fix
// (see CONVERSATION_SYNC_CHANGES.md). Exponential backoff on 429 only —
// other errors (500, 401, etc.) throw immediately.
const MAX_RETRIES_ON_429 = 3;
const RETRY_BACKOFF_MS = [2000, 4000, 8000];

// v1.8 (T2.2b): Gate verbose per-workflow diagnostic logging shared with
// workflow-extractor.ts. When false, getWorkflowTriggers() suppresses
// its per-workflow "Trigger API response" log. Matches the flag defined
// in workflow-extractor.ts so one env toggle controls the full workflow
// sync debug surface.
const DEBUG_WORKFLOW_SYNC = process.env.DEBUG_WORKFLOW_SYNC === 'true';

/**
 * fetch() with an AbortController-based timeout.
 * Uses AbortController + setTimeout (Node 16+) rather than
 * AbortSignal.timeout() (Node 17.3+) for broader compatibility.
 * The `label` is included in the thrown error to aid log diagnosis.
 */
async function fetchWithTimeout(url: string, init: RequestInit, label: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`GHL request timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ${label}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sleep helper used by the 429 retry loop.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  params?: Record<string, string>;
}

// Firebase token cache
let cachedFirebaseToken: { idToken: string; expiresAt: number } | null = null;
let cachedFirebaseTokenError: { message: string; expiresAt: number } | null = null;

export class GHLClient {
  private apiKey: string;
  private baseUrl: string;
  private locationId: string;
  private firebaseApiKey?: string;
  private firebaseRefreshToken?: string;

  constructor() {
    const apiKey = process.env.GHL_API_KEY;
    if (!apiKey) throw new Error('Missing GHL_API_KEY environment variable');
    this.apiKey = apiKey;
    this.baseUrl = process.env.GHL_BASE_URL || DEFAULT_BASE_URL;
    const locationId = process.env.GHL_LOCATION_ID;
    if (!locationId) throw new Error('Missing GHL_LOCATION_ID environment variable — required for GHL API v2');
    this.locationId = locationId;
    this.firebaseApiKey = process.env.GHL_FIREBASE_API_KEY;
    this.firebaseRefreshToken = process.env.GHL_FIREBASE_REFRESH_TOKEN;
  }

  /**
   * Rate-limited API key request.
   * v1.3: Retries up to MAX_RETRIES_ON_429 times on HTTP 429 with exponential backoff.
   */
  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    for (let attempt = 0; attempt < MAX_RETRIES_ON_429; attempt++) {
      await acquireToken();

      const url = new URL(path, this.baseUrl);
      if (options.params) {
        for (const [key, value] of Object.entries(options.params)) {
          url.searchParams.set(key, value);
        }
      }
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        Version: '2021-07-28',
      };

      const method = options.method || 'GET';
      const response = await fetchWithTimeout(url.toString(), {
        method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
      }, `${method} ${path}`);

      if (response.status === 429) {
        report429();
        if (attempt < MAX_RETRIES_ON_429 - 1) {
          const backoff = RETRY_BACKOFF_MS[attempt];
          console.warn(`[GHL] 429 on ${method} ${path} (attempt ${attempt + 1}/${MAX_RETRIES_ON_429}), retrying in ${backoff}ms`);
          await sleep(backoff);
          continue;
        }
        throw new Error(`GHL API error 429: Too Many Requests (after ${MAX_RETRIES_ON_429} attempts)`);
      }

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`GHL API error ${response.status}: ${errorBody}`);
      }

      reportSuccess();
      return response.json() as Promise<T>;
    }

    // Unreachable — the loop either returns or throws on every path.
    throw new Error(`GHL request to ${path} failed after ${MAX_RETRIES_ON_429} attempts`);
  }

  /**
   * Rate-limited OAuth request. Same shared token bucket.
   * v1.3: Retries up to MAX_RETRIES_ON_429 times on HTTP 429 with exponential backoff.
   */
  private async requestWithOAuth<T>(path: string, options: RequestOptions = {}): Promise<T> {
    for (let attempt = 0; attempt < MAX_RETRIES_ON_429; attempt++) {
      await acquireToken();

      const url = new URL(path, this.baseUrl);
      if (options.params) {
        for (const [key, value] of Object.entries(options.params)) {
          url.searchParams.set(key, value);
        }
      }
      let authToken: string;
      if (isOAuthConfigured()) {
        authToken = await getOAuthAccessToken();
      } else {
        authToken = this.apiKey;
      }
      const headers: Record<string, string> = {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
        Version: '2021-07-28',
      };

      const method = options.method || 'GET';
      const response = await fetchWithTimeout(url.toString(), {
        method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
      }, `${method} ${path} (oauth)`);

      if (response.status === 429) {
        report429();
        if (attempt < MAX_RETRIES_ON_429 - 1) {
          const backoff = RETRY_BACKOFF_MS[attempt];
          console.warn(`[GHL] 429 on ${method} ${path} oauth (attempt ${attempt + 1}/${MAX_RETRIES_ON_429}), retrying in ${backoff}ms`);
          await sleep(backoff);
          continue;
        }
        throw new Error(`GHL API error 429: Too Many Requests (after ${MAX_RETRIES_ON_429} attempts)`);
      }

      if (!response.ok) {
        const errorBody = await response.text();
        if (response.status === 401 || response.status === 403) {
          console.error(`[GHL] OAuth ${response.status} for ${path} — token may be invalid, expired, or missing required scopes. Body: ${errorBody}`);
        }
        throw new Error(`GHL API error ${response.status}: ${errorBody}`);
      }

      reportSuccess();
      return response.json() as Promise<T>;
    }

    // Unreachable — the loop either returns or throws on every path.
    throw new Error(`GHL OAuth request to ${path} failed after ${MAX_RETRIES_ON_429} attempts`);
  }

  get isOAuthConfigured(): boolean { return isOAuthConfigured(); }

  // ---- Firebase Auth (NOT rate-limited — different API) ----

  private get hasFirebaseAuth(): boolean { return !!(this.firebaseApiKey && this.firebaseRefreshToken); }
  get isFirebaseAuthConfigured(): boolean { return this.hasFirebaseAuth; }

  private async getFirebaseToken(): Promise<string> {
    if (!this.firebaseApiKey || !this.firebaseRefreshToken) {
      throw new Error('Firebase auth not configured — set GHL_FIREBASE_API_KEY and GHL_FIREBASE_REFRESH_TOKEN');
    }
    if (cachedFirebaseToken && Date.now() < cachedFirebaseToken.expiresAt - 300_000) {
      return cachedFirebaseToken.idToken;
    }
    if (cachedFirebaseTokenError && Date.now() < cachedFirebaseTokenError.expiresAt) {
      throw new Error(`Firebase token refresh failed (cached): ${cachedFirebaseTokenError.message}`);
    }
    const url = `${FIREBASE_TOKEN_URL}?key=${this.firebaseApiKey}`;
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.firebaseRefreshToken });
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }, 'Firebase token refresh');
    if (!response.ok) {
      const errorBody = await response.text();
      const errorMsg = `Firebase token error ${response.status}: ${errorBody}`;
      cachedFirebaseTokenError = { message: errorMsg, expiresAt: Date.now() + 300_000 };
      throw new Error(errorMsg);
    }
    const data = await response.json() as FirebaseTokenResponse;
    const expiresInMs = parseInt(data.expires_in, 10) * 1000;
    cachedFirebaseToken = { idToken: data.id_token, expiresAt: Date.now() + expiresInMs };
    cachedFirebaseTokenError = null;
    return data.id_token;
  }

  // ---- Contacts ----

  async getContacts(params?: { limit?: number; query?: string; startAfter?: string; startAfterId?: string }): Promise<{ contacts: GHLContact[]; meta?: GHLPaginationMeta }> {
    const reqParams: Record<string, string> = { locationId: this.locationId };
    if (params?.limit) reqParams.limit = String(params.limit);
    if (params?.query) reqParams.query = params.query;
    if (params?.startAfter) reqParams.startAfter = params.startAfter;
    if (params?.startAfterId) reqParams.startAfterId = params.startAfterId;
    return this.request('/contacts/', { params: reqParams });
  }

  async getAllContacts(): Promise<GHLContact[]> {
    const allContacts: GHLContact[] = [];
    let startAfter: string | undefined;
    let startAfterId: string | undefined;
    let pageCount = 0;
    const MAX_PAGES = 200;
    do {
      const result = await this.getContacts({ limit: 100, startAfter, startAfterId });
      allContacts.push(...(result.contacts || []));
      pageCount++;
      startAfter = result.meta?.startAfter;
      startAfterId = result.meta?.startAfterId;
      if (!result.contacts?.length || (!startAfter && !startAfterId)) break;
    } while (pageCount < MAX_PAGES);
    return allContacts;
  }

  /**
   * v1.6: Incremental contact search via POST /contacts/search.
   *
   * Used by the 15-min incremental sync to fetch only contacts whose
   * `dateUpdated` is >= a floor timestamp, rather than re-pulling every
   * contact in the location on every cycle.
   *
   * API shape note: GHL's search endpoints are less stable than the simple
   * list endpoints. If the response is 400 or the filter appears ignored
   * (e.g. returned total ~= total location contacts), treat it as a signal
   * that the filter schema has shifted and the caller should fall back to
   * a full fetch for that cycle. Daily full reconcile catches any drift.
   */
  async searchContacts(params: {
    updatedSinceIso?: string;
    page?: number;
    pageLimit?: number;
  }): Promise<{ contacts: GHLContact[]; total?: number }> {
    const body: Record<string, unknown> = {
      locationId: this.locationId,
      page: params.page ?? 1,
      pageLimit: params.pageLimit ?? 100,
    };
    if (params.updatedSinceIso) {
      body.filters = [
        {
          field: 'dateUpdated',
          operator: 'range',
          value: { gte: params.updatedSinceIso },
        },
      ];
      body.sort = [{ field: 'dateUpdated', direction: 'asc' }];
    }
    const res = await this.request<{ contacts?: GHLContact[]; total?: number }>(
      '/contacts/search',
      { method: 'POST', body },
    );
    return { contacts: res.contacts || [], total: res.total };
  }

  /**
   * v1.6: Fetch all contacts with dateUpdated >= `updatedSinceIso`, paginating
   * through /contacts/search until exhausted.
   *
   * Returns the fetched records and the server-reported total so the caller
   * can sanity-check the filter against location size (if returned total is
   * close to 100% of contacts, the filter likely wasn't applied).
   */
  async getContactsUpdatedSince(updatedSinceIso: string): Promise<{ contacts: GHLContact[]; totalReportedByServer: number | null }> {
    const all: GHLContact[] = [];
    const PAGE_LIMIT = 100;
    const MAX_PAGES = 200;
    let totalReported: number | null = null;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const result = await this.searchContacts({ updatedSinceIso, page, pageLimit: PAGE_LIMIT });
      if (page === 1 && typeof result.total === 'number') totalReported = result.total;
      all.push(...(result.contacts || []));
      if (!result.contacts.length || result.contacts.length < PAGE_LIMIT) break;
    }
    return { contacts: all, totalReportedByServer: totalReported };
  }

  async getContact(contactId: string): Promise<GHLContact> {
    const res = await this.request<{ contact: GHLContact }>(`/contacts/${contactId}`);
    return res.contact;
  }

  async createContact(data: Partial<GHLContact>): Promise<GHLContact> {
    const body = { ...data, locationId: data.locationId || this.locationId };
    const res = await this.request<{ contact: GHLContact }>('/contacts/', { method: 'POST', body });
    return res.contact;
  }

  /**
   * Update a contact via PUT /contacts/{id}.
   *
   * SAFETY: GHL's PUT endpoint WHOLESALE-REPLACES the contact's tag set
   * if a `tags` field is present in the body. Past incidents:
   *   - n8n LP Lead Enrichment v2.0 (2026-05-15) — Mark Test contact
   *   - Kristen Nichols (2026-05-19) — jVpX2i4EXSQccsdAP8xR lost
   *     entry:estimate-calculator, active-entry:estimate-calculator,
   *     and ghl-attributed
   * Both wiped because unrelated upstream code passed a tags array
   * through a PUT path. Defense in depth: this method strips `tags`
   * from the body before sending. Callers that need to mutate tags
   * must use addContactTags() (POST) or removeContactTags() (DELETE),
   * which are additive/subtractive.
   *
   * If a caller passes `tags`, log a loud error with the payload so the
   * misuse surfaces in Railway logs and can be traced to its source.
   */
  async updateContact(contactId: string, data: Partial<GHLContact>): Promise<GHLContact> {
    let safeData = data;
    if (data && 'tags' in (data as Record<string, unknown>)) {
      const offendingTags = (data as Record<string, unknown>).tags;
      console.error(
        `[GHLClient.updateContact] BLOCKED tags-wipe on contact ${contactId}. ` +
        `Caller passed tags=${JSON.stringify(offendingTags)}. ` +
        `Tags stripped from PUT body. Use addContactTags / removeContactTags instead.`
      );
      const stripped = { ...(data as Record<string, unknown>) };
      delete stripped.tags;
      safeData = stripped as Partial<GHLContact>;
    }
    const res = await this.request<{ contact: GHLContact }>(`/contacts/${contactId}`, { method: 'PUT', body: safeData });
    return res.contact;
  }

  async deleteContact(contactId: string): Promise<void> {
    await this.request(`/contacts/${contactId}`, { method: 'DELETE' });
  }

  /**
   * Add tags to a contact (additive — does NOT replace existing tags).
   * Uses POST /contacts/{id}/tags
   */
  async addContactTags(contactId: string, tags: string[]): Promise<{ tags: string[] }> {
    return this.request<{ tags: string[] }>(`/contacts/${contactId}/tags`, {
      method: 'POST',
      body: { tags },
    });
  }

  /**
   * Remove specific tags from a contact (subtractive — only removes listed tags).
   * Uses DELETE /contacts/{id}/tags
   */
  async removeContactTags(contactId: string, tags: string[]): Promise<{ tags: string[] }> {
    return this.request<{ tags: string[] }>(`/contacts/${contactId}/tags`, {
      method: 'DELETE',
      body: { tags },
    });
  }

  /**
   * Update custom fields on a contact without touching other fields.
   * Uses PUT /contacts/{id} with only customFields in the body.
   */
  async updateContactCustomFields(contactId: string, customFields: Array<{ id: string; field_value: string | number | boolean }>): Promise<GHLContact> {
    const res = await this.request<{ contact: GHLContact }>(`/contacts/${contactId}`, {
      method: 'PUT',
      body: { customFields },
    });
    return res.contact;
  }

  /**
   * Add an internal note to a contact's GHL record.
   * Uses POST /contacts/{id}/notes
   */
  async addContactNote(
    contactId: string,
    body: string,
    userId?: string,
  ): Promise<{ id: string; body: string; dateAdded: string }> {
    const res = await this.request<{ note: { id: string; body: string; dateAdded: string } }>(
      `/contacts/${contactId}/notes`,
      {
        method: 'POST',
        body: userId ? { body, userId } : { body },
      },
    );
    return res.note;
  }

  // ---- Pipelines ----

  async getPipelines(): Promise<GHLPipeline[]> {
    const res = await this.request<{ pipelines: GHLPipeline[] }>('/opportunities/pipelines', { params: { locationId: this.locationId } });
    return res.pipelines;
  }

  /**
   * v1.9 (2026-04-27): Fetch the location's configured Lost Reasons (the
   * built-in GHL Lost Reason picker shown when marking an opportunity as
   * Lost). Returns the raw response so the tool layer can normalize across
   * any schema drift.
   *
   * Endpoint: GET /opportunities/loss-reasons?locationId=...
   * (parallel construction with /opportunities/pipelines)
   *
   * Why this exists: WF1 P1 Loss Router (and any workflow that gates on
   * lost-marking) reads GHL's built-in `lostReasonId` field, NOT the custom
   * "Lost Type" field (m86JGp47yteVL0FV7MFW). Pairs with the lostReasonId
   * param on update_opportunity so agentic loss-marking can fully clear
   * downstream gates without manual GHL UI intervention.
   *
   * Response shape — has been observed as any of:
   *   { lossReasons: [{ id, name, ... }] }    (parallel with pipelines)
   *   { data: [{ id, name, ... }] }           (collection wrapper convention)
   *   [{ id, name, ... }]                     (bare array)
   * Returns unknown — get_lost_reasons in src/tools/pipelines.ts normalizes.
   *
   * If GHL returns 404 on this path, try the singular form
   * `/opportunities/loss-reason` — both have been documented at various
   * points in the GHL API docs.
   */
  async getLossReasons(): Promise<unknown> {
    return this.request<unknown>('/opportunities/loss-reasons', {
      params: { locationId: this.locationId },
    });
  }

  // ---- Opportunities ----

  async getOpportunities(params?: { pipelineId?: string; status?: string; q?: string; contactId?: string; assignedTo?: string; limit?: number; startAfter?: string; startAfterId?: string }): Promise<{ opportunities: GHLOpportunity[]; meta?: GHLPaginationMeta }> {
    const reqParams: Record<string, string> = { location_id: this.locationId };
    if (params?.pipelineId) reqParams.pipeline_id = params.pipelineId;
    if (params?.status) reqParams.status = params.status;
    if (params?.q) reqParams.q = params.q;
    if (params?.contactId) reqParams.contact_id = params.contactId;
    if (params?.assignedTo) reqParams.assigned_to = params.assignedTo;
    if (params?.limit) reqParams.limit = String(params.limit);
    if (params?.startAfter) reqParams.startAfter = params.startAfter;
    if (params?.startAfterId) reqParams.startAfterId = params.startAfterId;
    return this.request('/opportunities/search', { method: 'GET', params: reqParams });
  }

  async getAllOpportunities(): Promise<GHLOpportunity[]> {
    const all: GHLOpportunity[] = [];
    let startAfter: string | undefined;
    let startAfterId: string | undefined;
    let pageCount = 0;
    const MAX_PAGES = 200;
    do {
      const result = await this.getOpportunities({ limit: 100, startAfter, startAfterId });
      all.push(...(result.opportunities || []));
      pageCount++;
      startAfter = result.meta?.startAfter;
      startAfterId = result.meta?.startAfterId;
      if (!result.opportunities?.length || (!startAfter && !startAfterId)) break;
    } while (pageCount < MAX_PAGES);
    return all;
  }

  /**
   * v1.8 (T2.3): Incremental opportunity search via POST /opportunities/search.
   *
   * Attempts to fetch only opportunities whose `dateUpdated` is >= a floor
   * timestamp, rather than re-pulling all 4,000+ opportunities every cycle.
   * Request body shape mirrors searchContacts() (v1.6) which GHL accepts
   * reliably. GHL's opportunity search endpoint is LESS stable than
   * contacts — it historically only accepted GET query params, and some
   * tenants reject POST filter bodies with 400 or silently ignore the
   * filter and return the full location.
   *
   * BECAUSE OF THAT, ALL CALLERS MUST:
   *   1. Catch thrown errors (400/500) and fall back to GET + client diff.
   *   2. Sanity-check the returned total: if it looks like the full
   *      location size (>1500 here, since normal incremental is < a few
   *      hundred), assume the filter was ignored and fall back.
   *
   * The caller in entity-syncer.ts::syncOpportunities handles both cases.
   * The daily 3:10 AM ET full reconcile catches any drift regardless.
   *
   * 2026-04-24 production fix #1: body uses `locationId` (camelCase)
   * because POST /opportunities/search expects camelCase in the body —
   * even though the GET endpoint uses `location_id` (snake_case) as a
   * query param. Sending `location_id` in the body produced:
   *   400 "LocationId is missing in body"
   *
   * 2026-04-24 production fix #2: body uses `limit` (not `pageLimit`)
   * for page size. After fix #1, GHL responded with:
   *   422 "property pageLimit should not exist"
   * NestJS class-validator strict whitelist on the opportunities DTO
   * rejected `pageLimit`. The opportunities DTO accepts `limit`
   * (matching the GET counterpart convention), while the contacts
   * search DTO accepts `pageLimit` — different DTO definitions per
   * resource. The method signature keeps `pageLimit` as the caller
   * parameter name for API consistency with searchContacts; the
   * field-name remap happens only when building the body.
   */
  async searchOpportunities(params: {
    updatedSinceIso?: string;
    page?: number;
    pageLimit?: number;
  }): Promise<{ opportunities: GHLOpportunity[]; total?: number }> {
    const body: Record<string, unknown> = {
      locationId: this.locationId,
      page: params.page ?? 1,
      limit: params.pageLimit ?? 100,
    };
    if (params.updatedSinceIso) {
      body.filters = [
        {
          field: 'dateUpdated',
          operator: 'range',
          value: { gte: params.updatedSinceIso },
        },
      ];
      body.sort = [{ field: 'dateUpdated', direction: 'asc' }];
    }
    const res = await this.request<{ opportunities?: GHLOpportunity[]; total?: number }>(
      '/opportunities/search',
      { method: 'POST', body },
    );
    return { opportunities: res.opportunities || [], total: res.total };
  }

  /**
   * v1.8 (T2.3): Fetch all opportunities with dateUpdated >= `updatedSinceIso`,
   * paginating through POST /opportunities/search until exhausted.
   *
   * Returns the fetched records and the server-reported total so the caller
   * can sanity-check the filter against location size. If returned total is
   * close to 100% of location opps, the filter likely wasn't applied and
   * caller should fall back to full fetch + client-side diff.
   */
  async getOpportunitiesUpdatedSince(updatedSinceIso: string): Promise<{ opportunities: GHLOpportunity[]; totalReportedByServer: number | null }> {
    const all: GHLOpportunity[] = [];
    const PAGE_LIMIT = 100;
    const MAX_PAGES = 50;
    let totalReported: number | null = null;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const result = await this.searchOpportunities({ updatedSinceIso, page, pageLimit: PAGE_LIMIT });
      if (page === 1 && typeof result.total === 'number') totalReported = result.total;
      all.push(...(result.opportunities || []));
      if (!result.opportunities.length || result.opportunities.length < PAGE_LIMIT) break;
    }
    return { opportunities: all, totalReportedByServer: totalReported };
  }

  async getOpportunity(opportunityId: string): Promise<GHLOpportunity> {
    const res = await this.request<{ opportunity: GHLOpportunity }>(`/opportunities/${opportunityId}`);
    return res.opportunity;
  }

  async createOpportunity(data: Partial<GHLOpportunity>): Promise<GHLOpportunity> {
    const body = { ...data, locationId: data.locationId || this.locationId };
    const res = await this.request<{ opportunity: GHLOpportunity }>('/opportunities/', { method: 'POST', body });
    return res.opportunity;
  }

  async updateOpportunity(opportunityId: string, data: Partial<GHLOpportunity>): Promise<GHLOpportunity> {
    const res = await this.request<{ opportunity: GHLOpportunity }>(`/opportunities/${opportunityId}`, { method: 'PUT', body: data });
    return res.opportunity;
  }

  // ---- Workflows ----

  async getWorkflows(): Promise<GHLWorkflow[]> {
    const res = await this.request<{ workflows: GHLWorkflow[] }>('/workflows/', { params: { locationId: this.locationId } });
    return res.workflows;
  }

  async getWorkflow(workflowId: string): Promise<GHLWorkflow> {
    const res = await this.request<{ workflow: GHLWorkflow }>(`/workflows/${workflowId}`);
    return res.workflow;
  }

  /**
   * Enroll a contact in a workflow.
   * Uses POST /contacts/{contactId}/workflow/{workflowId}
   */
  async enrollContactInWorkflow(workflowId: string, contactId: string, eventStartTime?: string): Promise<unknown> {
    const body: Record<string, string> = {};
    if (eventStartTime) body.eventStartTime = eventStartTime;
    return this.request(`/contacts/${contactId}/workflow/${workflowId}`, { method: 'POST', body });
  }

  /**
   * Remove a contact from a workflow (unenroll).
   * Uses DELETE /contacts/{contactId}/workflow/{workflowId}
   */
  async removeContactFromWorkflow(workflowId: string, contactId: string, eventStartTime?: string): Promise<unknown> {
    const body: Record<string, string> = {};
    if (eventStartTime) body.eventStartTime = eventStartTime;
    return this.request(`/contacts/${contactId}/workflow/${workflowId}`, { method: 'DELETE', body });
  }

  async getWorkflowDetail(workflowId: string): Promise<Record<string, unknown> | null> {
    if (!this.hasFirebaseAuth) return null;
    try {
      const idToken = await this.getFirebaseToken();
      const url = `${BACKEND_BASE_URL}/workflow/${this.locationId}/${workflowId}?includeScheduledPauseInfo=true`;
      const response = await fetchWithTimeout(url, { method: 'GET', headers: { Accept: 'application/json', channel: 'APP', 'token-id': idToken } }, `GET workflow detail ${workflowId}`);
      if (!response.ok) { console.error(`[GHL] Internal API failed for workflow ${workflowId} (${response.status})`); return null; }
      return response.json() as Promise<Record<string, unknown>>;
    } catch (err) {
      console.error(`[GHL] Firebase auth failed for workflow detail ${workflowId}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  async getWorkflowTriggers(workflowId: string): Promise<Record<string, unknown>[]> {
    if (!this.hasFirebaseAuth) return [];
    try {
      const idToken = await this.getFirebaseToken();
      const url = `${BACKEND_BASE_URL}/workflow/${this.locationId}/trigger?workflowId=${workflowId}`;
      const response = await fetchWithTimeout(url, { method: 'GET', headers: { Accept: 'application/json', channel: 'APP', 'token-id': idToken } }, `GET workflow triggers ${workflowId}`);
      if (!response.ok) { console.warn(`[GHL] Trigger API failed for workflow ${workflowId} (${response.status})`); return []; }
      const data = await response.json();
      // v1.8 (T2.2b): Gated behind DEBUG_WORKFLOW_SYNC. Previously printed
      // a diagnostic line for every workflow (~234 lines/cycle) — useful
      // only when diagnosing GHL trigger API schema drift.
      if (DEBUG_WORKFLOW_SYNC) {
        const dataType = Array.isArray(data) ? `Array[${data.length}]` : typeof data;
        const dataKeys = data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data).join(',') : 'N/A';
        console.log(`[GHL] Trigger API response for ${workflowId}: type=${dataType}, keys=${dataKeys}`);
      }
      if (Array.isArray(data)) return data;
      if (data && typeof data === 'object') {
        if (Array.isArray(data.triggers)) return data.triggers;
        if (Array.isArray(data.data)) return data.data;
      }
      return [data];
    } catch (err) {
      console.warn(`[GHL] Failed to fetch triggers for workflow ${workflowId}: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  // ---- Conversations ----

  /**
   * v1.7: Accepts `sortBy` and `sort` for location-wide DESC-by-last_message_date
   * walks. `meta` (startAfter cursors) and `total` are exposed in the return
   * type so callers can paginate and sanity-check counts. `contactId` remains
   * optional: omit it when using sortBy to get the location-wide feed.
   */
  async getConversations(params?: {
    contactId?: string;
    limit?: number;
    startAfter?: string;
    startAfterId?: string;
    sortBy?: 'last_message_date' | 'last_manual_message_date' | 'last_outbound_message_date' | 'score_profile';
    sort?: 'asc' | 'desc';
  }): Promise<{ conversations: GHLConversation[]; meta?: GHLPaginationMeta; total?: number }> {
    const reqParams: Record<string, string> = { locationId: this.locationId };
    if (params?.contactId) reqParams.contactId = params.contactId;
    if (params?.limit) reqParams.limit = String(params.limit);
    if (params?.startAfter) reqParams.startAfter = params.startAfter;
    if (params?.startAfterId) reqParams.startAfterId = params.startAfterId;
    if (params?.sortBy) reqParams.sortBy = params.sortBy;
    if (params?.sort) reqParams.sort = params.sort;
    return this.request('/conversations/search', { method: 'GET', params: reqParams });
  }

  async getAllConversations(contactId: string): Promise<GHLConversation[]> {
    const all: GHLConversation[] = [];
    let startAfter: string | undefined;
    let startAfterId: string | undefined;
    let pageCount = 0;
    const MAX_PAGES = 100;
    do {
      const result: { conversations: GHLConversation[]; meta?: GHLPaginationMeta } =
        await this.request('/conversations/search', {
          method: 'GET',
          params: { locationId: this.locationId, contactId, limit: '100', ...(startAfter ? { startAfter } : {}), ...(startAfterId ? { startAfterId } : {}) },
        });
      all.push(...(result.conversations || []));
      pageCount++;
      startAfter = result.meta?.startAfter;
      startAfterId = result.meta?.startAfterId;
      if (!result.conversations?.length || (!startAfter && !startAfterId)) break;
    } while (pageCount < MAX_PAGES);
    return all;
  }

  async getConversation(conversationId: string): Promise<GHLConversation> {
    const res = await this.request<{ conversation: GHLConversation }>(`/conversations/${conversationId}`);
    return res.conversation;
  }

  // ---- Messages ----

  async getMessages(conversationId: string, params?: { lastMessageId?: string }): Promise<{ messages: unknown }> {
    const reqParams: Record<string, string> = {};
    if (params?.lastMessageId) reqParams.lastMessageId = params.lastMessageId;
    return this.request(`/conversations/${conversationId}/messages`, { params: reqParams });
  }

  /**
   * Paginate through a conversation's messages. GHL returns messages DESC
   * by dateAdded with cursor pagination via `lastMessageId`.
   *
   * v1.7: Optional `sinceIso` cutoff. When provided:
   *   - Pagination breaks early once the oldest message in a page predates
   *     the cutoff (all remaining pages would be even older).
   *   - The returned array is filtered to messages with dateAdded >= sinceIso
   *     (missing/unparseable dates are kept to be safe).
   * This turns heavy-history conversations (years of messages) from an
   * N-page re-fetch into a 1-page check on every incremental sync cycle.
   */
  async getAllMessages(conversationId: string, maxPages = 20, sinceIso?: string): Promise<GHLMessage[]> {
    const sinceMs = sinceIso ? Date.parse(sinceIso) : 0;
    const all: GHLMessage[] = [];
    let lastMessageId: string | undefined;

    for (let page = 0; page < maxPages; page++) {
      const raw = await this.getMessages(conversationId, { lastMessageId });
      const inner = (raw.messages as any)?.messages ?? raw.messages;
      const msgs: GHLMessage[] = Array.isArray(inner) ? inner : [];
      all.push(...msgs);

      // v1.7: Early-exit when paginated past the cutoff.
      if (sinceMs > 0 && msgs.length > 0) {
        const oldestInPage = msgs[msgs.length - 1];
        const d = (oldestInPage as { dateAdded?: string | number }).dateAdded;
        const oldestMs = d
          ? (typeof d === 'string' ? Date.parse(d) : Number(d))
          : 0;
        if (oldestMs > 0 && oldestMs < sinceMs) break;
      }

      const nextPage = (raw.messages as any)?.nextPage;
      lastMessageId = (raw.messages as any)?.lastMessageId;
      if (!nextPage || !lastMessageId || msgs.length === 0) break;
    }

    const realMsgs = all.filter(msg => isRealMessage(msg));
    if (sinceMs === 0) return realMsgs;
    return realMsgs.filter(m => {
      const d = (m as { dateAdded?: string | number }).dateAdded;
      const ms = d ? (typeof d === 'string' ? Date.parse(d) : Number(d)) : 0;
      return ms === 0 || ms >= sinceMs;
    });
  }

  async sendMessage(data: { conversationId: string; type: string; message: string; contactId: string }): Promise<GHLMessage> {
    const res = await this.request<{ message: GHLMessage }>(`/conversations/messages`, { method: 'POST', body: data });
    return res.message;
  }

  // ---- Calendars & Appointments ----

  async getCalendars(): Promise<GHLCalendar[]> {
    const res = await this.request<{ calendars: GHLCalendar[] }>('/calendars/', { params: { locationId: this.locationId } });
    return res.calendars || [];
  }

  async getAppointments(params?: { calendarId?: string; startTime?: string; endTime?: string; limit?: number }): Promise<{ events: GHLAppointment[] }> {
    const reqParams: Record<string, string> = { locationId: this.locationId };
    if (params?.calendarId) reqParams.calendarId = params.calendarId;
    if (params?.startTime) {
      const ms = isNaN(Number(params.startTime)) ? new Date(params.startTime).getTime() : Number(params.startTime);
      reqParams.startTime = String(ms);
    }
    if (params?.endTime) {
      const ms = isNaN(Number(params.endTime)) ? new Date(params.endTime).getTime() : Number(params.endTime);
      reqParams.endTime = String(ms);
    }
    if (params?.limit) reqParams.limit = String(params.limit);
    const result = await this.request<{ events: GHLAppointment[] }>('/calendars/events', { params: reqParams });
    return { events: result.events || [] };
  }

  async getAllAppointments(params?: { startTime?: string; endTime?: string }): Promise<GHLAppointment[]> {
    const calendars = await this.getCalendars();
    if (calendars.length === 0) {
      console.warn('[GHL] No calendars found for location — cannot fetch appointments.');
      return [];
    }
    const all: GHLAppointment[] = [];
    for (const calendar of calendars) {
      try {
        const result = await this.getAppointments({ calendarId: calendar.id, startTime: params?.startTime, endTime: params?.endTime });
        all.push(...(result.events || []));
      } catch (err) {
        console.error(`[GHL] Failed to fetch appointments for calendar ${calendar.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return all;
  }

  // ---- Custom Fields ----

  async getCustomFields(): Promise<GHLCustomField[]> {
    const res = await this.request<{ customFields: GHLCustomField[] }>(`/locations/${this.locationId}/customFields`);
    return res.customFields || [];
  }

  // ---- Custom Values ----

  async getCustomValues(): Promise<GHLCustomValue[]> {
    const res = await this.request<{ customValues: GHLCustomValue[] }>(`/locations/${this.locationId}/customValues`);
    return res.customValues || [];
  }

  // ---- Tags ----

  async getTags(): Promise<GHLTag[]> {
    const res = await this.request<{ tags: GHLTag[] }>(`/locations/${this.locationId}/tags`);
    return res.tags || [];
  }

  // ---- Links ----

  async getLinks(): Promise<GHLLink[]> {
    const res = await this.request<{ links: GHLLink[] }>('/links/', { params: { locationId: this.locationId } });
    return res.links || [];
  }

  // ---- Email Templates ----

  async getEmailTemplate(templateId: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(`/emails/builder/${templateId}`);
  }

  async getEmailTemplates(params?: { limit?: number; offset?: number }): Promise<{ templates: Record<string, unknown>[]; total?: number }> {
    const reqParams: Record<string, string> = { locationId: this.locationId };
    if (params?.limit) reqParams.limit = String(params.limit);
    if (params?.offset) reqParams.offset = String(params.offset);
    const res = await this.request<{ templates: Record<string, unknown>[]; total?: number }>('/emails/builder', { params: reqParams });
    return { templates: res.templates || [], total: res.total };
  }

  getLocationId(): string { return this.locationId; }
}
