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
} from '../types/ghl.js';
import { isOAuthConfigured, getOAuthAccessToken } from './ghl-oauth.js';

const DEFAULT_BASE_URL = 'https://services.leadconnectorhq.com';
const BACKEND_BASE_URL = 'https://backend.leadconnectorhq.com';
const FIREBASE_TOKEN_URL = 'https://securetoken.googleapis.com/v1/token';

interface RequestOptions {
  method?: string;
  body?: unknown;
  params?: Record<string, string>;
}

// Firebase token cache
let cachedFirebaseToken: { idToken: string; expiresAt: number } | null = null;

export class GHLClient {
  private apiKey: string;
  private baseUrl: string;
  private locationId: string;
  private firebaseApiKey?: string;
  private firebaseRefreshToken?: string;

  constructor() {
    const apiKey = process.env.GHL_API_KEY;
    if (!apiKey) {
      throw new Error('Missing GHL_API_KEY environment variable');
    }
    this.apiKey = apiKey;
    this.baseUrl = process.env.GHL_BASE_URL || DEFAULT_BASE_URL;

    const locationId = process.env.GHL_LOCATION_ID;
    if (!locationId) {
      throw new Error('Missing GHL_LOCATION_ID environment variable — required for GHL API v2');
    }
    this.locationId = locationId;

    this.firebaseApiKey = process.env.GHL_FIREBASE_API_KEY;
    this.firebaseRefreshToken = process.env.GHL_FIREBASE_REFRESH_TOKEN;
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
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

    const response = await fetch(url.toString(), {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`GHL API error ${response.status}: ${errorBody}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Make a request using OAuth 2.0 tokens (for conversations/messages API).
   * Falls back to API key auth if OAuth is not configured.
   */
  private async requestWithOAuth<T>(path: string, options: RequestOptions = {}): Promise<T> {
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
      // Fallback to API key — may fail for endpoints that require OAuth
      authToken = this.apiKey;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      Version: '2021-07-28',
    };

    const response = await fetch(url.toString(), {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`GHL API error ${response.status}: ${errorBody}`);
    }

    return response.json() as Promise<T>;
  }

  /** Whether GHL OAuth is configured for conversation/message API access. */
  get isOAuthConfigured(): boolean {
    return isOAuthConfigured();
  }

  // ---- Firebase Auth for Internal API ----

  private get hasFirebaseAuth(): boolean {
    return !!(this.firebaseApiKey && this.firebaseRefreshToken);
  }

  /** Whether Firebase auth is configured for internal API access. */
  get isFirebaseAuthConfigured(): boolean {
    return this.hasFirebaseAuth;
  }

  private async getFirebaseToken(): Promise<string> {
    if (!this.firebaseApiKey || !this.firebaseRefreshToken) {
      throw new Error('Firebase auth not configured — set GHL_FIREBASE_API_KEY and GHL_FIREBASE_REFRESH_TOKEN');
    }

    // Return cached token if still valid (with 5-min buffer)
    if (cachedFirebaseToken && Date.now() < cachedFirebaseToken.expiresAt - 300_000) {
      return cachedFirebaseToken.idToken;
    }

    const url = `${FIREBASE_TOKEN_URL}?key=${this.firebaseApiKey}`;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.firebaseRefreshToken,
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Firebase token error ${response.status}: ${errorBody}`);
    }

    const data = await response.json() as FirebaseTokenResponse;
    const expiresInMs = parseInt(data.expires_in, 10) * 1000;

    cachedFirebaseToken = {
      idToken: data.id_token,
      expiresAt: Date.now() + expiresInMs,
    };

    return data.id_token;
  }

  // ---- Contacts ----

  async getContacts(params?: {
    limit?: number;
    query?: string;
    startAfter?: string;
    startAfterId?: string;
  }): Promise<{ contacts: GHLContact[]; meta?: GHLPaginationMeta }> {
    const reqParams: Record<string, string> = {
      locationId: this.locationId,
    };
    if (params?.limit) reqParams.limit = String(params.limit);
    if (params?.query) reqParams.query = params.query;
    if (params?.startAfter) reqParams.startAfter = params.startAfter;
    if (params?.startAfterId) reqParams.startAfterId = params.startAfterId;

    return this.request('/contacts/', { params: reqParams });
  }

  /** Fetch ALL contacts using cursor-based pagination. */
  async getAllContacts(): Promise<GHLContact[]> {
    const allContacts: GHLContact[] = [];
    let startAfter: string | undefined;
    let startAfterId: string | undefined;
    let pageCount = 0;
    const MAX_PAGES = 200; // Safety limit

    do {
      const result = await this.getContacts({
        limit: 100,
        startAfter,
        startAfterId,
      });

      allContacts.push(...(result.contacts || []));
      pageCount++;

      // Get next page cursors from meta
      startAfter = result.meta?.startAfter;
      startAfterId = result.meta?.startAfterId;

      // Break if no more pages or no results returned
      if (!result.contacts?.length || (!startAfter && !startAfterId)) {
        break;
      }
    } while (pageCount < MAX_PAGES);

    return allContacts;
  }

