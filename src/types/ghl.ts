// GoHighLevel API types

export interface GHLContact {
  id: string;
  locationId?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  companyName?: string;
  address1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
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
  createdAt?: string;
  updatedAt?: string;
}

export interface GHLWorkflowStep {
  id: string;
  name?: string;
  type?: string;
  delay?: number;
  delayUnit?: string;
  templateId?: string;
  condition?: string;
  actions?: GHLWorkflowAction[];
  [key: string]: unknown;
}

export interface GHLWorkflowTrigger {
  id?: string;
  type?: string;
  name?: string;
  value?: string;
  filters?: Record<string, unknown>[];
  [key: string]: unknown;
}

export interface GHLWorkflowAction {
  id?: string;
  type?: string;
  name?: string;
  target?: string;
  [key: string]: unknown;
}

export interface GHLWorkflow {
  id: string;
  locationId?: string;
  name: string;
  status: string;
  version?: number;
  steps?: GHLWorkflowStep[];
  triggers?: GHLWorkflowTrigger[];
  actions?: GHLWorkflowAction[];
  [key: string]: unknown;
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
  direction: 'inbound' | 'outbound' | number;
  type?: string;
  body?: string;
  message?: string;
  text?: string;
  status?: string;
  dateAdded?: string;
}

export interface GHLCalendar {
  id: string;
  locationId?: string;
  name: string;
  description?: string;
  [key: string]: unknown;
}

export interface GHLAppointment {
  id: string;
  contactId?: string;
  calendarId?: string;
  locationId?: string;
  title?: string;
  status?: string;
  appointmentStatus?: string;   // GHL /calendars/events live status field
  appoinmentStatus?: string;    // GHL API typo variant — both appear in payloads
  startTime?: string;
  endTime?: string;
  assignedUserId?: string;
  dateAdded?: string;
  dateUpdated?: string;
  [key: string]: unknown;
}

/** Node in the GHL internal API workflow graph */
export interface GHLWorkflowNode {
  id: string;
  type: string;
  name?: string;
  data?: Record<string, unknown>;
  position?: { x: number; y: number };
  [key: string]: unknown;
}

/** Edge in the GHL internal API workflow graph */
export interface GHLWorkflowEdge {
  id?: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  label?: string;
  [key: string]: unknown;
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

/** Cursor-based pagination meta returned by GHL API v2 */
export interface GHLPaginationMeta {
  total?: number;
  startAfter?: string;
  startAfterId?: string;
  nextPage?: string;
  nextPageUrl?: string;
}

/** Firebase token exchange response */
export interface FirebaseTokenResponse {
  access_token: string;
  expires_in: string;
  token_type: string;
  refresh_token: string;
  id_token: string;
  user_id: string;
  project_id: string;
}

export interface GHLCustomField {
  id: string;
  name: string;
  fieldKey?: string;
  dataType?: string;
  placeholder?: string;
  position?: number;
  model?: string;
  locationId?: string;
  [key: string]: unknown;
}

export interface GHLCustomValue {
  id: string;
  name: string;
  fieldKey?: string;
  value?: string;
  locationId?: string;
  [key: string]: unknown;
}

export interface GHLTag {
  id: string;
  name: string;
  locationId?: string;
  [key: string]: unknown;
}

export interface GHLLink {
  id: string;
  name?: string;
  redirectTo?: string;
  url?: string;
  locationId?: string;
  [key: string]: unknown;
}

/**
 * Template from GET /locations/:locationId/templates
 * Covers email, SMS, and WhatsApp templates.
 */
export interface GHLTemplate {
  id: string;
  name: string;
  type: 'sms' | 'email' | 'whatsapp';
  body?: string;
  subject?: string;
  attachments?: unknown[];
  locationId?: string;
  dateAdded?: string;
  dateUpdated?: string;
  [key: string]: unknown;
}
