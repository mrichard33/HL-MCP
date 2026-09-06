/**
 * Railway GraphQL API wrapper for the HL MCP service.
 * Endpoint: https://backboard.railway.app/graphql/v2
 */

const RAILWAY_API = 'https://backboard.railway.app/graphql/v2';

// Railway's API stalls intermittently. Without a timeout a stalled request
// hangs the MCP tool call forever and the caller sees a bare "Failed" with
// no error text. Bound it so a stall becomes a readable error instead.
const TIMEOUT_MS = Number(process.env.RAILWAY_API_TIMEOUT_MS) || 20000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RetryableError extends Error {
  retryable?: boolean;
}

function getHeaders(): Record<string, string> {
  const token = process.env.RAILWAY_API_TOKEN;
  if (!token) throw new Error('Missing RAILWAY_API_TOKEN environment variable');
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

function getProjectId(): string {
  const id = process.env.RAILWAY_PROJECT_ID;
  if (!id) throw new Error('Missing RAILWAY_PROJECT_ID environment variable');
  return id;
}

function getServiceId(): string {
  const id = process.env.RAILWAY_SERVICE_ID;
  if (!id) throw new Error('Missing RAILWAY_SERVICE_ID environment variable');
  return id;
}

function getEnvironmentId(): string {
  const id = process.env.RAILWAY_ENVIRONMENT_ID;
  if (!id) throw new Error('Missing RAILWAY_ENVIRONMENT_ID environment variable');
  return id;
}

async function attempt(query: string, variables: Record<string, unknown>): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(RAILWAY_API, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const name = (err as Error)?.name || '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      const e: RetryableError = new Error(
        `Railway API did not respond within ${TIMEOUT_MS}ms (backboard.railway.app may be degraded).`
      );
      e.retryable = true;
      throw e;
    }
    const e: RetryableError = new Error(
      `Railway API request failed: ${(err as Error)?.message || String(err)}`
    );
    e.retryable = true;
    throw e;
  }

  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 500);
    const e: RetryableError = new Error(`Railway API ${res.status}: ${text || res.statusText}`);
    e.retryable = res.status >= 500 || res.status === 429;
    throw e;
  }

  let json: { data?: unknown; errors?: Array<{ message: string }> };
  try {
    json = (await res.json()) as { data?: unknown; errors?: Array<{ message: string }> };
  } catch {
    throw new Error('Railway API returned a non-JSON response.');
  }

  if (json.errors?.length) {
    throw new Error(`Railway GraphQL error: ${json.errors.map((e) => e.message).join(', ')}`);
  }
  return json.data;
}

async function gql(query: string, variables: Record<string, unknown> = {}): Promise<unknown> {
  try {
    return await attempt(query, variables);
  } catch (err) {
    if (!(err as RetryableError)?.retryable) throw err;
    await sleep(1000);
    return await attempt(query, variables);
  }
}

export async function getServiceStatus(): Promise<unknown> {
  const data = (await gql(
    `query ($projectId: String!, $serviceId: String!, $environmentId: String!) {
      service(id: $serviceId) {
        name
        updatedAt
      }
      deployments(
        first: 5
        input: {
          projectId: $projectId
          serviceId: $serviceId
          environmentId: $environmentId
        }
      ) {
        edges {
          node {
            id
            status
            createdAt
            updatedAt
          }
        }
      }
    }`,
    {
      projectId: getProjectId(),
      serviceId: getServiceId(),
      environmentId: getEnvironmentId(),
    }
  )) as Record<string, unknown> | null;

  // Railway returns service: null for an unknown service, or one the token
  // cannot see. Say so explicitly rather than returning an empty shape.
  if (!data || !data.service) {
    return {
      error: 'service_not_found',
      service_id: getServiceId(),
      message:
        'Railway returned no service for this ID. Check RAILWAY_SERVICE_ID, or that RAILWAY_API_TOKEN is scoped to the project that owns it.',
    };
  }

  return data;
}

