import type { GHLWorkflowNode, GHLWorkflowEdge, GHLWorkflowTrigger, GHLWorkflowAction, GHLWorkflowStep } from '../types/ghl.js';

export interface ParsedWorkflowGraph {
  triggers: GHLWorkflowTrigger[];
  actions: GHLWorkflowAction[];
  steps: GHLWorkflowStep[];
  connections: Array<{ fromStep: string; toStep: string; condition?: string }>;
}

// Known trigger node type patterns in GHL internal API
const TRIGGER_TYPE_PATTERNS = [
  'trigger', 'customTrigger', 'contactCreated', 'contactChanged',
  'contactDndUpdate', 'contactTagUpdate', 'tagAdded', 'tagRemoved',
  'formSubmitted', 'surveySubmitted', 'appointmentBooked',
  'appointmentStatusUpdate', 'pipelineStageChanged', 'opportunityStatusChanged',
  'opportunityCreated', 'opportunityStageChanged', 'inboundWebhook',
  'customerReplied', 'noteAdded', 'noteChanged', 'taskAdded',
  'invoicePaid', 'paymentReceived', 'orderSubmitted',
  'stale_opportunities', 'birthday_reminder', 'custom_date_reminder',
  'membershipSignup', 'membershipCancelled',
];

function isTriggerType(type: string): boolean {
  const lower = type.toLowerCase();
  return TRIGGER_TYPE_PATTERNS.some(p => lower.includes(p.toLowerCase()));
}

/**
 * Finds the nodes array from various possible locations in the raw JSON.
 */
function findNodes(rawJson: Record<string, unknown>): GHLWorkflowNode[] {
  // Direct nodes array
  if (Array.isArray(rawJson.nodes)) return rawJson.nodes;

  // Nested under workflow key
  if (rawJson.workflow && typeof rawJson.workflow === 'object') {
    const wf = rawJson.workflow as Record<string, unknown>;
    if (Array.isArray(wf.nodes)) return wf.nodes;
  }

  // Nested under data key
  if (rawJson.data && typeof rawJson.data === 'object') {
    const data = rawJson.data as Record<string, unknown>;
    if (Array.isArray(data.nodes)) return data.nodes;
  }

  // Nested under workflowData key (GHL internal backend API format)
  if (rawJson.workflowData && typeof rawJson.workflowData === 'object') {
    const wd = rawJson.workflowData as Record<string, unknown>;
    if (Array.isArray(wd.nodes)) return wd.nodes;
    // workflowData may itself contain a nested workflow/data key
    if (wd.workflow && typeof wd.workflow === 'object') {
      const inner = wd.workflow as Record<string, unknown>;
      if (Array.isArray(inner.nodes)) return inner.nodes;
    }
  }

  // Search for any array of objects that look like nodes (have id and type)
  for (const [key, value] of Object.entries(rawJson)) {
    if (Array.isArray(value) && value.length > 0 && value[0]?.id && value[0]?.type) {
      console.warn(`[NodeGraphParser] Found node-like array under key "${key}" with ${value.length} items`);
      return value;
    }
  }

  return [];
}

/**
 * Finds the edges array from various possible locations in the raw JSON.
 */
function findEdges(rawJson: Record<string, unknown>): GHLWorkflowEdge[] {
  // Direct edges array
  if (Array.isArray(rawJson.edges)) return rawJson.edges;

  // Nested under workflow key
  if (rawJson.workflow && typeof rawJson.workflow === 'object') {
    const wf = rawJson.workflow as Record<string, unknown>;
    if (Array.isArray(wf.edges)) return wf.edges;
  }

  // Nested under data key
  if (rawJson.data && typeof rawJson.data === 'object') {
    const data = rawJson.data as Record<string, unknown>;
    if (Array.isArray(data.edges)) return data.edges;
  }

  // Nested under workflowData key (GHL internal backend API format)
  if (rawJson.workflowData && typeof rawJson.workflowData === 'object') {
    const wd = rawJson.workflowData as Record<string, unknown>;
    if (Array.isArray(wd.edges)) return wd.edges;
    if (wd.workflow && typeof wd.workflow === 'object') {
      const inner = wd.workflow as Record<string, unknown>;
      if (Array.isArray(inner.edges)) return inner.edges;
    }
  }

  // Also check for "connections" as alternate key name
  if (Array.isArray(rawJson.connections)) return rawJson.connections;

  return [];
}

/**
 * Parses the GHL internal API node-graph response into structured workflow components.
 * Handles multiple possible JSON structures and logs diagnostic info when parsing fails.
 */