  async getContact(contactId: string): Promise<GHLContact> {
    const res = await this.request<{ contact: GHLContact }>(`/contacts/${contactId}`);
    return res.contact;
  }

  async createContact(data: Partial<GHLContact>): Promise<GHLContact> {
    const body = { ...data, locationId: data.locationId || this.locationId };
    const res = await this.request<{ contact: GHLContact }>('/contacts/', {
      method: 'POST',
      body,
    });
    return res.contact;
  }

  async updateContact(contactId: string, data: Partial<GHLContact>): Promise<GHLContact> {
    const res = await this.request<{ contact: GHLContact }>(`/contacts/${contactId}`, {
      method: 'PUT',
      body: data,
    });
    return res.contact;
  }

  async deleteContact(contactId: string): Promise<void> {
    await this.request(`/contacts/${contactId}`, { method: 'DELETE' });
  }

  // ---- Pipelines ----

  async getPipelines(): Promise<GHLPipeline[]> {
    const params: Record<string, string> = {
      locationId: this.locationId,
    };
    const res = await this.request<{ pipelines: GHLPipeline[] }>('/opportunities/pipelines', {
      params,
    });
    return res.pipelines;
  }

  // ---- Opportunities ----

  async getOpportunities(params?: {
    pipelineId?: string;
    stageId?: string;
    status?: string;
    limit?: number;
    startAfter?: string;
    startAfterId?: string;
  }): Promise<{ opportunities: GHLOpportunity[]; meta?: GHLPaginationMeta }> {
    const reqParams: Record<string, string> = {
      location_id: this.locationId,
    };
    if (params?.pipelineId) reqParams.pipeline_id = params.pipelineId;
    if (params?.stageId) reqParams.stage_id = params.stageId;
    if (params?.status) reqParams.status = params.status;
    if (params?.limit) reqParams.limit = String(params.limit);
    if (params?.startAfter) reqParams.startAfter = params.startAfter;
    if (params?.startAfterId) reqParams.startAfterId = params.startAfterId;

    return this.request('/opportunities/search', { method: 'GET', params: reqParams });
  }

  /** Fetch ALL opportunities using cursor-based pagination. */
  async getAllOpportunities(): Promise<GHLOpportunity[]> {
    const all: GHLOpportunity[] = [];
    let startAfter: string | undefined;
    let startAfterId: string | undefined;
    let pageCount = 0;
    const MAX_PAGES = 200;

    do {
      const result = await this.getOpportunities({
        limit: 100,
        startAfter,
        startAfterId,
      });

      all.push(...(result.opportunities || []));
      pageCount++;

      startAfter = result.meta?.startAfter;
      startAfterId = result.meta?.startAfterId;

      if (!result.opportunities?.length || (!startAfter && !startAfterId)) {
        break;
      }
    } while (pageCount < MAX_PAGES);

    return all;
  }

  async getOpportunity(opportunityId: string): Promise<GHLOpportunity> {
    const res = await this.request<{ opportunity: GHLOpportunity }>(
      `/opportunities/${opportunityId}`
    );
    return res.opportunity;
  }

  async createOpportunity(data: Partial<GHLOpportunity>): Promise<GHLOpportunity> {
    const body = { ...data, locationId: data.locationId || this.locationId };
    const res = await this.request<{ opportunity: GHLOpportunity }>('/opportunities/', {
      method: 'POST',
      body,
    });
    return res.opportunity;
  }

  async updateOpportunity(
    opportunityId: string,
    data: Partial<GHLOpportunity>
  ): Promise<GHLOpportunity> {
    const res = await this.request<{ opportunity: GHLOpportunity }>(
      `/opportunities/${opportunityId}`,
      { method: 'PUT', body: data }
    );
    return res.opportunity;
  }

  // ---- Workflows ----

  async getWorkflows(): Promise<GHLWorkflow[]> {
    const params: Record<string, string> = {
      locationId: this.locationId,
    };
    const res = await this.request<{ workflows: GHLWorkflow[] }>('/workflows/', { params });
    return res.workflows;
  }

  async getWorkflow(workflowId: string): Promise<GHLWorkflow> {
    const res = await this.request<{ workflow: GHLWorkflow }>(`/workflows/${workflowId}`);
    return res.workflow;
  }

