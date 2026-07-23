import { z } from 'zod';
import { GHLClient } from '../clients/ghl.js';
import { getSupabaseClient } from '../clients/supabase.js';
import { extractAndSyncWorkflows } from '../extractor/workflow-extractor.js';
import { nowET } from '../utils/timezone.js';
import {
  syncContacts,
  syncOpportunities,
  syncAppointments,
  syncPipelines,
  syncConversationsAndMessages,
} from '../extractor/entity-syncer.js';

// Guards sync_all_entities so a manual trigger can't stack background runs.
let hlSyncInProgress = false;

export const workflowTools = {
  list_workflows: {
    description: 'List all workflows. Queries Supabase by default. Set forceLive=true for live GHL API.',
    inputSchema: z.object({
      forceLive: z.boolean().optional().default(false).describe('Bypass Supabase and query GHL API directly'),
    }),
    handler: async (args: { forceLive?: boolean }) => {
      if (!args.forceLive) {
        const supabase = getSupabaseClient();
        const { data, error } = await supabase.from('workflows').select('*').is('deleted_at', null);
        if (error) throw new Error(`Supabase error: ${error.message}`);
        return { workflows: data, source: 'supabase' };
      }
      const ghl = new GHLClient();
      const workflows = await ghl.getWorkflows();
      return { workflows, source: 'ghl_api' };
    },
  },

  sync_workflows: {
    description: 'Full sync of workflows from GHL to Supabase with steps, triggers, actions, connections. Use batchSize to prevent API rate limiting.',
    inputSchema: z.object({
      batchSize: z.number().optional().default(0).describe('Number of workflows to process per batch (0 = all at once). Use 5-10 for large accounts to prevent API rate limiting.'),
    }),
    handler: async (args: { batchSize?: number }) => {
      const result = await extractAndSyncWorkflows({ batchSize: args.batchSize || 0 });
      return {
        workflows_synced: result.workflows_synced,
        workflows_total: result.workflows_total,
        steps_synced: result.steps_synced,
        triggers_synced: result.triggers_synced,
        actions_synced: result.actions_synced,
        connections_synced: result.connections_synced,
        snapshots_created: result.snapshots_created,
        errors: result.errors,
        failed_workflow_ids: result.failed_workflow_ids,
        status: result.errors.length === 0 ? 'completed' : 'completed_with_errors',
      };
    },
  },

  get_workflow_executions: {
    description: 'Query workflow execution history from Supabase for analytics.',
    inputSchema: z.object({
      workflowId: z.string().optional().describe('Filter by workflow ID'),
      status: z.enum(['running', 'completed', 'failed']).optional(),
      limit: z.number().optional().default(50),
      since: z.string().optional().describe('ISO date string — only executions after this date'),
    }),
    handler: async (args: { workflowId?: string; status?: string; limit?: number; since?: string }) => {
      const supabase = getSupabaseClient();
      let qb = supabase.from('workflow_executions').select('*').order('started_at', { ascending: false }).limit(args.limit || 50);
      if (args.workflowId) qb = qb.eq('ghl_workflow_id', args.workflowId);
      if (args.status) qb = qb.eq('status', args.status);
      if (args.since) qb = qb.gte('started_at', args.since);

      const { data, error } = await qb;
      if (error) throw new Error(`Supabase error: ${error.message}`);
      return { executions: data, count: data?.length || 0 };
    },
  },

  log_workflow_execution: {
    description: 'Log a workflow execution event to Supabase for tracking and analytics. Workflow executions are also automatically populated from webhook events.',
    inputSchema: z.object({
      workflowId: z.string().describe('GHL workflow ID'),
      contactId: z.string().optional(),
      status: z.enum(['running', 'completed', 'failed']).default('running'),
      stepsCompleted: z.number().optional().default(0),
      stepsTotal: z.number().optional().default(0),
      errorMessage: z.string().optional(),
      executionData: z.record(z.unknown()).optional(),
    }),
    handler: async (args: {
      workflowId: string; contactId?: string; status: string;
      stepsCompleted?: number; stepsTotal?: number; errorMessage?: string; executionData?: Record<string, unknown>;
    }) => {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase.from('workflow_executions').insert({
        ghl_workflow_id: args.workflowId,
        ghl_contact_id: args.contactId,
        status: args.status,
        steps_completed: args.stepsCompleted || 0,
        steps_total: args.stepsTotal || 0,
        error_message: args.errorMessage,
        execution_data: args.executionData || {},
        completed_at: args.status !== 'running' ? nowET() : null,
      }).select().single();

      if (error) throw new Error(`Supabase error: ${error.message}`);
      return data;
    },
  },

  workflow_analytics: {
    description: 'Get workflow analytics: success/failure rates, average completion, and trends.',
    inputSchema: z.object({
      workflowId: z.string().optional().describe('Filter by specific workflow'),
      days: z.number().optional().default(30).describe('Look-back period in days'),
    }),
    handler: async (args: { workflowId?: string; days?: number }) => {
      const supabase = getSupabaseClient();
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - (args.days || 30));

      let qb = supabase.from('workflow_executions').select('*').gte('started_at', sinceDate.toISOString());
      if (args.workflowId) qb = qb.eq('ghl_workflow_id', args.workflowId);

      const { data, error } = await qb;
      if (error) throw new Error(`Supabase error: ${error.message}`);

      const executions = data || [];
      const total = executions.length;
      const completed = executions.filter((e) => e.status === 'completed').length;
      const failed = executions.filter((e) => e.status === 'failed').length;
      const running = executions.filter((e) => e.status === 'running').length;

      const completedWithTime = executions.filter((e) => e.status === 'completed' && e.completed_at && e.started_at);
      const avgDurationMs = completedWithTime.length > 0
        ? completedWithTime.reduce((sum, e) => {
            return sum + (new Date(e.completed_at).getTime() - new Date(e.started_at).getTime());
          }, 0) / completedWithTime.length
        : 0;

      return {
        period_days: args.days || 30,
        total_executions: total,
        completed,
        failed,
        running,
        success_rate: total > 0 ? ((completed / total) * 100).toFixed(1) + '%' : 'N/A',
        failure_rate: total > 0 ? ((failed / total) * 100).toFixed(1) + '%' : 'N/A',
        avg_duration_seconds: avgDurationMs > 0 ? (avgDurationMs / 1000).toFixed(1) : 'N/A',
      };
    },
  },

  inspect_workflow_raw_json: {
    description: 'Inspect raw JSON of a workflow. Reads from Supabase cache by default. Set useCache=false to fetch live from GHL API.',
    inputSchema: z.object({
      workflowId: z.string().describe('GHL workflow ID'),
      useCache: z.boolean().optional().default(true).describe('If true (default), read from Supabase cache. If false, fetch live data from HighLevel API and optionally update cache.'),
      updateCache: z.boolean().optional().default(true).describe('When useCache=false, whether to update the Supabase cache with the live data (default: true).'),
    }),
    handler: async (args: { workflowId: string; useCache?: boolean; updateCache?: boolean }) => {
      const useCache = args.useCache !== false;
      const updateCache = args.updateCache !== false;

      let raw: Record<string, unknown>;
      let source: string;
      let name: string | undefined;
      let triggerType: string | null = null;
      let triggerConfig: unknown = null;
      let actions: unknown = null;

      if (useCache) {
        const supabase = getSupabaseClient();
        const { data, error } = await supabase
          .from('workflows')
          .select('ghl_workflow_id, name, trigger_type, trigger_config, actions, raw_json')
          .eq('ghl_workflow_id', args.workflowId)
          .single();

        if (error) throw new Error(`Supabase error: ${error.message}`);
        if (!data) throw new Error(`Workflow ${args.workflowId} not found in cache. Try useCache=false to fetch live data.`);

        raw = (data.raw_json || {}) as Record<string, unknown>;
        source = 'supabase_cache';
        name = data.name;
        triggerType = data.trigger_type;
        triggerConfig = data.trigger_config;
        actions = data.actions;
      } else {
        const ghl = new GHLClient();
        const detail = await ghl.getWorkflowDetail(args.workflowId);
        if (detail) {
          raw = detail;
          source = 'highlevel_internal_api';
        } else {
          // FIX: GHL's public API has no `GET /workflows/{id}` — only the
          // location list endpoint. The old getWorkflow(id) fallback always
          // 404'd. Resolve via the location workflow list instead.
          const all = await ghl.getWorkflows();
          const match = all.find((w) => w.id === args.workflowId);
          if (!match) {
            throw new Error(
              `Workflow ${args.workflowId} not found in GHL location ${ghl.getLocationId()}. ` +
              `It may have been deleted or the ID may be wrong. (GHL's public API has no ` +
              `single-workflow endpoint; the location workflow list was searched.)`
            );
          }
          raw = JSON.parse(JSON.stringify(match));
          source = 'highlevel_public_api_list';
        }
        name = (raw.name as string) || undefined;
        triggerType = (raw.triggerType as string) || null;
        triggerConfig = raw.triggers || null;
        actions = raw.actions || null;

        if (updateCache) {
          const supabase = getSupabaseClient();
          await supabase.from('workflows').upsert({
            ghl_workflow_id: args.workflowId,
            name: name || 'Unknown',
            raw_json: raw,
            synced_at: nowET(),
            deleted_at: null,
          }, { onConflict: 'ghl_workflow_id' });
        }
      }

      return {
        workflow_id: args.workflowId,
        name,
        source,
        current_trigger_type: triggerType,
        current_trigger_config: triggerConfig,
        current_actions: actions,
        raw_json_top_level_keys: Object.keys(raw),
        raw_json_structure: Object.fromEntries(
          Object.entries(raw).map(([k, v]) => [
            k,
            Array.isArray(v)
              ? `Array[${v.length}]${v.length > 0 ? ` of ${typeof v[0]}` : ''}`
              : typeof v,
          ])
        ),
        raw_json: raw,
      };
    },
  },

  refresh_workflow: {
    description: 'Refresh a single workflow from the GHL API and update the Supabase cache. Faster than a full sync.',
    inputSchema: z.object({
      workflowId: z.string().describe('GHL workflow ID to refresh'),
    }),
    handler: async (args: { workflowId: string }) => {
      const ghl = new GHLClient();
      const supabase = getSupabaseClient();

      // Deep workflow detail comes from the Firebase-authenticated internal
      // API (backend.leadconnectorhq.com). Returns null when Firebase auth
      // isn't configured or the internal call fails.
      const detail = await ghl.getWorkflowDetail(args.workflowId);

      let rawJson: Record<string, unknown>;
      let source: string;

      if (detail) {
        rawJson = detail;
        source = 'highlevel_internal_api';
      } else {
        // FIX: GHL's public API v2 has NO `GET /workflows/{id}` endpoint —
        // only the location list endpoint `GET /workflows/?locationId=...`.
        // The previous fallback called ghl.getWorkflow(id), which hit
        // /workflows/{id} and always 404'd. Resolve via the list instead.
        const all = await ghl.getWorkflows();
        const match = all.find((w) => w.id === args.workflowId);
        if (!match) {
          throw new Error(
            `Workflow ${args.workflowId} not found in GHL location ${ghl.getLocationId()}. ` +
            `It may have been deleted or the ID may be wrong. ` +
            `(GHL's public API has no single-workflow endpoint, so the location workflow ` +
            `list was searched. To capture deep detail — steps, triggers, actions — set ` +
            `GHL_FIREBASE_API_KEY and GHL_FIREBASE_REFRESH_TOKEN to enable the internal API.)`
          );
        }
        rawJson = JSON.parse(JSON.stringify(match)) as Record<string, unknown>;
        source = 'highlevel_public_api_list';
      }

      const name = (rawJson.name as string) || 'Unknown';
      const status = (rawJson.status as string) || 'unknown';
      const version = (rawJson.version as number) || 1;
      const locationId = (rawJson.locationId as string) || ghl.getLocationId();

      // Columns that are always safe to write from whichever source resolved.
      const row: Record<string, unknown> = {
        ghl_workflow_id: args.workflowId,
        ghl_location_id: locationId,
        name,
        status,
        version,
        synced_at: nowET(),
        deleted_at: null,
      };

      // raw_json handling: a shallow list-based refresh must never DOWNGRADE a
      // richer raw_json already cached (e.g. one captured by a prior internal-API
      // sync with steps/triggers/actions). The deep-detail path always writes;
      // the shallow path only writes raw_json when the cache has nothing richer.
      let preservedExistingRawJson = false;
      if (source === 'highlevel_internal_api') {
        row.raw_json = rawJson;
      } else {
        const { data: existing } = await supabase
          .from('workflows')
          .select('raw_json')
          .eq('ghl_workflow_id', args.workflowId)
          .maybeSingle();
        const existingRaw = (existing?.raw_json || {}) as Record<string, unknown>;
        if (Object.keys(existingRaw).length > Object.keys(rawJson).length) {
          preservedExistingRawJson = true;
        } else {
          row.raw_json = rawJson;
        }
      }

      const { error: upsertError } = await supabase
        .from('workflows')
        .upsert(row, { onConflict: 'ghl_workflow_id' });

      if (upsertError) {
        throw new Error(`Failed to update cache: ${upsertError.message}`);
      }

      return {
        workflow_id: args.workflowId,
        name,
        status,
        version,
        source,
        cache_updated: true,
        preserved_existing_raw_json: preservedExistingRawJson,
        refreshed_at: nowET(),
        raw_json_top_level_keys: Object.keys(rawJson),
      };
    },
  },

  sync_all_entities: {
    description: 'Full sync of all entities (contacts, opportunities, appointments, pipelines, conversations, messages) from GHL to Supabase.',
    inputSchema: z.object({}),
    handler: async () => {
      if (hlSyncInProgress) {
        return {
          ok: true,
          status: 'already_running',
          message: 'A sync is already in progress.',
        };
      }
      hlSyncInProgress = true;

      // Run the full multi-entity sync in the background. Awaiting it inline can
      // exceed the MCP client's request timeout (the dashboard saw MCP error
      // -32001), so we return immediately and let callers poll get_sync_health.
      void (async () => {
        const results: Record<string, unknown> = {};
        try {
          try {
            const contactResult = await syncContacts();
            results.contacts = { synced: contactResult.synced, errors: contactResult.errors.length };
          } catch (err) {
            results.contacts = { error: err instanceof Error ? err.message : String(err) };
          }

          try {
            const oppResult = await syncOpportunities();
            results.opportunities = { synced: oppResult.synced, errors: oppResult.errors.length };
          } catch (err) {
            results.opportunities = { error: err instanceof Error ? err.message : String(err) };
          }

          try {
            const aptResult = await syncAppointments();
            results.appointments = { synced: aptResult.synced, errors: aptResult.errors.length };
          } catch (err) {
            results.appointments = { error: err instanceof Error ? err.message : String(err) };
          }

          try {
            const pipResult = await syncPipelines();
            results.pipelines = { synced: pipResult.synced, errors: pipResult.errors.length };
          } catch (err) {
            results.pipelines = { error: err instanceof Error ? err.message : String(err) };
          }

          try {
            const convResult = await syncConversationsAndMessages();
            results.conversations = {
              synced_conversations: convResult.synced_conversations,
              synced_messages: convResult.synced_messages,
              errors: convResult.errors.length,
            };
          } catch (err) {
            results.conversations = { error: err instanceof Error ? err.message : String(err) };
          }

          console.log('[sync_all_entities] completed:', JSON.stringify(results));
        } catch (err) {
          console.error('[sync_all_entities] background sync failed:', err);
        } finally {
          hlSyncInProgress = false;
        }
      })();

      return {
        ok: true,
        status: 'started',
        message: 'Sync started. Poll get_sync_health for progress.',
      };
    },
  },

  get_email_template: {
    description: 'Fetch email template content by ID. Returns HTML body, subject, preview text, sender info.',
    inputSchema: z.object({
      templateId: z.string().describe('The email template ID (found in workflow step template_id fields)'),
    }),
    handler: async (args: { templateId: string }) => {
      const ghl = new GHLClient();
      const template = await ghl.getEmailTemplate(args.templateId);

      return {
        template_id: args.templateId,
        name: template.name || template.templateName || null,
        subject: template.subject || null,
        preview_text: template.previewText || template.preview_text || null,
        from_name: template.fromName || template.from_name || null,
        from_email: template.fromEmail || template.from_email || null,
        html_body: template.html || template.body || template.htmlBody || null,
        created_at: template.createdAt || template.created_at || null,
        updated_at: template.updatedAt || template.updated_at || null,
        raw: template,
      };
    },
  },

  list_email_templates: {
    description: 'List all email templates. Returns template IDs, names, subjects, and timestamps.',
    inputSchema: z.object({
      limit: z.number().optional().default(50).describe('Maximum number of templates to return (default: 50)'),
      offset: z.number().optional().default(0).describe('Offset for pagination (default: 0)'),
    }),
    handler: async (args: { limit?: number; offset?: number }) => {
      const ghl = new GHLClient();
      const result = await ghl.getEmailTemplates({
        limit: args.limit || 50,
        offset: args.offset || 0,
      });

      const templates = result.templates.map((t: Record<string, unknown>) => ({
        template_id: t.id || t._id,
        name: t.name || t.templateName || null,
        subject: t.subject || null,
        updated_at: t.updatedAt || t.updated_at || null,
      }));

      return {
        templates,
        count: templates.length,
        total: result.total || templates.length,
      };
    },
  },

  add_to_workflow: {
    description: 'Enroll a contact in a GHL workflow. The contact will enter the workflow at the beginning.',
    inputSchema: z.object({
      workflowId: z.string().describe('GHL workflow ID to enroll the contact in'),
      contactId: z.string().describe('GHL contact ID to enroll'),
      eventStartTime: z.string().optional().describe('Optional ISO datetime for scheduled enrollment'),
    }),
    handler: async (args: { workflowId: string; contactId: string; eventStartTime?: string }) => {
      const ghl = new GHLClient();
      try {
        const result = await ghl.enrollContactInWorkflow(args.workflowId, args.contactId, args.eventStartTime);
        return { success: true, workflowId: args.workflowId, contactId: args.contactId, result };
      } catch (err) {
        // Surface the real GHL status + body. Thrown errors are replaced by a
        // generic message at the MCP transport, so return the detail instead.
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          workflowId: args.workflowId,
          contactId: args.contactId,
          error: message,
        };
      }
    },
  },

  remove_from_workflow: {
    description: 'Remove a contact from a GHL workflow (unenroll). Stops any active execution of that workflow for the contact.',
    inputSchema: z.object({
      workflowId: z.string().describe('GHL workflow ID to remove the contact from'),
      contactId: z.string().describe('GHL contact ID to remove'),
      eventStartTime: z.string().optional().describe('Optional — required if the workflow has scheduled events'),
    }),
    handler: async (args: { workflowId: string; contactId: string; eventStartTime?: string }) => {
      const ghl = new GHLClient();
      try {
        const result = await ghl.removeContactFromWorkflow(args.workflowId, args.contactId, args.eventStartTime);
        return { success: true, workflowId: args.workflowId, contactId: args.contactId, result };
      } catch (err) {
        // Surface the real GHL status + body. Thrown errors are replaced by a
        // generic message at the MCP transport, so return the detail instead.
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          workflowId: args.workflowId,
          contactId: args.contactId,
          error: message,
          hint: message.includes('422') || message.includes('400')
            ? 'GHL rejected the request. If the workflow has scheduled events, pass eventStartTime.'
            : undefined,
        };
      }
    },
  },
};
