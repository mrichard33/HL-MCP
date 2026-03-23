/**
 * Railway GraphQL API wrapper for the HL MCP service.
 * Endpoint: https://backboard.railway.app/graphql/v2
 */

const RAILWAY_API = 'https://backboard.railway.app/graphql/v2';

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

async function gql(query: string, variables: Record<string, unknown> = {}): Promise<unknown> {
  const res = await fetch(RAILWAY_API, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Railway API ${res.status}: ${text}`);
  }
  const json = (await res.json()) as { data?: unknown; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(`Railway GraphQL error: ${json.errors.map((e) => e.message).join(', ')}`);
  }
  return json.data;
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
  )) as Record<string, unknown>;
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
  )) as { deployments: { edges: Array<{ node: { id: string; status: string } }> } };

  const latestDeploy = depData.deployments.edges[0]?.node;
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
  )) as { deploymentLogs: Array<{ message: string; timestamp: string; severity: string }> };

  let logs = logData.deploymentLogs || [];
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
  )) as { variables: Record<string, string> };

  // Return names and value lengths only — NEVER actual values
  const vars = Object.entries(data.variables || {}).map(([name, value]) => ({
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
  )) as { deployments: { edges: Array<{ node: { id: string } }> } };

  const latestId = depData.deployments.edges[0]?.node?.id;
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