  /**
   * Fetch full workflow detail from the internal GHL backend API.
   * Returns the complete node/step/action graph, or null if Firebase auth
   * is not configured (callers should use summary data instead).
   */
  async getWorkflowDetail(workflowId: string): Promise<Record<string, unknown> | null> {
    if (!this.hasFirebaseAuth) {
      return null;
    }

    const idToken = await this.getFirebaseToken();
    const url = `${BACKEND_BASE_URL}/workflow/${this.locationId}/${workflowId}?includeScheduledPauseInfo=true`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        channel: 'APP',
        'token-id': idToken,
      },
    });

    if (!response.ok) {
      console.error(`[GHL] Internal API failed for workflow ${workflowId} (${response.status})`);
      return null;
    }

    return response.json() as Promise<Record<string, unknown>>;
  }

  /**
   * Fetch workflow triggers from the internal GHL backend API.
   * Returns the trigger configuration for a specific workflow.
   * Falls back to empty array if Firebase auth is not configured.
   */
  async getWorkflowTriggers(workflowId: string): Promise<Record<string, unknown>[]> {
    if (!this.hasFirebaseAuth) {
      return [];
    }

    try {
      const idToken = await this.getFirebaseToken();
      const url = `${BACKEND_BASE_URL}/workflow/${this.locationId}/trigger?workflowId=${workflowId}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          channel: 'APP',
          'token-id': idToken,
        },
      });

      if (!response.ok) {
        console.warn(`[GHL] Trigger API failed for workflow ${workflowId} (${response.status})`);
        return [];
      }

      const data = await response.json();

      // Response may be an array directly or wrapped in an object
      if (Array.isArray(data)) return data;
      if (data && typeof data === 'object') {
        // Check common wrapper keys
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

  async getConversations(params?: {
    contactId?: string;
    limit?: number;
    startAfter?: string;
    startAfterId?: string;
  }): Promise<{ conversations: GHLConversation[] }> {
    const reqParams: Record<string, string> = {
      locationId: this.locationId,
    };
    if (params?.contactId) reqParams.contactId = params.contactId;
    if (params?.limit) reqParams.limit = String(params.limit);
    if (params?.startAfter) reqParams.startAfter = params.startAfter;
    if (params?.startAfterId) reqParams.startAfterId = params.startAfterId;

    return this.requestWithOAuth('/conversations/search', { method: 'GET', params: reqParams });
  }

  /** Fetch ALL conversations for a given contact using pagination. */
  async getAllConversations(contactId: string): Promise<GHLConversation[]> {
    const all: GHLConversation[] = [];
    let startAfter: string | undefined;
    let startAfterId: string | undefined;
    let pageCount = 0;
    const MAX_PAGES = 100;

    do {
      const result: { conversations: GHLConversation[]; meta?: GHLPaginationMeta } =
        await this.requestWithOAuth('/conversations/search', {
          method: 'GET',
          params: {
            locationId: this.locationId,
            contactId,
            limit: '100',
            ...(startAfter ? { startAfter } : {}),
            ...(startAfterId ? { startAfterId } : {}),
          },
        });

      all.push(...(result.conversations || []));
      pageCount++;

      startAfter = result.meta?.startAfter;
      startAfterId = result.meta?.startAfterId;

      if (!result.conversations?.length || (!startAfter && !startAfterId)) {
        break;
      }
    } while (pageCount < MAX_PAGES);

    return all;
  }

  async getConversation(conversationId: string): Promise<GHLConversation> {
    const res = await this.requestWithOAuth<{ conversation: GHLConversation }>(
      `/conversations/${conversationId}`
    );
    return res.conversation;
  }

  // ---- Messages ----

  async getMessages(conversationId: string): Promise<{ messages: GHLMessage[] }> {
    return this.requestWithOAuth(`/conversations/${conversationId}/messages`);
  }

  async sendMessage(data: {
    conversationId: string;
    type: string;
    message: string;
    contactId: string;
  }): Promise<GHLMessage> {
    const res = await this.requestWithOAuth<{ message: GHLMessage }>(
      `/conversations/messages`,
      { method: 'POST', body: data }
    );
    return res.message;
  }

  // ---- Calendars & Appointments ----

  async getCalendars(): Promise<GHLCalendar[]> {
    const params: Record<string, string> = {
      locationId: this.locationId,
    };
    const res = await this.request<{ calendars: GHLCalendar[] }>('/calendars/', { params });
    return res.calendars;
  }

  async getAppointments(params?: {
    calendarId?: string;
    startTime?: string;
    endTime?: string;
    limit?: number;
  }): Promise<{ events: GHLAppointment[] }> {
    const reqParams: Record<string, string> = {
      locationId: this.locationId,
    };
    if (params?.calendarId) reqParams.calendarId = params.calendarId;
    if (params?.startTime) reqParams.startTime = params.startTime;
    if (params?.endTime) reqParams.endTime = params.endTime;
    if (params?.limit) reqParams.limit = String(params.limit);
    return this.request('/calendars/events', { params: reqParams });
  }

  /** Fetch ALL appointments across all calendars. */
  async getAllAppointments(params?: {
    startTime?: string;
    endTime?: string;
  }): Promise<GHLAppointment[]> {
    const calendars = await this.getCalendars();
    const all: GHLAppointment[] = [];

    for (const calendar of calendars) {
      try {
        const result = await this.getAppointments({
          calendarId: calendar.id,
          startTime: params?.startTime,
          endTime: params?.endTime,
        });
        all.push(...(result.events || []));
      } catch (err) {
        console.error(`[GHL] Failed to fetch appointments for calendar ${calendar.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return all;
  }

  /** Expose locationId for use by other modules. */
  getLocationId(): string {
    return this.locationId;
  }
}
