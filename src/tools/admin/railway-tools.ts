import { z } from 'zod';
import {
  getServiceStatus,
  getDeploymentLogs,
  getEnvVars,
  setEnvVar,
  triggerRedeploy,
  rollbackDeployment,
} from '../../admin/railway-client.js';

export const railwayTools = {
  get_railway_service_status: {
    description:
      'Get the HL MCP Railway service status including name, last update time, and the last 5 deployments with their status and timestamps.',
    inputSchema: z.object({}),
    handler: async (_args: Record<string, never>) => {
      return await getServiceStatus();
    },
  },

  get_railway_logs: {
    description:
      'Get deploy logs from the latest HL MCP Railway deployment. Optionally filter by keyword (e.g. "error", "[Sync]"). Returns up to 500 lines.',
    inputSchema: z.object({
      filter: z.string().optional().describe('Keyword to filter log lines (case-insensitive)'),
      limit: z.number().optional().default(500).describe('Max log lines to return (default 500)'),
    }),
    handler: async (args: { filter?: string; limit?: number }) => {
      return await getDeploymentLogs(args.filter, args.limit);
    },
  },

  get_railway_env_vars: {
    description:
      'List all environment variable names configured on the HL MCP Railway service. Returns names and whether they are set — NEVER returns actual values.',
    inputSchema: z.object({}),
    handler: async (_args: Record<string, never>) => {
      return await getEnvVars();
    },
  },

  set_railway_env_var: {
    description:
      'Create or update an environment variable on the HL MCP Railway service. Requires confirm: true to execute — otherwise returns a preview. Triggers auto-redeploy.',
    inputSchema: z.object({
      name: z.string().describe('Environment variable name'),
      value: z.string().describe('Environment variable value'),
      confirm: z.boolean().optional().default(false).describe('Must be true to execute. False returns preview only.'),
    }),
    handler: async (args: { name: string; value: string; confirm?: boolean }) => {
      if (!args.confirm) {
        return {
          preview: true,
          action: 'set_env_var',
          variable: args.name,
          value_length: args.value.length,
          warning: 'Setting this variable will trigger an auto-redeploy. Pass confirm: true to execute.',
        };
      }
      return await setEnvVar(args.name, args.value);
    },
  },

  redeploy_railway_service: {
    description:
      'Trigger a redeployment of the HL MCP Railway service from the latest commit. Requires confirm: true to execute.',
    inputSchema: z.object({
      confirm: z.boolean().optional().default(false).describe('Must be true to execute. False returns preview only.'),
    }),
    handler: async (args: { confirm?: boolean }) => {
      if (!args.confirm) {
        return {
          preview: true,
          action: 'redeploy',
          message: 'This will trigger a full redeployment from the latest commit. Pass confirm: true to execute.',
        };
      }
      return await triggerRedeploy();
    },
  },

  rollback_railway_deployment: {
    description:
      'Rollback the HL MCP Railway service to a specific previous deployment. Requires confirm: true and a deployment ID (get IDs from get_railway_service_status).',
    inputSchema: z.object({
      deployment_id: z.string().describe('The deployment ID to rollback to'),
      confirm: z.boolean().optional().default(false).describe('Must be true to execute. False returns preview only.'),
    }),
    handler: async (args: { deployment_id: string; confirm?: boolean }) => {
      if (!args.confirm) {
        return {
          preview: true,
          action: 'rollback',
          target_deployment: args.deployment_id,
          message: 'This will rollback to the specified deployment. Pass confirm: true to execute.',
        };
      }
      return await rollbackDeployment(args.deployment_id);
    },
  },
};
