import { railwayTools } from './railway-tools.js';
import { githubTools } from './github-tools.js';
import { supabaseAdminTools } from './supabase-tools.js';
import { lpFallbackTools } from './lp-fallback.js';
import { n8nTools } from './n8n-tools.js';

export const adminTools = {
  ...railwayTools,
  ...githubTools,
  ...supabaseAdminTools,
  ...lpFallbackTools,
  ...n8nTools,
};
