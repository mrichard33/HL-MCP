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
} from '../../admin/github-client.js';

export const githubTools = {
  github_list_files: {
    description:
      'List files and directories at a given path in the HL MCP GitHub repository. Returns file names, types, and sizes.',
    inputSchema: z.object({
      path: z.string().optional().default('').describe('Directory path to list (e.g. "src/tools"). Empty for root.'),
      branch: z.string().optional().describe('Branch name. Defaults to repo default branch.'),
    }),
    handler: async (args: { path?: string; branch?: string }) => {
      return await listFiles(args.path, args.branch);
    },
  },

  github_get_file: {
    description:
      'Get the full content of a file from the HL MCP GitHub repository. Returns content + SHA (needed for updates). Supports branch selection.',
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
      'Commit a file to the HL MCP GitHub repository. For updates, provide the SHA from github_get_file. Requires confirm: true. WARNING: Committing to main triggers Railway auto-deploy.',
    inputSchema: z.object({
      path: z.string().describe('File path to create/update'),
      content: z.string().describe('File content'),
      message: z.string().describe('Commit message'),
      branch: z.string().optional().describe('Target branch. Defaults to main.'),
      sha: z.string().optional().describe('Current file SHA (required for updates, get from github_get_file)'),
      confirm: z.boolean().optional().default(false).describe('Must be true to execute. False returns preview only.'),
    }),
    handler: async (args: {
      path: string;
      content: string;
      message: string;
      branch?: string;
      sha?: string;
      confirm?: boolean;
    }) => {
      if (!args.confirm) {
        const isMain = !args.branch || args.branch === 'main' || args.branch === 'master';
        return {
          preview: true,
          action: 'commit_file',
          path: args.path,
          branch: args.branch || 'main',
          message: args.message,
          content_length: args.content.length,
          has_sha: !!args.sha,
          warning: isMain
            ? 'WARNING: Committing to main triggers Railway auto-deploy. Pass confirm: true to execute.'
            : 'Pass confirm: true to execute this commit.',
        };
      }
      return await createOrUpdateFile(args.path, args.content, args.message, args.branch, args.sha);
    },
  },

  github_get_recent_commits: {
    description:
      'Get recent commits from the HL MCP GitHub repository. Shows SHA, message, author, and date. Max 30 commits.',
    inputSchema: z.object({
      branch: z.string().optional().describe('Branch name. Defaults to repo default branch.'),
      limit: z.number().optional().default(10).describe('Number of commits to return (max 30)'),
    }),
    handler: async (args: { branch?: string; limit?: number }) => {
      return await getRecentCommits(args.branch, args.limit);
    },
  },

  github_create_branch: {
    description: 'Create a new branch in the HL MCP GitHub repository from an existing branch.',
    inputSchema: z.object({
      branch_name: z.string().describe('Name for the new branch'),
      from_branch: z.string().optional().default('main').describe('Source branch to create from (default: main)'),
    }),
    handler: async (args: { branch_name: string; from_branch?: string }) => {
      return await createBranch(args.branch_name, args.from_branch);
    },
  },

  github_create_pull_request: {
    description:
      'Open a pull request in the HL MCP GitHub repository. Requires confirm: true. Returns PR number and URL.',
    inputSchema: z.object({
      title: z.string().describe('PR title'),
      head: z.string().describe('Source branch (the branch with changes)'),
      base: z.string().optional().default('main').describe('Target branch (default: main)'),
      body: z.string().optional().describe('PR description/body'),
      confirm: z.boolean().optional().default(false).describe('Must be true to execute. False returns preview only.'),
    }),
    handler: async (args: { title: string; head: string; base?: string; body?: string; confirm?: boolean }) => {
      if (!args.confirm) {
        return {
          preview: true,
          action: 'create_pr',
          title: args.title,
          head: args.head,
          base: args.base || 'main',
          body_length: args.body?.length || 0,
          message: 'Pass confirm: true to create this pull request.',
        };
      }
      return await createPullRequest(args.title, args.head, args.base, args.body);
    },
  },

  github_search_code: {
    description: 'Full-text search across all files in the HL MCP GitHub repository.',
    inputSchema: z.object({
      query: z.string().describe('Search query (e.g. "registerAllTools", "SUPABASE_URL", "async function sync")'),
    }),
    handler: async (args: { query: string }) => {
      return await searchCode(args.query);
    },
  },

  // ─── LP MCP Cross-Repo Tools (diagnostics when LP MCP is down) ───

  lp_github_list_files: {
    description:
      'CROSS-REPO: List files in the LP MCP GitHub repository. Use when LP MCP is down to inspect code, check deployment state, or diagnose issues.',
    inputSchema: z.object({
      path: z.string().optional().default('').describe('Directory path to list. Empty for root.'),
      branch: z.string().optional().default('main').describe('Branch name (default: main)'),
    }),
    handler: async (args: { path?: string; branch?: string }) => {
      const repo = getLpRepo();
      return await listFiles(args.path, args.branch, repo);
    },
  },

  lp_github_get_file: {
    description:
      'CROSS-REPO: Get a file from the LP MCP GitHub repository. Use when LP MCP is down to read code, check configs, or diagnose crashes.',
    inputSchema: z.object({
      path: z.string().describe('File path (e.g. "src/index.js", "package.json")'),
      branch: z.string().optional().default('main').describe('Branch name (default: main)'),
    }),
    handler: async (args: { path: string; branch?: string }) => {
      const repo = getLpRepo();
      return await getFile(args.path, args.branch, repo);
    },
  },

  lp_github_get_recent_commits: {
    description:
      'CROSS-REPO: Get recent commits from the LP MCP GitHub repository. Use to check what was deployed, compare branches, or diagnose deploy issues.',
    inputSchema: z.object({
      branch: z.string().optional().default('main').describe('Branch name (default: main)'),
      limit: z.number().optional().default(10).describe('Number of commits (max 30)'),
    }),
    handler: async (args: { branch?: string; limit?: number }) => {
      const repo = getLpRepo();
      return await getRecentCommits(args.branch, args.limit, repo);
    },
  },

  lp_github_search_code: {
    description:
      'CROSS-REPO: Search code in the LP MCP GitHub repository. Use when LP MCP is down to find functions, configs, or debug issues.',
    inputSchema: z.object({
      query: z.string().describe('Search query'),
    }),
    handler: async (args: { query: string }) => {
      const repo = getLpRepo();
      return await searchCode(args.query, repo);
    },
  },

  lp_github_create_or_update_file: {
    description:
      'CROSS-REPO: Commit a file to the LP MCP GitHub repository. ALWAYS use dev branch. Requires confirm: true.',
    inputSchema: z.object({
      path: z.string().describe('File path'),
      content: z.string().describe('File content'),
      message: z.string().describe('Commit message'),
      branch: z.string().optional().default('dev').describe('Target branch (default: dev). NEVER commit to main.'),
      sha: z.string().optional().describe('Current file SHA (required for updates)'),
      confirm: z.boolean().optional().default(false).describe('Must be true to execute.'),
    }),
    handler: async (args: {
      path: string;
      content: string;
      message: string;
      branch?: string;
      sha?: string;
      confirm?: boolean;
    }) => {
      const repo = getLpRepo();
      const branch = args.branch || 'dev';
      if (!args.confirm) {
        return {
          preview: true,
          repo,
          path: args.path,
          branch,
          message: args.message,
          content_length: args.content.length,
          warning: branch === 'main'
            ? 'BLOCKED: Cannot commit to main on LP MCP through cross-repo tools. Use dev branch.'
            : 'Pass confirm: true to execute.',
        };
      }
      if (branch === 'main') {
        return { error: 'BLOCKED: Cannot commit to main on LP MCP through cross-repo tools. Ryan must merge dev→main manually.' };
      }
      return await createOrUpdateFile(args.path, args.content, args.message, branch, args.sha, repo);
    },
  },
};