export async function getDeploymentLogs(filter?: string, limit = 500): Promise<unknown> {
  // First get latest deployment
  const depData = (await gql(
    `query ($projectId: String!, $serviceId: String!, $environmentId: String!) {
      deployments(
        first: 1
        input: {
          projectId: $projectId
          serviceId: $serviceId
          environmentId: $environmentId
        }
      ) {
        edges {
          node {
            id
            status
          }
        }
      }
    }`,
    {
      projectId: getProjectId(),
      serviceId: getServiceId(),
      environmentId: getEnvironmentId(),
    }
  )) as { deployments?: { edges?: Array<{ node: { id: string; status: string } }> } } | null;

  const latestDeploy = depData?.deployments?.edges?.[0]?.node;
  if (!latestDeploy) return { logs: [], message: 'No deployments found' };

  const logData = (await gql(
    `query ($deploymentId: String!, $limit: Int) {
      deploymentLogs(deploymentId: $deploymentId, limit: $limit) {
        message
        timestamp
        severity
      }
    }`,
    { deploymentId: latestDeploy.id, limit }
  )) as { deploymentLogs?: Array<{ message: string; timestamp: string; severity: string }> } | null;

  let logs = logData?.deploymentLogs || [];
  if (filter) {
    const lowerFilter = filter.toLowerCase();
    logs = logs.filter((l) => l.message.toLowerCase().includes(lowerFilter));
  }

  return { deploymentId: latestDeploy.id, status: latestDeploy.status, logs };
}

export async function getEnvVars(): Promise<unknown> {
  const data = (await gql(
    `query ($projectId: String!, $serviceId: String!, $environmentId: String!) {
      variables(
        projectId: $projectId
        serviceId: $serviceId
        environmentId: $environmentId
      )
    }`,
    {
      projectId: getProjectId(),
      serviceId: getServiceId(),
      environmentId: getEnvironmentId(),
    }
  )) as { variables?: Record<string, string> } | null;

  // Return names and value lengths only — NEVER actual values
  const vars = Object.entries(data?.variables || {}).map(([name, value]) => ({
    name,
    is_set: value !== null && value !== undefined && value !== '',
    value_length: value ? value.length : 0,
  }));

  return { variables: vars, count: vars.length };
}

export async function setEnvVar(name: string, value: string): Promise<unknown> {
  const data = await gql(
    `mutation ($projectId: String!, $serviceId: String!, $environmentId: String!, $name: String!, $value: String!) {
      variableUpsert(
        input: {
          projectId: $projectId
          serviceId: $serviceId
          environmentId: $environmentId
          name: $name
          value: $value
        }
      )
    }`,
    {
      projectId: getProjectId(),
      serviceId: getServiceId(),
      environmentId: getEnvironmentId(),
      name,
      value,
    }
  );
  return { success: true, variable: name, message: 'Variable set. Railway will auto-redeploy.', data };
}

export async function triggerRedeploy(): Promise<unknown> {
  // Get latest deployment to redeploy from
  const depData = (await gql(
    `query ($projectId: String!, $serviceId: String!, $environmentId: String!) {
      deployments(
        first: 1
        input: {
          projectId: $projectId
          serviceId: $serviceId
          environmentId: $environmentId
        }
      ) {
        edges {
          node {
            id
          }
        }
      }
    }`,
    {
      projectId: getProjectId(),
      serviceId: getServiceId(),
      environmentId: getEnvironmentId(),
    }
  )) as { deployments?: { edges?: Array<{ node: { id: string } }> } } | null;

  const latestId = depData?.deployments?.edges?.[0]?.node?.id;
  if (!latestId) throw new Error('No deployments found to redeploy from');

  const data = await gql(
    `mutation ($deploymentId: String!) {
      deploymentRedeploy(id: $deploymentId) {
        id
        status
        createdAt
      }
    }`,
    { deploymentId: latestId }
  );
  return { success: true, message: 'Redeployment triggered', data };
}

export async function rollbackDeployment(deploymentId: string): Promise<unknown> {
  const data = await gql(
    `mutation ($deploymentId: String!) {
      deploymentRollback(id: $deploymentId) {
        id
        status
        createdAt
      }
    }`,
    { deploymentId }
  );
  return { success: true, message: `Rolled back to deployment ${deploymentId}`, data };
}
