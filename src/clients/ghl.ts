import type {
  GHLContact,
  GHLPipeline,
  GHLOpportunity,
  GHLWorkflow,
  GHLConversation,
  GHLMessage,
} from '../types/ghl.js';

const DEFAULT_BASE_URL = 'https://services.leadconnectorhq.com';

interface RequestOptions {
  method?: string;
  body?: unknown;
  params?: Record<string, string>;
}

export class GHLClient {
  private apiKey: string;
  private baseUrl: string;
  private locationId?: string;

  constructor() {
    const apiKey = process.env.GHL_API_KEY;
    if (!apiKey) {
      throw new Error('Missing GHL_API_KEY environment variable');
    }
    this.apiKey = apiKey;
    this.baseUrl = process.env.GHL_BASE_URL || DEFAULT_BASE_URL;
    this.locationId = process.env.GHL_LOCATION_ID;
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

  // ---- Contacts ----

  async getContacts(params?: {
    limit?: number;
    offset?: number;
    query?: string;
  }): Promise<{ contacts: GHLContact[]; total: number }> {
    const reqParams: Record<string, string> = {};
    if (this.locationId) reqParams.locationId = this.locationId;
    if (params?.limit) reqParams.limit = String(params.limit);
    if (params?.offset) reqParams.startAfterId = String(params.offset);
    if (params?.query) reqParams.query = params.query;

    const res = await this.request<{ contacts: GHLContact[]; total: number }>(
      '/contacts/',
      { params: reqParams }
    );
    return res;
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
    const params: Record<string, string> = {};
    if (this.locationId) params.locationId = this.locationId;
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
    offset?: number;
  }): Promise<{ opportunities: GHLOpportunity[]; total: number }> {
    const reqParams: Record<string, string> = {};
    if (this.locationId) reqParams.locationId = this.locationId;
    if (params?.pipelineId) reqParams.pipelineId = params.pipelineId;
    if (params?.stageId) reqParams.stageId = params.stageId;
    if (params?.status) reqParams.status = params.status;
    if (params?.limit) reqParams.limit = String(params.limit);
    if (params?.offset) reqParams.startAfterId = String(params.offset);

    return this.request('/opportunities/search', { method: 'GET', params: reqParams });
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
    const params: Record<string, string> = {};
    if (this.locationId) params.locationId = this.locationId;
    const res = await this.request<{ workflows: GHLWorkflow[] }>('/workflows/', { params });
    return res.workflows;
  }

  // ---- Conversations ----

  async getConversations(params?: {
    contactId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ conversations: GHLConversation[] }> {
    const reqParams: Record<string, string> = {};
    if (this.locationId) reqParams.locationId = this.locationId;
    if (params?.contactId) reqParams.contactId = params.contactId;
    if (params?.limit) reqParams.limit = String(params.limit);

    return this.request('/conversations/search', { method: 'GET', params: reqParams });
  }

  async getConversation(conversationId: string): Promise<GHLConversation> {
    const res = await this.request<{ conversation: GHLConversation }>(
      `/conversations/${conversationId}`
    );
    return res.conversation;
  }

  // ---- Messages ----

  async getMessages(conversationId: string): Promise<{ messages: GHLMessage[] }> {
    return this.request(`/conversations/${conversationId}/messages`);
  }

  async sendMessage(data: {
    conversationId: string;
    type: string;
    message: string;
    contactId: string;
  }): Promise<GHLMessage> {
    const res = await this.request<{ message: GHLMessage }>(
      `/conversations/messages`,
      { method: 'POST', body: data }
    );
    return res.message;
  }
}