export function parseNodeGraph(rawJson: Record<string, unknown>): ParsedWorkflowGraph {
  const result: ParsedWorkflowGraph = {
    triggers: [],
    actions: [],
    steps: [],
    connections: [],
  };

  const nodes = findNodes(rawJson);
  const edges = findEdges(rawJson);

  if (nodes.length === 0) {
    const workflowName = (rawJson.name as string) || (rawJson._id as string) || 'unknown';
    if (process.env.DEBUG) {
      console.warn(`[NodeGraphParser] No nodes found for workflow "${workflowName}" — unexpected internal API response format`);
    }

    // Try to extract from legacy flat structure (public API format)
    if (Array.isArray(rawJson.triggers)) {
      result.triggers = rawJson.triggers as GHLWorkflowTrigger[];
    }
    if (Array.isArray(rawJson.actions)) {
      result.actions = rawJson.actions as GHLWorkflowAction[];
    }
    if (Array.isArray(rawJson.steps)) {
      result.steps = rawJson.steps as GHLWorkflowStep[];
    }

    return result;
  }

  // Debug-level: only useful during development
  if (process.env.DEBUG) {
    console.error(`[NodeGraphParser] Found ${nodes.length} nodes and ${edges.length} edges`);
  }

  // Build a set of trigger node IDs for ordering
  const triggerNodeIds = new Set<string>();
  let stepOrder = 0;

  // Classify nodes
  for (const node of nodes) {
    const nodeType = node.type || '';
    const nodeData = (node.data || {}) as Record<string, unknown>;
    const nodeName = (node.name || nodeData.name || nodeData.label || nodeType) as string;

    if (isTriggerType(nodeType)) {
      triggerNodeIds.add(node.id);

      const trigger: GHLWorkflowTrigger = {
        id: node.id,
        type: nodeType,
        name: nodeName,
        value: (nodeData.value || nodeData.triggerValue || nodeData.filterValue) as string || undefined,
        filters: Array.isArray(nodeData.filters) ? nodeData.filters : undefined,
      };
      // Preserve the full node as extra properties
      Object.assign(trigger, { raw: node });
      result.triggers.push(trigger);
    } else {
      stepOrder++;

      const step: GHLWorkflowStep = {
        id: node.id,
        type: nodeType,
        name: nodeName,
        delay: (nodeData.delay || nodeData.waitTime || nodeData.delayValue) as number || undefined,
        delayUnit: (nodeData.delayUnit || nodeData.waitUnit || nodeData.unit) as string || undefined,
        templateId: (nodeData.templateId || nodeData.template) as string || undefined,
        condition: (nodeData.condition || nodeData.branchCondition) as string || undefined,
        actions: Array.isArray(nodeData.actions) ? nodeData.actions : undefined,
      };
      // Preserve full node data
      Object.assign(step, { raw: node, stepOrder });
      result.steps.push(step);

      // Extract action metadata for the workflow_actions table
      const action: GHLWorkflowAction = {
        id: node.id,
        type: nodeType,
        name: nodeName,
        target: (nodeData.target || nodeData.to || nodeData.recipient) as string || undefined,
      };
      Object.assign(action, { raw: node });
      result.actions.push(action);
    }
  }

  // Build connections from edges
  for (const edge of edges) {
    result.connections.push({
      fromStep: edge.source,
      toStep: edge.target,
      condition: (edge.label || edge.sourceHandle) as string || undefined,
    });
  }

  // If no edges found, try to extract connections from node data
  if (edges.length === 0 && nodes.length > 1) {
    for (const node of nodes) {
      const nodeData = (node.data || {}) as Record<string, unknown>;
      // Check for next/target references in node data
      const nextId = (nodeData.nextStep || nodeData.nextNode || nodeData.target) as string;
      if (nextId) {
        result.connections.push({
          fromStep: node.id,
          toStep: nextId,
        });
      }
      // Check for branches
      if (Array.isArray(nodeData.branches)) {
        for (const branch of nodeData.branches) {
          const b = branch as Record<string, unknown>;
          if (b.nextStep || b.target) {
            result.connections.push({
              fromStep: node.id,
              toStep: (b.nextStep || b.target) as string,
              condition: (b.condition || b.label) as string || undefined,
            });
          }
        }
      }
    }
  }

  if (process.env.DEBUG) {
    console.error(
      `[NodeGraphParser] Parsed: ${result.triggers.length} triggers, ` +
      `${result.steps.length} steps, ${result.actions.length} actions, ` +
      `${result.connections.length} connections`
    );
  }

  return result;
}
