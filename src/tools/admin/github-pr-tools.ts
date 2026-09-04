/**
 * GitHub PR read tools + own-repo branch listing for HL MCP.
 *
 * Companion to LP-MCP PR #829. Two gaps closed on this side:
 *
 *  1. PULL REQUESTS WERE WRITE-ONLY. github_create_pull_request and
 *     dashboard_github_create_pull_request could open a PR; nothing
 *     could read one back. "What is open right now" and "do these two
 *     PRs touch the same file" were unanswerable from this service.
 *
 *  2. HL-MCP HAD NO OWN-REPO BRANCH LISTER. lp_, n8n_, dashboard_ and
 *     ghlworkflows_ mirrors existed; the repo this server ships from
 *     did not. Added here as github_list_branches.
 *
 * The pagination and backup-filter fix that motivated all of this lives
 * in listBranches() in ../../admin/github-client.ts, so the four
 * existing cross-repo listers inherit it without changing their names.
 */

import { z } from 'zod';
import {
  listBranches,
  listPullRequests,
  getPullRequestFiles,
  checkPrOverlap,
  getLpRepo,
  getN8nRepo,
  getDashboardRepo,
  getGhlWorkflowsRepo,
} from '../../admin/github-client.js';

const REPO_CHOICES = ['hl', 'lp', 'dashboard', 'n8n', 'ghl-workflows'] as const;
type RepoKey = (typeof REPO_CHOICES)[number];

/**
 * Returns undefined for 'hl' so getRepo() falls through to GITHUB_REPO,
 * which is how every own-repo call in github-tools.ts already works.
 */
function resolveRepo(key?: RepoKey): string | undefined {
  switch (key) {
    case 'lp': return getLpRepo();
    case 'dashboard': return getDashboardRepo();
    case 'n8n': return getN8nRepo();
    case 'ghl-workflows': return getGhlWorkflowsRepo();
    case 'hl':
    default: return undefined;
  }
}

const repoParam = z
  .enum(REPO_CHOICES)
  .optional()
  .describe('Which repo (default: "hl"). One of: hl, lp, dashboard, n8n, ghl-workflows');

export const githubPrTools = {
  github_list_pull_requests: {
    description:
      'List pull requests in any repo in the stack. Defaults to OPEN PRs in the HL MCP repo. This is the read half of github_create_pull_request — use it before opening a PR to see what is already in flight.',
    inputSchema: z.object({
      repo: repoParam,
      state: z.enum(['open', 'closed', 'all']).optional().describe('PR state (default: "open")'),
      base: z.string().optional().describe('Only PRs targeting this base branch. Example: "main"'),
      limit: z.number().optional().describe('Max PRs to return (default 50, max 300)'),
    }),
    handler: async (args: {
      repo?: RepoKey;
      state?: 'open' | 'closed' | 'all';
      base?: string;
      limit?: number;
    }) => {
      return await listPullRequests(
        args.state || 'open',
        args.base,
        args.limit ?? 50,
        resolveRepo(args.repo)
      );
    },
  },

  github_get_pull_request_files: {
    description:
      'List the files a single pull request changes, with per-file status and line counts. Use to judge review scope, or to check by hand whether one PR touches the same files as another.',
    inputSchema: z.object({
      number: z.number().describe('Pull request number. Example: 159'),
      repo: repoParam,
    }),
    handler: async (args: { number: number; repo?: RepoKey }) => {
      return await getPullRequestFiles(args.number, resolveRepo(args.repo));
    },
  },

  github_check_pr_overlap: {
    description:
      'Check whether the OPEN pull requests in a repo touch the same files. Returns every pair of open PRs sharing at least one file, with the shared paths named, plus the PRs that overlap with nothing. Use before merging a batch of PRs.',
    inputSchema: z.object({
      repo: repoParam,
      base: z.string().optional().describe('Only consider PRs targeting this base branch (default: "main")'),
      max_prs: z
        .number()
        .optional()
        .describe('Max open PRs to inspect, newest-updated first (default 25, max 50). One API call per PR.'),
      include_drafts: z.boolean().optional().describe('Include draft PRs (default: true)'),
    }),
    handler: async (args: {
      repo?: RepoKey;
      base?: string;
      max_prs?: number;
      include_drafts?: boolean;
    }) => {
      return await checkPrOverlap(
        args.base || 'main',
        args.max_prs ?? 25,
        args.include_drafts !== false,
        resolveRepo(args.repo)
      );
    },
  },

  github_list_branches: {
    description:
      'List branches in any repo in the stack, excluding the daily bk-MM-DD-YYYY backup branches by default and paginating past the 100-branch page limit. HL-MCP had no own-repo branch lister before this.',
    inputSchema: z.object({
      repo: repoParam,
      include_backups: z
        .boolean()
        .optional()
        .describe('Include daily bk-MM-DD-YYYY backup branches (default: false)'),
      contains: z
        .string()
        .optional()
        .describe('Only branches whose name contains this substring, case-insensitive. Example: "fix/"'),
    }),
    handler: async (args: { repo?: RepoKey; include_backups?: boolean; contains?: string }) => {
      return await listBranches(resolveRepo(args.repo), args.include_backups === true, args.contains);
    },
  },
};
