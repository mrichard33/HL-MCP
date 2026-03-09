// GoHighLevel API types

export interface GHLContact {
  id: string;
  locationId?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  companyName?: string;
  tags?: string[];
  source?: string;
  customFields?: Record<string, unknown>[];
  dateAdded?: string;
  dateUpdated?: string;
}

export interface GHLPipeline {
  id: string;
  locationId?: string;
  name: string;
  stages: GHLPipelineStage[];
}

export interface GHLPipelineStage {
  id: string;
  name: string;
  position: number;
}

export interface GHLOpportunity {
  id: string;
  pipelineId: string;
  pipelineStageId?: string;
  contactId?: string;
  locationId?: string;
  name: string;
  status: string;
  monetaryValue?: number;
  currency?: string;
  source?: string;
  assignedTo?: string;
  customFields?: Record<string, unknown>[];
  dateAdded?: string;
  dateUpdated?: string;
}

export interface GHLWorkflow {
  id: string;
  locationId?: string;
  name: string;
  status: string;
  version?: number;
}

export interface GHLConversation {
  id: string;
  contactId: string;
  locationId?: string;
  type?: string;
  lastMessageDate?: string;
  unreadCount?: number;
}

export interface GHLMessage {
  id: string;
  conversationId: string;
  contactId?: string;
  direction: 'inbound' | 'outbound';
  type?: string;
  body?: string;
  status?: string;
  dateAdded?: string;
}

export interface GHLApiResponse<T> {
  [key: string]: T[] | T | number | string | undefined;
}

export interface GHLPaginatedResponse<T> {
  data: T[];
  meta?: {
    total?: number;
    currentPage?: number;
    nextPage?: number;
    prevPage?: number;
  };
}
