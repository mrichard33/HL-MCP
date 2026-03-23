import { z } from 'zod';
import {
  listFiles,
  getFile,
  createOrUpdateFile,
  getRecentCommits,
  createBranch,
  createPullRequest,
  searchCode,
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
};
