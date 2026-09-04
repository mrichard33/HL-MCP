import { railwayTools } from './railway-tools.js';
import { githubTools } from './github-tools.js';
import { githubPrTools } from './github-pr-tools.js';
import { supabaseAdminTools } from './supabase-tools.js';
import { lpFallbackTools } from './lp-fallback.js';
import { n8nTools } from './n8n-tools.js';

export const adminTools = {
  ...railwayTools,
  ...githubTools,
  // Read half of the GitHub surface (github_list_pull_requests,
  // github_get_pull_request_files, github_check_pr_overlap,
  // github_list_branches). Read-only, and no key overlap with
  // githubTools above — which can open a PR but never read one back —
  // so the spread order is cosmetic rather than load-bearing.
  ...githubPrTools,
  ...supabaseAdminTools,
  ...lpFallbackTools,
  ...n8nTools,
};
