import { getSupabaseClient } from '../clients/supabase.js';

interface Connection {
  workflow_id: string;
  from_step: string;
  to_step: string;
  condition: string | null;
}

interface GraphNode {
  id: string;
  neighbors: string[];
}

/**
 * Builds an adjacency list for a workflow's step graph.
 */
export async function buildWorkflowGraph(workflowId: string): Promise<Map<string, GraphNode>> {
  const supabase = getSupabaseClient();
  const { data: connections, error } = await supabase
    .from('workflow_connections')
    .select('*')
    .eq('workflow_id', workflowId);

  if (error) throw new Error(`Failed to load connections: ${error.message}`);

  const graph = new Map<string, GraphNode>();

  for (const conn of (connections || []) as Connection[]) {
    if (!graph.has(conn.from_step)) {
      graph.set(conn.from_step, { id: conn.from_step, neighbors: [] });
    }
    if (!graph.has(conn.to_step)) {
      graph.set(conn.to_step, { id: conn.to_step, neighbors: [] });
    }
    graph.get(conn.from_step)!.neighbors.push(conn.to_step);
  }

  return graph;
}

/**
 * Detects cycles in a workflow graph using DFS.
 * Returns arrays of step IDs forming cycles.
 */
export async function detectCycles(workflowId: string): Promise<string[][]> {
  const graph = await buildWorkflowGraph(workflowId);
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  const path: string[] = [];

  function dfs(nodeId: string): void {
    visited.add(nodeId);
    recursionStack.add(nodeId);
    path.push(nodeId);

    const node = graph.get(nodeId);
    if (node) {
      for (const neighbor of node.neighbors) {
        if (!visited.has(neighbor)) {
          dfs(neighbor);
        } else if (recursionStack.has(neighbor)) {
          // Found a cycle — extract the cycle from path
          const cycleStart = path.indexOf(neighbor);
          if (cycleStart >= 0) {
            cycles.push([...path.slice(cycleStart), neighbor]);
          }
        }
      }
    }

    path.pop();
    recursionStack.delete(nodeId);
  }

  for (const nodeId of graph.keys()) {
    if (!visited.has(nodeId)) {
      dfs(nodeId);
    }
  }

  return cycles;
}

/**
 * Finds steps that are unreachable from the first step (trigger entry point).
 */
export async function findUnreachableSteps(workflowId: string): Promise<string[]> {
  const supabase = getSupabaseClient();
  const graph = await buildWorkflowGraph(workflowId);

  // Get all steps for this workflow
  const { data: steps } = await supabase
    .from('workflow_steps')
    .select('step_id')
    .eq('workflow_id', workflowId)
    .order('step_order', { ascending: true });

  if (!steps || steps.length === 0) return [];

  // BFS from the first step
  const firstStep = steps[0].step_id;
  const reachable = new Set<string>();
  const queue = [firstStep];
  reachable.add(firstStep);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const node = graph.get(current);
    if (node) {
      for (const neighbor of node.neighbors) {
        if (!reachable.has(neighbor)) {
          reachable.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
  }

  // Find steps not in reachable set
  return steps
    .map((s) => s.step_id)
    .filter((id) => !reachable.has(id));
}

/**
 * Finds terminal steps (no outgoing edges) that might indicate broken flows.
 * Returns steps that have no outgoing connections and are not the last step.
 */
export async function findBrokenFlows(workflowId: string): Promise<string[]> {
  const supabase = getSupabaseClient();
  const graph = await buildWorkflowGraph(workflowId);

  const { data: steps } = await supabase
    .from('workflow_steps')
    .select('step_id, step_order')
    .eq('workflow_id', workflowId)
    .order('step_order', { ascending: true });

  if (!steps || steps.length <= 1) return [];

  const lastStep = steps[steps.length - 1].step_id;
  const broken: string[] = [];

  for (const step of steps) {
    if (step.step_id === lastStep) continue;
    const node = graph.get(step.step_id);
    if (!node || node.neighbors.length === 0) {
      broken.push(step.step_id);
    }
  }

  return broken;
}
