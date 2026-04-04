import { z } from 'zod';
import {
  listWorkflows,
  getWorkflow,
  createWorkflow,
  updateWorkflow,
  activateWorkflow,
  deactivateWorkflow,
  deleteWorkflow,
  getExecutions,
} from '../../admin/n8n-client.js';

export const n8nTools = {
  n8n_list_workflows: {
    description:
      'List all n8n workflows with their ID, name, active status, and node count. Optionally filter by active status.',
    inputSchema: z.object({
      active: z.boolean().optional().describe('Filter by active status (true/false). Omit for all.'),
      limit: z.number().optional().default(100).describe('Max workflows to return (default 100)'),
    }),
    handler: async (args: { active?: boolean; limit?: number }) => {
      const result = await listWorkflows(args.active, args.limit);
      const workflows = result.data || result;
      return {
        count: Array.isArray(workflows) ? workflows.length : 0,
        workflows: Array.isArray(workflows) ? workflows.map((w: any) => ({
          id: w.id,
          name: w.name,
          active: w.active,
          nodes: w.nodes?.length || 0,
          createdAt: w.createdAt,
          updatedAt: w.updatedAt,
        })) : workflows,
      };
    },
  },

  n8n_get_workflow: {
    description:
      'Get full details of an n8n workflow by ID, including all nodes, connections, and settings.',
    inputSchema: z.object({
      workflowId: z.string().describe('The n8n workflow ID'),
    }),
    handler: async (args: { workflowId: string }) => {
      return await getWorkflow(args.workflowId);
    },
  },

  n8n_create_workflow: {
    description:
      'Create a new n8n workflow from a JSON definition. Pass the full workflow object with name, nodes, connections, and settings.',
    inputSchema: z.object({
      workflow: z.string().describe('JSON string of the workflow definition (name, nodes, connections, settings)'),
      activate: z.boolean().optional().default(false).describe('Activate the workflow immediately after creation'),
    }),
    handler: async (args: { workflow: string; activate?: boolean }) => {
      const workflowJson = JSON.parse(args.workflow);
      const created = await createWorkflow(workflowJson);
      if (args.activate && created.id) {
        await activateWorkflow(created.id);
        return { ...created, activated: true };
      }
      return created;
    },
  },

  n8n_update_workflow: {
    description:
      'Update an existing n8n workflow. Pass the workflow ID and the full updated workflow JSON.',
    inputSchema: z.object({
      workflowId: z.string().describe('The n8n workflow ID to update'),
      workflow: z.string().describe('JSON string of the updated workflow definition'),
    }),
    handler: async (args: { workflowId: string; workflow: string }) => {
      const workflowJson = JSON.parse(args.workflow);
      return await updateWorkflow(args.workflowId, workflowJson);
    },
  },

  n8n_activate_workflow: {
    description: 'Activate an n8n workflow so it can receive triggers and execute.',
    inputSchema: z.object({
      workflowId: z.string().describe('The n8n workflow ID to activate'),
    }),
    handler: async (args: { workflowId: string }) => {
      return await activateWorkflow(args.workflowId);
    },
  },

  n8n_deactivate_workflow: {
    description: 'Deactivate an n8n workflow so it stops receiving triggers.',
    inputSchema: z.object({
      workflowId: z.string().describe('The n8n workflow ID to deactivate'),
    }),
    handler: async (args: { workflowId: string }) => {
      return await deactivateWorkflow(args.workflowId);
    },
  },

  n8n_delete_workflow: {
    description:
      'Delete an n8n workflow permanently. Requires confirm: true. Cannot be undone.',
    inputSchema: z.object({
      workflowId: z.string().describe('The n8n workflow ID to delete'),
      confirm: z.boolean().optional().default(false).describe('Must be true to execute. False returns preview only.'),
    }),
    handler: async (args: { workflowId: string; confirm?: boolean }) => {
      if (!args.confirm) {
        return {
          preview: true,
          action: 'delete_workflow',
          workflowId: args.workflowId,
          warning: 'This will permanently delete the workflow. Pass confirm: true to execute.',
        };
      }
      return await deleteWorkflow(args.workflowId);
    },
  },

  n8n_get_executions: {
    description:
      'Get recent workflow executions from n8n. Optionally filter by workflow ID or status (success, error, waiting).',
    inputSchema: z.object({
      workflowId: z.string().optional().describe('Filter by workflow ID'),
      limit: z.number().optional().default(20).describe('Max executions to return (default 20)'),
      status: z.string().optional().describe('Filter by status: success, error, waiting'),
    }),
    handler: async (args: { workflowId?: string; limit?: number; status?: string }) => {
      return await getExecutions(args.workflowId, args.limit, args.status);
    },
  },
};
