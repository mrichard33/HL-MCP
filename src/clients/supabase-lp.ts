import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * Separate Supabase client for the LP MCP database.
 * This is where the agentic system tables live (system_events, agent_actions, etc.)
 * 
 * Requires env vars:
 *   LP_SUPABASE_URL — URL of the LP MCP Supabase instance
 *   LP_SUPABASE_SERVICE_ROLE_KEY — Service role key for LP MCP Supabase
 */

let lpSupabaseInstance: SupabaseClient | null = null;

export function getLpSupabaseClient(): SupabaseClient | null {
  if (lpSupabaseInstance) return lpSupabaseInstance;

  const url = process.env.LP_SUPABASE_URL;
  const key = process.env.LP_SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    // Not configured — event bus forwarding will be skipped silently
    return null;
  }

  lpSupabaseInstance = createClient(url, key);
  return lpSupabaseInstance;
}

export function isLpSupabaseConfigured(): boolean {
  return !!(process.env.LP_SUPABASE_URL && process.env.LP_SUPABASE_SERVICE_ROLE_KEY);
}
