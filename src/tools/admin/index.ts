import { railwayTools } from './railway-tools.js';
import { githubTools } from './github-tools.js';
import { supabaseAdminTools } from './supabase-tools.js';

export const adminTools = {
  ...railwayTools,
  ...githubTools,
  ...supabaseAdminTools,
};
