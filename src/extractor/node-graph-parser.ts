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
    // GHL stores workflow steps as "templates" in the internal API
    if (Array.isArray(wd.templates) && wd.templates.length > 0) {
      // Map templates to node-like objects: attributes → data for downstream parsing
      return wd.templates.map((t: unknown) => {
        const tmpl = t as Record<string, unknown>;
        return {
          ...tmpl,
          data: tmpl.attributes || tmpl.data || {},
        } as GHLWorkflowNode;
      });
    }
    // workflowData may itself contain a nested workflow/data key
    if (wd.workflow && typeof wd.workflow === 'object') {
      const inner = wd.workflow as Record<string, unknown>;
      if (Array.isArray(inner.nodes)) return inner.nodes;
    }
  }

  // Check under graph key
  if (rawJson.graph && typeof rawJson.graph === 'object') {
    const g = rawJson.graph as Record<string, unknown>;
    if (Array.isArray(g.nodes)) return g.nodes;
  }

  // Check for direct steps array (some GHL versions use steps instead of nodes)
  if (Array.isArray(rawJson.steps) && rawJson.steps.length > 0 && (rawJson.steps[0] as Record<string, unknown>)?.id) {
    console.warn(`[NodeGraphParser] Found node-like data under "steps" (${rawJson.steps.length} items)`);
    return rawJson.steps as GHLWorkflowNode[];
  }

  // Search for any array of objects that look like nodes (have id and type)
  for (const [key, value] of Object.entries(rawJson)) {
    if (Array.isArray(value) && value.length > 0 && value[0]?.id && value[0]?.type) {
      console.warn(`[NodeGraphParser] Found node-like array under key "${key}" with ${value.length} items`);
      return value;
    }
  }

  // Deep search: check ALL top-level object values for a nested nodes array
  for (const [key, value] of Object.entries(rawJson)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = value as Record<string, unknown>;
      if (Array.isArray(nested.nodes) && nested.nodes.length > 0) {
        console.warn(`[NodeGraphParser] Found nodes under "${key}.nodes" (${nested.nodes.length} items)`);
        return nested.nodes;
      }
      // Two levels deep
      for (const [subKey, subValue] of Object.entries(nested)) {
        if (subValue && typeof subValue === 'object' && !Array.isArray(subValue)) {
          const deep = subValue as Record<string, unknown>;
          if (Array.isArray(deep.nodes) && deep.nodes.length > 0) {
            console.warn(`[NodeGraphParser] Found nodes under "${key}.${subKey}.nodes" (${deep.nodes.length} items)`);
            return deep.nodes;
          }
        }
      }
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

  // Check under graph key
  if (rawJson.graph && typeof rawJson.graph === 'object') {
    const g = rawJson.graph as Record<string, unknown>;
    if (Array.isArray(g.edges)) return g.edges;
    if (Array.isArray(g.connections)) return g.connections as GHLWorkflowEdge[];
  }

  // Deep search: check ALL top-level object values for nested edges
  for (const [, value] of Object.entries(rawJson)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = value as Record<string, unknown>;
      if (Array.isArray(nested.edges) && nested.edges.length > 0) return nested.edges;
      if (Array.isArray(nested.connections) && nested.connections.length > 0) return nested.connections as GHLWorkflowEdge[];
      // Two levels deep
      for (const [, subValue] of Object.entries(nested)) {
        if (subValue && typeof subValue === 'object' && !Array.isArray(subValue)) {
          const deep = subValue as Record<string, unknown>;
          if (Array.isArray(deep.edges) && deep.edges.length > 0) return deep.edges;
        }
      }
    }
  }

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

      // Check top-level "next" field (GHL templates format: string or array)
      const nodeNext = (node as Record<string, unknown>).next;
      if (typeof nodeNext === 'string' && nodeNext) {
        result.connections.push({
          fromStep: node.id,
          toStep: nodeNext,
        });
      } else if (Array.isArray(nodeNext)) {
        // if_else branches: next is an array of target IDs
        const branches = (nodeData.branches || []) as Record<string, unknown>[];
        for (let i = 0; i < nodeNext.length; i++) {
          const branchId = nodeNext[i] as string;
          if (!branchId) continue;
          const branchName = branches[i] ? (branches[i].name as string) : undefined;
          const condition = branchName || (i >= branches.length ? 'Default' : undefined);
          result.connections.push({
            fromStep: node.id,
            toStep: branchId,
            condition,
          });
        }
      }

      // Check for next/target references in node data
      const nextId = (nodeData.nextStep || nodeData.nextNode || nodeData.target) as string;
      if (nextId) {
        result.connections.push({
          fromStep: node.id,
          toStep: nextId,
        });
      }
      // Check for branches in node data
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

      // Handle goto targets
      if (node.type === 'goto' && nodeData.targetNodeId) {
        result.connections.push({
          fromStep: node.id,
          toStep: nodeData.targetNodeId as string,
        });
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
