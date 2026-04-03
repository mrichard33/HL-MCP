import { z } from 'zod';
import supabase from '../supabase.js';

export function registerAgentTools(server) {

  // ───────────────────────────────────────────────────
  // Tool: emit_event
  // ───────────────────────────────────────────────────
  server.tool(
    'emit_event',
    'Write a system event to the event bus. Used by n8n webhooks, cron jobs, and Claude to log state changes across GHL, LP, and internal systems.',
    {
      event_type: z.string().describe('Event type (e.g. "contact.tag_added", "lp.disposition_changed", "appointment.booked")'),
      source: z.string().describe('Source system: "ghl", "lp", "n8n", "claude", "manual", "cron"'),
      entity_type: z.string().describe('Entity type: "contact", "opportunity", "lead", "workflow", "appointment"'),
      entity_id: z.string().describe('Primary ID of the entity in its source system'),
      event_subtype: z.string().optional().describe('Optional refinement (e.g. "objection:price", "appt:window-estimate")'),
      ghl_contact_id: z.string().optional().describe('GHL contact ID if known'),
      lp_lead_id: z.string().optional().describe('LP Lead ID if known'),
      lp_prospect_id: z.string().optional().describe('LP Prospect ID if known'),
      payload: z.string().optional().describe('JSON string of full event data from source'),
      previous_state: z.string().optional().describe('JSON string of state before the change'),
      new_state: z.string().optional().describe('JSON string of state after the change'),
      priority: z.string().optional().describe('Priority: "critical", "high", "normal", or "low" (default: normal)'),
      idempotency_key: z.string().optional().describe('Dedup key to prevent duplicate events'),
      event_timestamp: z.string().optional().describe('ISO timestamp of when event actually occurred'),
    },
    async (params) => {
      try {
        const { data, error } = await supabase
          .from('system_events')
          .insert({
            event_type: params.event_type,
            event_subtype: params.event_subtype || null,
            source: params.source,
            entity_type: params.entity_type,
            entity_id: params.entity_id,
            ghl_contact_id: params.ghl_contact_id || null,
            lp_lead_id: params.lp_lead_id || null,
            lp_prospect_id: params.lp_prospect_id || null,
            payload: params.payload ? JSON.parse(params.payload) : {},
            previous_state: params.previous_state ? JSON.parse(params.previous_state) : null,
            new_state: params.new_state ? JSON.parse(params.new_state) : null,
            priority: params.priority || 'normal',
            idempotency_key: params.idempotency_key || null,
            event_timestamp: params.event_timestamp || new Date().toISOString(),
          })
          .select('id, event_type, entity_id, priority, created_at')
          .single();

        if (error) {
          if (error.code === '23505' && params.idempotency_key) {
            return { content: [{ type: 'text', text: JSON.stringify({ status: 'duplicate', idempotency_key: params.idempotency_key }) }] };
          }
          return { content: [{ type: 'text', text: `Error creating event: ${error.message}` }] };
        }

        return { content: [{ type: 'text', text: JSON.stringify({ status: 'created', event_id: data.id, event_type: data.event_type, entity_id: data.entity_id, priority: data.priority, created_at: data.created_at }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Exception: ${err.message}` }] };
      }
    }
  );

  // ───────────────────────────────────────────────────
  // Tool: get_pending_events
  // ───────────────────────────────────────────────────
  server.tool(
    'get_pending_events',
    'Get unprocessed system events, ordered by priority then time. The decision engine entry point.',
    {
      limit: z.number().optional().describe('Max events to return (default 20)'),
      event_type: z.string().optional().describe('Filter by event type'),
      source: z.string().optional().describe('Filter by source system'),
      priority: z.string().optional().describe('Filter by priority: critical, high, normal, low'),
    },
    async (params) => {
      let query = supabase
        .from('system_events')
        .select('id, event_type, event_subtype, source, entity_type, entity_id, ghl_contact_id, lp_lead_id, lp_prospect_id, payload, previous_state, new_state, priority, event_timestamp, created_at')
        .eq('processed', false)
        .order('priority', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: true })
        .limit(params.limit || 20);

      if (params.event_type) query = query.eq('event_type', params.event_type);
      if (params.source) query = query.eq('source', params.source);
      if (params.priority) query = query.eq('priority', params.priority);

      const { data, error } = await query;
      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
      return { content: [{ type: 'text', text: JSON.stringify({ count: data.length, events: data }, null, 2) }] };
    }
  );

  // ───────────────────────────────────────────────────
  // Tool: mark_event_processed
  // ───────────────────────────────────────────────────
  server.tool(
    'mark_event_processed',
    'Mark system event(s) as processed after the decision engine has handled them.',
    {
      event_ids: z.string().describe('Comma-separated event IDs to mark processed (e.g. "1,2,3")'),
      processed_by: z.string().describe('Who processed it: "agent", "claude", "ryan", "n8n"'),
      action_taken: z.string().optional().describe('Brief description of action taken'),
    },
    async (params) => {
      const ids = params.event_ids.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
      const { data, error } = await supabase
        .from('system_events')
        .update({ processed: true, processed_by: params.processed_by, processed_at: new Date().toISOString(), action_taken: params.action_taken || null })
        .in('id', ids)
        .select('id');

      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'updated', count: data.length, event_ids: ids }) }] };
    }
  );

  // ───────────────────────────────────────────────────
  // Tool: create_agent_action
  // ───────────────────────────────────────────────────
  server.tool(
    'create_agent_action',
    'Queue an agent action for execution. Actions can auto-execute or require human approval.',
    {
      event_id: z.number().describe('ID of the triggering system event'),
      action_type: z.string().describe('Action type: update_contact, move_opportunity, add_tag, remove_tag, add_to_workflow, remove_from_workflow, send_message, create_task, send_notification'),
      target_system: z.string().describe('Target: ghl, lp, n8n, groupme, notion'),
      target_entity: z.string().describe('Entity type: contact, opportunity, workflow, task'),
      target_id: z.string().describe('ID of entity being acted on'),
      action_payload: z.string().describe('JSON string of action params'),
      rollback_payload: z.string().optional().describe('JSON string of undo params'),
      reasoning: z.string().optional().describe('Why this action is being taken'),
      confidence: z.number().optional().describe('Agent confidence 0.0-1.0'),
      rule_applied: z.string().optional().describe('Rule key that triggered this'),
      requires_approval: z.boolean().optional().describe('Whether human must approve (default false)'),
      batch_id: z.string().optional().describe('Group related actions'),
      sequence_order: z.number().optional().describe('Order within batch (default 0)'),
    },
    async (params) => {
      try {
        const status = params.requires_approval ? 'pending_approval' : 'pending';
        const { data, error } = await supabase
          .from('agent_actions')
          .insert({
            event_id: params.event_id,
            action_type: params.action_type,
            target_system: params.target_system,
            target_entity: params.target_entity,
            target_id: params.target_id,
            action_payload: JSON.parse(params.action_payload),
            rollback_payload: params.rollback_payload ? JSON.parse(params.rollback_payload) : null,
            reasoning: params.reasoning || null,
            confidence: params.confidence || null,
            rule_applied: params.rule_applied || null,
            status,
            requires_approval: params.requires_approval || false,
            batch_id: params.batch_id || null,
            sequence_order: params.sequence_order || 0,
          })
          .select('id, action_type, status, target_id, created_at')
          .single();

        if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'queued', action_id: data.id, action_type: data.action_type, action_status: data.status, target_id: data.target_id, requires_approval: params.requires_approval || false }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Exception: ${err.message}` }] };
      }
    }
  );

  // ───────────────────────────────────────────────────
  // Tool: get_pending_actions
  // ───────────────────────────────────────────────────
  server.tool(
    'get_pending_actions',
    'Get agent actions that are pending execution or awaiting approval.',
    {
      status: z.string().optional().describe('Filter: pending, pending_approval, approved, executing'),
      limit: z.number().optional().describe('Max results (default 20)'),
    },
    async (params) => {
      let query = supabase
        .from('agent_actions')
        .select('id, event_id, action_type, target_system, target_entity, target_id, action_payload, reasoning, confidence, rule_applied, status, requires_approval, batch_id, sequence_order, created_at')
        .order('created_at', { ascending: true })
        .limit(params.limit || 20);

      if (params.status) {
        query = query.eq('status', params.status);
      } else {
        query = query.in('status', ['pending', 'pending_approval', 'approved']);
      }

      const { data, error } = await query;
      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
      return { content: [{ type: 'text', text: JSON.stringify({ count: data.length, actions: data }, null, 2) }] };
    }
  );

  // ───────────────────────────────────────────────────
  // Tool: approve_action
  // ───────────────────────────────────────────────────
  server.tool(
    'approve_action',
    'Approve or reject an agent action that requires human approval.',
    {
      action_id: z.number().describe('ID of the action to approve/reject'),
      decision: z.string().describe('Either "approve" or "reject"'),
      approved_by: z.string().optional().describe('Who approved (default: ryan)'),
      rejection_reason: z.string().optional().describe('Reason for rejection'),
    },
    async (params) => {
      const isApprove = params.decision === 'approve';
      const updates = isApprove
        ? { status: 'approved', approved_by: params.approved_by || 'ryan', approved_at: new Date().toISOString() }
        : { status: 'rejected', approved_by: params.approved_by || 'ryan', approved_at: new Date().toISOString(), rejection_reason: params.rejection_reason || null };

      const { data, error } = await supabase
        .from('agent_actions')
        .update(updates)
        .eq('id', params.action_id)
        .eq('status', 'pending_approval')
        .select('id, action_type, status, target_id')
        .single();

      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
      if (!data) return { content: [{ type: 'text', text: `Action ${params.action_id} not found or not pending_approval.` }] };
      return { content: [{ type: 'text', text: JSON.stringify({ status: isApprove ? 'approved' : 'rejected', action_id: data.id, action_type: data.action_type, target_id: data.target_id }, null, 2) }] };
    }
  );

  // ───────────────────────────────────────────────────
  // Tool: complete_action
  // ───────────────────────────────────────────────────
  server.tool(
    'complete_action',
    'Mark an agent action as completed or failed after execution attempt.',
    {
      action_id: z.number().describe('ID of the action'),
      status: z.string().describe('Either "completed" or "failed"'),
      execution_result: z.string().optional().describe('JSON string of response from target system'),
      error_message: z.string().optional().describe('Error details if failed'),
    },
    async (params) => {
      const updates = {
        status: params.status,
        executed_at: new Date().toISOString(),
        execution_result: params.execution_result ? JSON.parse(params.execution_result) : null,
        error_message: params.error_message || null,
      };

      if (params.status === 'failed') {
        const { data: current } = await supabase.from('agent_actions').select('retry_count, max_retries').eq('id', params.action_id).single();
        if (current && current.retry_count < current.max_retries) {
          updates.status = 'pending';
          updates.retry_count = current.retry_count + 1;
        }
      }

      const { data, error } = await supabase.from('agent_actions').update(updates).eq('id', params.action_id).select('id, action_type, status, retry_count, executed_at').single();
      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
      return { content: [{ type: 'text', text: JSON.stringify({ action_id: data.id, action_type: data.action_type, final_status: data.status, retry_count: data.retry_count, executed_at: data.executed_at }, null, 2) }] };
    }
  );

  // ───────────────────────────────────────────────────
  // Tool: get_event_history
  // ───────────────────────────────────────────────────
  server.tool(
    'get_event_history',
    'Get system event history for a specific entity. Useful for understanding what happened to a contact or lead.',
    {
      ghl_contact_id: z.string().optional().describe('Filter by GHL contact ID'),
      lp_lead_id: z.string().optional().describe('Filter by LP Lead ID'),
      entity_id: z.string().optional().describe('Filter by generic entity ID'),
      event_type: z.string().optional().describe('Filter by event type'),
      limit: z.number().optional().describe('Max results (default 50)'),
      since: z.string().optional().describe('ISO date — only events after this'),
    },
    async (params) => {
      let query = supabase.from('system_events')
        .select('id, event_type, event_subtype, source, entity_type, entity_id, ghl_contact_id, lp_lead_id, payload, new_state, processed, action_taken, priority, event_timestamp, created_at')
        .order('created_at', { ascending: false }).limit(params.limit || 50);

      if (params.ghl_contact_id) query = query.eq('ghl_contact_id', params.ghl_contact_id);
      if (params.lp_lead_id) query = query.eq('lp_lead_id', params.lp_lead_id);
      if (params.entity_id) query = query.eq('entity_id', params.entity_id);
      if (params.event_type) query = query.eq('event_type', params.event_type);
      if (params.since) query = query.gte('created_at', params.since);

      const { data, error } = await query;
      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
      return { content: [{ type: 'text', text: JSON.stringify({ count: data.length, events: data }, null, 2) }] };
    }
  );

  // ───────────────────────────────────────────────────
  // Tool: get_action_history
  // ───────────────────────────────────────────────────
  server.tool(
    'get_action_history',
    'Get agent action history. Useful for auditing what the agent has done.',
    {
      target_id: z.string().optional().describe('Filter by target entity ID'),
      action_type: z.string().optional().describe('Filter by action type'),
      status: z.string().optional().describe('Filter by status'),
      limit: z.number().optional().describe('Max results (default 50)'),
      since: z.string().optional().describe('ISO date — only actions after this'),
    },
    async (params) => {
      let query = supabase.from('agent_actions')
        .select('id, event_id, action_type, target_system, target_entity, target_id, action_payload, reasoning, confidence, rule_applied, status, requires_approval, approved_by, executed_at, execution_result, error_message, retry_count, created_at')
        .order('created_at', { ascending: false }).limit(params.limit || 50);

      if (params.target_id) query = query.eq('target_id', params.target_id);
      if (params.action_type) query = query.eq('action_type', params.action_type);
      if (params.status) query = query.eq('status', params.status);
      if (params.since) query = query.gte('created_at', params.since);

      const { data, error } = await query;
      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
      return { content: [{ type: 'text', text: JSON.stringify({ count: data.length, actions: data }, null, 2) }] };
    }
  );

  // ───────────────────────────────────────────────────
  // Tool: agent_dashboard
  // ───────────────────────────────────────────────────
  server.tool(
    'agent_dashboard',
    'Get a quick overview of the agentic system: pending events, pending actions, recent activity, and health.',
    {},
    async () => {
      try {
        const { data: pendingEvents } = await supabase.from('system_events').select('priority').eq('processed', false);
        const eventCounts = { critical: 0, high: 0, normal: 0, low: 0, total: 0 };
        (pendingEvents || []).forEach(e => {
          eventCounts[e.priority] = (eventCounts[e.priority] || 0) + 1;
          eventCounts.total++;
        });

        const { data: pendingActions } = await supabase.from('agent_actions').select('status').in('status', ['pending', 'pending_approval', 'approved', 'executing']);
        const actionCounts = { pending: 0, pending_approval: 0, approved: 0, executing: 0 };
        (pendingActions || []).forEach(a => { actionCounts[a.status] = (actionCounts[a.status] || 0) + 1; });

        const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { count: eventsLast24h } = await supabase.from('system_events').select('id', { count: 'exact', head: true }).gte('created_at', since24h);
        const { count: actionsCompleted24h } = await supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'completed').gte('executed_at', since24h);
        const { count: actionsFailed24h } = await supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'failed').gte('created_at', since24h);

        return { content: [{ type: 'text', text: JSON.stringify({ pending_events: eventCounts, pending_actions: actionCounts, last_24h: { events_received: eventsLast24h || 0, actions_completed: actionsCompleted24h || 0, actions_failed: actionsFailed24h || 0 } }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Dashboard error: ${err.message}` }] };
      }
    }
  );

}
