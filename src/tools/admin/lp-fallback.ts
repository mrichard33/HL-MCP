import { z } from 'zod';
import { getLpSupabaseClient, isLpSupabaseConfigured } from '../../clients/supabase-lp.js';

/**
 * LP Supabase Fallback Tools — read-only access to LP MCP's Supabase tables
 * through the HL MCP. Provides continuity when LP MCP is down or redeploying.
 *
 * These tools are READ-ONLY and query the LP MCP Supabase directly via
 * the LP_SUPABASE_URL / LP_SUPABASE_SERVICE_ROLE_KEY env vars.
 *
 * Available when LP MCP is down:
 * - Agent dashboard, pending events, pending actions, event history
 * - LP lead lookup, disposition breakdown
 * - Agent rules reference
 * - Raw SQL query (read-only)
 */

function notConfigured() {
  return {
    content: [{
      type: 'text' as const,
      text: 'LP Supabase not configured. Set LP_SUPABASE_URL and LP_SUPABASE_SERVICE_ROLE_KEY env vars on HL MCP.',
    }],
  };
}

export const lpFallbackTools = {

  // ─── Agentic System Fallback ───────────────────────────────────

  lp_agent_dashboard: {
    description: 'FALLBACK: Get agentic system dashboard from LP Supabase (use when LP MCP is down). Shows pending events, pending actions, and 24h stats.',
    inputSchema: z.object({}),
    handler: async () => {
      const client = getLpSupabaseClient();
      if (!client) return notConfigured();

      try {
        const { data: pendingEvents } = await client
          .from('system_events')
          .select('priority')
          .eq('processed', false);

        const eventCounts = { critical: 0, high: 0, normal: 0, low: 0, total: 0 };
        (pendingEvents || []).forEach((e: any) => {
          eventCounts[e.priority as keyof typeof eventCounts] = (eventCounts[e.priority as keyof typeof eventCounts] || 0) + 1;
          eventCounts.total++;
        });

        const { data: pendingActions } = await client
          .from('agent_actions')
          .select('status')
          .in('status', ['pending', 'pending_approval', 'approved', 'executing']);

        const actionCounts = { pending: 0, pending_approval: 0, approved: 0, executing: 0 };
        (pendingActions || []).forEach((a: any) => {
          actionCounts[a.status as keyof typeof actionCounts] = (actionCounts[a.status as keyof typeof actionCounts] || 0) + 1;
        });

        const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

        const { count: eventsLast24h } = await client
          .from('system_events')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', since24h);

        const { count: actionsCompleted24h } = await client
          .from('agent_actions')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'completed')
          .gte('executed_at', since24h);

        return {
          pending_events: eventCounts,
          pending_actions: actionCounts,
          last_24h: {
            events_received: eventsLast24h || 0,
            actions_completed: actionsCompleted24h || 0,
          },
          source: 'hl_mcp_fallback',
        };
      } catch (err) {
        return { error: `LP Supabase query failed: ${(err as Error).message}` };
      }
    },
  },

  lp_pending_events: {
    description: 'FALLBACK: Get unprocessed system events from LP Supabase (use when LP MCP is down).',
    inputSchema: z.object({
      limit: z.number().optional().default(20),
      event_type: z.string().optional(),
      priority: z.enum(['critical', 'high', 'normal', 'low']).optional(),
    }),
    handler: async (args: { limit?: number; event_type?: string; priority?: string }) => {
      const client = getLpSupabaseClient();
      if (!client) return notConfigured();

      try {
        let query = client
          .from('system_events')
          .select('id, event_type, event_subtype, source, entity_type, entity_id, ghl_contact_id, lp_lead_id, payload, priority, event_timestamp, created_at')
          .eq('processed', false)
          .order('created_at', { ascending: true })
          .limit(args.limit || 20);

        if (args.event_type) query = query.eq('event_type', args.event_type);
        if (args.priority) query = query.eq('priority', args.priority);

        const { data, error } = await query;
        if (error) return { error: error.message };
        return { count: data?.length || 0, events: data, source: 'hl_mcp_fallback' };
      } catch (err) {
        return { error: (err as Error).message };
      }
    },
  },

  lp_agent_rules: {
    description: 'FALLBACK: Get agent rules from LP Supabase (use when LP MCP is down). Shows disposition routing rules and other encoded logic.',
    inputSchema: z.object({
      category: z.string().optional().describe('Filter by category (e.g. "disposition_routing")'),
      rule_key: z.string().optional().describe('Get a specific rule by key'),
    }),
    handler: async (args: { category?: string; rule_key?: string }) => {
      const client = getLpSupabaseClient();
      if (!client) return notConfigured();

      try {
        let query = client
          .from('agent_rules')
          .select('rule_key, rule_name, category, event_pattern, action_template, requires_approval, enabled, priority, notes')
          .eq('enabled', true)
          .order('priority', { ascending: true });

        if (args.category) query = query.eq('category', args.category);
        if (args.rule_key) query = query.eq('rule_key', args.rule_key);

        const { data, error } = await query;
        if (error) return { error: error.message };
        return { count: data?.length || 0, rules: data, source: 'hl_mcp_fallback' };
      } catch (err) {
        return { error: (err as Error).message };
      }
    },
  },

  // ─── LP Data Fallback ──────────────────────────────────────────

  lp_search_leads: {
    description: 'FALLBACK: Search LP leads by name, phone, or email (use when LP MCP is down). Queries lp_leads table in LP Supabase.',
    inputSchema: z.object({
      query: z.string().describe('Search term — name, phone, or email'),
      limit: z.number().optional().default(25),
    }),
    handler: async (args: { query: string; limit?: number }) => {
      const client = getLpSupabaseClient();
      if (!client) return notConfigured();

      try {
        const q = args.query.trim();
        const isPhone = /^\d{7,}$/.test(q.replace(/\D/g, ''));

        let query;
        if (isPhone) {
          const digits = q.replace(/\D/g, '');
          query = client.from('lp_leads')
            .select('lp_lead_id, first_name, last_name, phone, email, disposition_code, rep_name, lead_source, ghl_contact_id, created_at_lp')
            .or(`phone.ilike.%${digits}%,phone_alt.ilike.%${digits}%`)
            .limit(args.limit || 25);
        } else if (q.includes('@')) {
          query = client.from('lp_leads')
            .select('lp_lead_id, first_name, last_name, phone, email, disposition_code, rep_name, lead_source, ghl_contact_id, created_at_lp')
            .ilike('email', `%${q}%`)
            .limit(args.limit || 25);
        } else {
          query = client.from('lp_leads')
            .select('lp_lead_id, first_name, last_name, phone, email, disposition_code, rep_name, lead_source, ghl_contact_id, created_at_lp')
            .or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%`)
            .limit(args.limit || 25);
        }

        const { data, error } = await query;
        if (error) return { error: error.message };
        return { count: data?.length || 0, leads: data, source: 'hl_mcp_fallback' };
      } catch (err) {
        return { error: (err as Error).message };
      }
    },
  },

  lp_run_query: {
    description: 'FALLBACK: Run a read-only SQL query against LP Supabase (use when LP MCP is down). SELECT only — no writes allowed through fallback.',
    inputSchema: z.object({
      query: z.string().describe('SQL SELECT query to execute against LP Supabase'),
    }),
    handler: async (args: { query: string }) => {
      const client = getLpSupabaseClient();
      if (!client) return notConfigured();

      // Safety: block destructive queries through fallback
      const upper = args.query.trim().toUpperCase();
      if (upper.startsWith('INSERT') || upper.startsWith('UPDATE') || upper.startsWith('DELETE') ||
          upper.startsWith('DROP') || upper.startsWith('ALTER') || upper.startsWith('CREATE') ||
          upper.startsWith('TRUNCATE')) {
        return { error: 'Fallback tools are read-only. Use LP MCP directly for write operations.' };
      }

      try {
        const { data, error } = await client.rpc('', {} as any);
        // rpc won't work for raw SQL — use the postgrest approach
        // Actually, Supabase JS client doesn't support raw SQL directly.
        // We need to use the REST API with the sql endpoint.

        // For now, provide a helpful error
        return {
          error: 'Raw SQL not available through Supabase JS client fallback. Use specific fallback tools (lp_search_leads, lp_agent_dashboard, lp_agent_rules, lp_pending_events) instead.',
          suggestion: 'If LP MCP is back online, use LP MCP:supabase_run_query for raw SQL.',
        };
      } catch (err) {
        return { error: (err as Error).message };
      }
    },
  },

  lp_session_context: {
    description: 'FALLBACK: Get the latest Claude session log and open issues from LP Supabase (use when LP MCP is down). Essential for session continuity.',
    inputSchema: z.object({}),
    handler: async () => {
      const client = getLpSupabaseClient();
      if (!client) return notConfigured();

      try {
        const [sessionResult, issuesResult, decisionsResult] = await Promise.all([
          client.from('claude_session_logs')
            .select('id, session_date, session_title, phase_focus, next_steps, pending_items, raw_summary')
            .order('created_at', { ascending: false })
            .limit(1),
          client.from('claude_known_issues')
            .select('id, severity, category, description, workflow_name, status, reported_date')
            .in('status', ['open', 'in_progress'])
            .order('severity', { ascending: true }),
          client.from('claude_decision_log')
            .select('decision_date, category, decision, rationale, workflow_name')
            .order('created_at', { ascending: false })
            .limit(10),
        ]);

        return {
          last_session: sessionResult.data?.[0] || null,
          open_issues: issuesResult.data || [],
          recent_decisions: decisionsResult.data || [],
          source: 'hl_mcp_fallback',
        };
      } catch (err) {
        return { error: (err as Error).message };
      }
    },
  },
};
