/**
 * n8n API client for HL MCP admin tools.
 * Uses n8n REST API v1 to manage workflows.
 */

const N8N_API_URL = process.env.N8N_API_URL || 'https://n8n-main-instance-production-981e.up.railway.app';
const N8N_API_KEY = process.env.N8N_API_KEY;

async function n8nFetch(path: string, options: RequestInit = {}): Promise<any> {
  if (!N8N_API_KEY) throw new Error('N8N_API_KEY not configured');

  const url = `${N8N_API_URL}/api/v1${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-N8N-API-KEY': N8N_API_KEY,
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`n8n API ${res.status}: ${text.substring(0, 500)}`);
  }

  return res.json();
}

export async function listWorkflows(active?: boolean, limit?: number): Promise<any> {
  let path = `/workflows?limit=${limit || 100}`;
  if (active !== undefined) path += `&active=${active}`;
  return n8nFetch(path);
}

export async function getWorkflow(id: string): Promise<any> {
  return n8nFetch(`/workflows/${id}`);
}

export async function createWorkflow(workflowJson: any): Promise<any> {
  return n8nFetch('/workflows', {
    method: 'POST',
    body: JSON.stringify(workflowJson),
  });
}

export async function updateWorkflow(id: string, workflowJson: any): Promise<any> {
  return n8nFetch(`/workflows/${id}`, {
    method: 'PUT',
    body: JSON.stringify(workflowJson),
  });
}

export async function activateWorkflow(id: string): Promise<any> {
  return n8nFetch(`/workflows/${id}/activate`, { method: 'POST' });
}

export async function deactivateWorkflow(id: string): Promise<any> {
  return n8nFetch(`/workflows/${id}/deactivate`, { method: 'POST' });
}

export async function deleteWorkflow(id: string): Promise<any> {
  return n8nFetch(`/workflows/${id}`, { method: 'DELETE' });
}

export async function getExecutions(workflowId?: string, limit?: number, status?: string): Promise<any> {
  let path = `/executions?limit=${limit || 20}`;
  if (workflowId) path += `&workflowId=${workflowId}`;
  if (status) path += `&status=${status}`;
  return n8nFetch(path);
}
