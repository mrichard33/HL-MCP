import { z } from 'zod';
import {
  listFiles,
  getFile,
  createOrUpdateFile,
  getRecentCommits,
  createBranch,
  createPullRequest,
  searchCode,
  getLpRepo,
  getN8nRepo,
  getDashboardRepo,
  listBranches,
} from '../../admin/github-client.js';

export const githubTools = {
  github_list_files: {
    description:
      'List files and directories at a given path in the HL MCP GitHub repository.',
    inputSchema: z.object({
      path: z.string().optional().describe('Directory path to list. Empty for root.'),
      branch: z.string().optional().describe('Branch name. Defaults to repo default branch.'),
    }),
    handler: async (args: { path?: string; branch?: string }) => {
      return await listFiles(args.path || '', args.branch);
    },
  },

  github_get_file: {
    description:
      'Get the full content of a file from the HL MCP GitHub repository. Returns content + SHA.',
    inputSchema: z.object({
      path: z.string().describe('File path (e.g. "package.json", "src/index.ts")'),
      branch: z.string().optional().describe('Branch name. Defaults to repo default branch.'),
    }),
    handler: async (args: { path: string; branch?: string }) => {
      return await getFile(args.path, args.branch);
    },
  },

  github_create_or_update_file: {
    description:
      'Commit a file to the HL MCP GitHub repository. Requires confirm: true. WARNING: main triggers auto-deploy.',
    inputSchema: z.object({
      path: z.string().describe('File path to create/update'),
      content: z.string().describe('File content'),
      message: z.string().describe('Commit message'),
      branch: z.string().optional().describe('Target branch. Defaults to main.'),
      sha: z.string().optional().describe('Current file SHA (required for updates)'),
      confirm: z.boolean().optional().describe('Must be true to execute.'),
    }),
    handler: async (args: { path: string; content: string; message: string; branch?: string; sha?: string; confirm?: boolean }) => {
      if (!args.confirm) {
        const isMain = !args.branch || args.branch === 'main' || args.branch === 'master';
        return { preview: true, path: args.path, branch: args.branch || 'main', message: args.message, content_length: args.content.length, warning: isMain ? 'WARNING: main triggers auto-deploy.' : 'Pass confirm: true.' };
      }
      return await createOrUpdateFile(args.path, args.content, args.message, args.branch, args.sha);
    },
  },

  github_get_recent_commits: {
    description: 'Get recent commits from the HL MCP GitHub repository.',
    inputSchema: z.object({
      branch: z.string().optional().describe('Branch name.'),
      limit: z.number().optional().describe('Number of commits (max 30, default 10)'),
    }),
    handler: async (args: { branch?: string; limit?: number }) => {
      return await getRecentCommits(args.branch, args.limit);
    },
  },

  github_create_branch: {
    description: 'Create a new branch in the HL MCP GitHub repository.',
    inputSchema: z.object({
      branch_name: z.string().describe('Name for the new branch'),
      from_branch: z.string().optional().describe('Source branch (default: main)'),
    }),
    handler: async (args: { branch_name: string; from_branch?: string }) => {
      return await createBranch(args.branch_name, args.from_branch || 'main');
    },
  },

  github_create_pull_request: {
    description: 'Open a pull request in the HL MCP GitHub repository. Requires confirm: true.',
    inputSchema: z.object({
      title: z.string().describe('PR title'),
      head: z.string().describe('Source branch'),
      base: z.string().optional().describe('Target branch (default: main)'),
      body: z.string().optional().describe('PR description'),
      confirm: z.boolean().optional().describe('Must be true to execute.'),
    }),
    handler: async (args: { title: string; head: string; base?: string; body?: string; confirm?: boolean }) => {
      if (!args.confirm) return { preview: true, title: args.title, head: args.head, base: args.base || 'main' };
      return await createPullRequest(args.title, args.head, args.base || 'main', args.body);
    },
  },

  github_search_code: {
    description: 'Full-text search across all files in the HL MCP GitHub repository.',
    inputSchema: z.object({
      query: z.string().describe('Search query'),
    }),
    handler: async (args: { query: string }) => {
      return await searchCode(args.query);
    },
  },

  // ─── LP MCP Cross-Repo Tools ──────────────────────────────────

  lp_github_list_files: {
    description: 'CROSS-REPO: List files in the LP MCP GitHub repository (mrichard33/LP-MCP).',
    inputSchema: z.object({
      path: z.string().optional().describe('Directory path. Empty for root.'),
      branch: z.string().optional().describe('Branch name (default: main)'),
    }),
    handler: async (args: { path?: string; branch?: string }) => {
      return await listFiles(args.path || '', args.branch || 'main', getLpRepo());
    },
  },

  lp_github_get_file: {
    description: 'CROSS-REPO: Get a file from the LP MCP GitHub repository.',
    inputSchema: z.object({
      path: z.string().describe('File path'),
      branch: z.string().optional().describe('Branch name (default: main)'),
    }),
    handler: async (args: { path: string; branch?: string }) => {
      return await getFile(args.path, args.branch || 'main', getLpRepo());
    },
  },

  lp_github_get_recent_commits: {
    description: 'CROSS-REPO: Get recent commits from the LP MCP GitHub repository.',
    inputSchema: z.object({
      branch: z.string().optional().describe('Branch name (default: main)'),
      limit: z.number().optional().describe('Number of commits (max 30)'),
    }),
    handler: async (args: { branch?: string; limit?: number }) => {
      return await getRecentCommits(args.branch || 'main', args.limit, getLpRepo());
    },
  },

  lp_github_search_code: {
    description: 'CROSS-REPO: Search code in the LP MCP GitHub repository.',
    inputSchema: z.object({ query: z.string().describe('Search query') }),
    handler: async (args: { query: string }) => {
      return await searchCode(args.query, getLpRepo());
    },
  },

  lp_github_create_or_update_file: {
    description: 'CROSS-REPO: Commit a file to the LP MCP GitHub repository. ALWAYS use dev branch.',
    inputSchema: z.object({
      path: z.string().describe('File path'),
      content: z.string().describe('File content'),
      message: z.string().describe('Commit message'),
      branch: z.string().optional().describe('Target branch (default: dev). NEVER main.'),
      sha: z.string().optional().describe('File SHA for updates'),
      confirm: z.boolean().optional().describe('Must be true to execute.'),
    }),
    handler: async (args: { path: string; content: string; message: string; branch?: string; sha?: string; confirm?: boolean }) => {
      const branch = args.branch || 'dev';
      if (branch === 'main') return { error: 'BLOCKED: Cannot commit to main through cross-repo tools.' };
      if (!args.confirm) return { preview: true, repo: getLpRepo(), path: args.path, branch, message: args.message };
      return await createOrUpdateFile(args.path, args.content, args.message, branch, args.sha, getLpRepo());
    },
  },

  lp_github_list_branches: {
    description: 'CROSS-REPO: List all branches in the LP MCP GitHub repository.',
    inputSchema: z.object({}),
    handler: async () => {
      return await listBranches(getLpRepo());
    },
  },

  // ─── n8n Cross-Repo Tools ─────────────────────────────────────

  n8n_github_list_files: {
    description: 'CROSS-REPO: List files in the n8n GitHub repository (mrichard33/n8n). For inspecting n8n Docker/Railway config.',
    inputSchema: z.object({
      path: z.string().optional().describe('Directory path. Empty for root.'),
      branch: z.string().optional().describe('Branch name (default: main)'),
    }),
    handler: async (args: { path?: string; branch?: string }) => {
      return await listFiles(args.path || '', args.branch || 'main', getN8nRepo());
    },
  },

  n8n_github_get_file: {
    description: 'CROSS-REPO: Get a file from the n8n GitHub repository. For reading Dockerfiles, configs, etc.',
    inputSchema: z.object({
      path: z.string().describe('File path (e.g. "Dockerfile", "docker-compose.yml")'),
      branch: z.string().optional().describe('Branch name (default: main)'),
    }),
    handler: async (args: { path: string; branch?: string }) => {
      return await getFile(args.path, args.branch || 'main', getN8nRepo());
    },
  },

  n8n_github_get_recent_commits: {
    description: 'CROSS-REPO: Get recent commits from the n8n GitHub repository. Check deploy history.',
    inputSchema: z.object({
      branch: z.string().optional().describe('Branch name (default: main)'),
      limit: z.number().optional().describe('Number of commits (max 30)'),
    }),
    handler: async (args: { branch?: string; limit?: number }) => {
      return await getRecentCommits(args.branch || 'main', args.limit, getN8nRepo());
    },
  },

  n8n_github_search_code: {
    description: 'CROSS-REPO: Search code in the n8n GitHub repository.',
    inputSchema: z.object({ query: z.string().describe('Search query') }),
    handler: async (args: { query: string }) => {
      return await searchCode(args.query, getN8nRepo());
    },
  },

  n8n_github_list_branches: {
    description: 'CROSS-REPO: List all branches in the n8n GitHub repository. Shows which branches exist and their latest commit.',
    inputSchema: z.object({}),
    handler: async () => {
      return await listBranches(getN8nRepo());
    },
  },

  n8n_github_create_or_update_file: {
    description: 'CROSS-REPO: Commit a file to the n8n GitHub repository. Use dev branch unless Ryan says otherwise.',
    inputSchema: z.object({
      path: z.string().describe('File path'),
      content: z.string().describe('File content'),
      message: z.string().describe('Commit message'),
      branch: z.string().optional().describe('Target branch (default: dev).'),
      sha: z.string().optional().describe('File SHA for updates'),
      confirm: z.boolean().optional().describe('Must be true to execute.'),
    }),
    handler: async (args: { path: string; content: string; message: string; branch?: string; sha?: string; confirm?: boolean }) => {
      const branch = args.branch || 'dev';
      if (!args.confirm) return { preview: true, repo: getN8nRepo(), path: args.path, branch, message: args.message };
      return await createOrUpdateFile(args.path, args.content, args.message, branch, args.sha, getN8nRepo());
    },
  },

  // ─── Reece Dashboard Cross-Repo Tools (read + write) ──────────

  dashboard_github_list_files: {
    description: 'CROSS-REPO: List files in the Reece Dashboard GitHub repository.',
    inputSchema: z.object({
      path: z.string().optional().describe('Directory path. Empty for root.'),
      branch: z.string().optional().describe('Branch name (default: main)'),
    }),
    handler: async (args: { path?: string; branch?: string }) => {
      return await listFiles(args.path || '', args.branch || 'main', getDashboardRepo());
    },
  },

  dashboard_github_get_file: {
    description: 'CROSS-REPO: Get a file from the Reece Dashboard GitHub repository.',
    inputSchema: z.object({
      path: z.string().describe('File path'),
      branch: z.string().optional().describe('Branch name (default: main)'),
    }),
    handler: async (args: { path: string; branch?: string }) => {
      return await getFile(args.path, args.branch || 'main', getDashboardRepo());
    },
  },

  dashboard_github_get_recent_commits: {
    description: 'CROSS-REPO: Get recent commits from the Reece Dashboard GitHub repository.',
    inputSchema: z.object({
      branch: z.string().optional().describe('Branch name (default: main)'),
      limit: z.number().optional().describe('Number of commits (max 30)'),
    }),
    handler: async (args: { branch?: string; limit?: number }) => {
      return await getRecentCommits(args.branch || 'main', args.limit, getDashboardRepo());
    },
  },

  dashboard_github_search_code: {
    description: 'CROSS-REPO: Search code in the Reece Dashboard GitHub repository.',
    inputSchema: z.object({ query: z.string().describe('Search query') }),
    handler: async (args: { query: string }) => {
      return await searchCode(args.query, getDashboardRepo());
    },
  },

  dashboard_github_list_branches: {
    description: 'CROSS-REPO: List all branches in the Reece Dashboard GitHub repository.',
    inputSchema: z.object({}),
    handler: async () => {
      return await listBranches(getDashboardRepo());
    },
  },

  dashboard_github_create_or_update_file: {
    description: 'CROSS-REPO: Create or update a file in the Reece Dashboard GitHub repository. Requires confirm: true. WARNING: committing to main may trigger an auto-deploy of the dashboard.',
    inputSchema: z.object({
      path: z.string().describe('File path to create/update'),
      content: z.string().describe('File content'),
      message: z.string().describe('Commit message'),
      branch: z.string().optional().describe('Target branch. Defaults to main.'),
      sha: z.string().optional().describe('Current file SHA (required for updates — get from dashboard_github_get_file)'),
      confirm: z.boolean().optional().describe('Must be true to execute.'),
    }),
    handler: async (args: { path: string; content: string; message: string; branch?: string; sha?: string; confirm?: boolean }) => {
      if (!args.confirm) {
        const isMain = !args.branch || args.branch === 'main' || args.branch === 'master';
        return { preview: true, repo: getDashboardRepo(), path: args.path, branch: args.branch || 'main', message: args.message, content_length: args.content.length, warning: isMain ? 'WARNING: main may trigger an auto-deploy of the dashboard. Pass confirm: true to proceed.' : 'Pass confirm: true.' };
      }
      return await createOrUpdateFile(args.path, args.content, args.message, args.branch, args.sha, getDashboardRepo());
    },
  },

  dashboard_github_create_branch: {
    description: 'CROSS-REPO: Create a new branch in the Reece Dashboard GitHub repository.',
    inputSchema: z.object({
      branch_name: z.string().describe('Name for the new branch'),
      from_branch: z.string().optional().describe('Source branch (default: main)'),
    }),
    handler: async (args: { branch_name: string; from_branch?: string }) => {
      return await createBranch(args.branch_name, args.from_branch || 'main', getDashboardRepo());
    },
  },

  dashboard_github_create_pull_request: {
    description: 'CROSS-REPO: Open a pull request in the Reece Dashboard GitHub repository. Requires confirm: true.',
    inputSchema: z.object({
      title: z.string().describe('PR title'),
      head: z.string().describe('Source branch'),
      base: z.string().optional().describe('Target branch (default: main)'),
      body: z.string().optional().describe('PR description'),
      confirm: z.boolean().optional().describe('Must be true to execute.'),
    }),
    handler: async (args: { title: string; head: string; base?: string; body?: string; confirm?: boolean }) => {
      if (!args.confirm) return { preview: true, repo: getDashboardRepo(), title: args.title, head: args.head, base: args.base || 'main' };
      return await createPullRequest(args.title, args.head, args.base || 'main', args.body, getDashboardRepo());
    },
  },
};
