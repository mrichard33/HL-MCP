/**
 * GitHub REST API v3 wrapper for the HL MCP repository.
 * 
 * v1.2: Added n8n repo support alongside LP MCP cross-repo access.
 * All functions accept an optional `repo` parameter to query any repository
 * the GITHUB_PAT has access to. Defaults to GITHUB_REPO env var.
 * 
 * Cross-repo access:
 * - LP MCP:        getLpRepo() → LP_GITHUB_REPO env var
 * - n8n:           getN8nRepo() → N8N_GITHUB_REPO env var
 * - Dashboard:     getDashboardRepo() → DASHBOARD_GITHUB_REPO env var
 * - GHL Workflows: getGhlWorkflowsRepo() → GHLWORKFLOWS_GITHUB_REPO env var
 *
 * v1.3: searchCode no longer uses GitHub's /search/code API — that index
 * silently returns 0 results for these private repos (unavailable to the
 * PAT / unindexed). Search is now self-contained: download the repo
 * tarball once (single API call), gunzip + parse in memory, and grep
 * every text file for the query as a case-insensitive substring. Cached
 * per repo@ref for 120s. Works on any branch; exact substring semantics.
 * Mirrors LP-MCP PR #491.
 */

import * as zlib from 'node:zlib';

const GITHUB_API = 'https://api.github.com';

function getHeaders(): Record<string, string> {
  const token = process.env.GITHUB_PAT;
  if (!token) throw new Error('Missing GITHUB_PAT environment variable');
  return {
    Accept: 'application/vnd.github.v3+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function getRepo(repoOverride?: string): string {
  const repo = repoOverride || process.env.GITHUB_REPO;
  if (!repo) throw new Error('Missing GITHUB_REPO environment variable (format: owner/repo)');
  return repo;
}

/**
 * Get the LP MCP repo name from env.
 */
export function getLpRepo(): string {
  return process.env.LP_GITHUB_REPO || 'mrichard33/LP-MCP';
}

/**
 * Get the n8n repo name from env.
 */
export function getN8nRepo(): string {
  return process.env.N8N_GITHUB_REPO || 'mrichard33/n8n';
}

/**
 * Get the Reece Dashboard repo name from env.
 */
export function getDashboardRepo(): string {
  return process.env.DASHBOARD_GITHUB_REPO || 'mrichard33/Reece-Dashboard';
}

/**
 * Get the GHL-Workflows repo name from env.
 */
export function getGhlWorkflowsRepo(): string {
  return process.env.GHLWORKFLOWS_GITHUB_REPO || 'mrichard33/GHL-Workflows';
}

async function api(path: string, options: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: { ...getHeaders(), ...(options.headers as Record<string, string> || {}) },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ${res.status}: ${text}`);
  }
  return res.json();
}

// ─── Branch listing (new in v1.2) ────────────────────────────────

export async function listBranches(repo?: string): Promise<unknown> {
  const r = getRepo(repo);
  const data = (await api(`/repos/${r}/branches?per_page=100`)) as Array<{
    name: string;
    commit: { sha: string; url: string };
    protected: boolean;
  }>;
  return {
    repo: r,
    branches: data.map((b) => ({
      name: b.name,
      sha: b.commit.sha.slice(0, 7),
      protected: b.protected,
    })),
    count: data.length,
  };
}

// ─── Existing functions (all with repo override) ─────────────────

export async function listFiles(path = '', branch?: string, repo?: string): Promise<unknown> {
  const r = getRepo(repo);
  let url = `/repos/${r}/contents/${path}`;
  if (branch) url += `?ref=${encodeURIComponent(branch)}`;
  const data = (await api(url)) as Array<{
    name: string;
    type: string;
    size: number;
    path: string;
  }>;
  return {
    path,
    branch: branch || 'default',
    files: Array.isArray(data)
      ? data.map((f) => ({ name: f.name, type: f.type, size: f.size, path: f.path }))
      : data,
  };
}

export async function getFile(
  path: string,
  branch?: string,
  repo?: string
): Promise<{ content: string; sha: string; size: number; path: string }> {
  const r = getRepo(repo);
  let url = `/repos/${r}/contents/${path}`;
  if (branch) url += `?ref=${encodeURIComponent(branch)}`;
  const data = (await api(url)) as {
    content: string;
    sha: string;
    size: number;
    path: string;
    encoding: string;
  };
  const content =
    data.encoding === 'base64' ? Buffer.from(data.content, 'base64').toString('utf-8') : data.content;
  return { content, sha: data.sha, size: data.size, path: data.path };
}

export async function createOrUpdateFile(
  path: string,
  content: string,
  message: string,
  branch?: string,
  sha?: string,
  repo?: string
): Promise<unknown> {
  const r = getRepo(repo);
  const body: Record<string, unknown> = {
    message,
    content: Buffer.from(content).toString('base64'),
  };
  if (branch) body.branch = branch;
  if (sha) body.sha = sha;

  const data = await api(`/repos/${r}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return data;
}

export async function getRecentCommits(branch?: string, limit = 10, repo?: string): Promise<unknown> {
  const r = getRepo(repo);
  let url = `/repos/${r}/commits?per_page=${Math.min(limit, 30)}`;
  if (branch) url += `&sha=${encodeURIComponent(branch)}`;
  const data = (await api(url)) as Array<{
    sha: string;
    commit: { message: string; author: { name: string; date: string } };
  }>;
  return {
    branch: branch || 'default',
    commits: data.map((c) => ({
      sha: c.sha.slice(0, 7),
      full_sha: c.sha,
      message: c.commit.message,
      author: c.commit.author.name,
      date: c.commit.author.date,
    })),
  };
}

export async function createBranch(branchName: string, fromBranch = 'main', repo?: string): Promise<unknown> {
  const r = getRepo(repo);
  const refData = (await api(`/repos/${r}/git/ref/heads/${encodeURIComponent(fromBranch)}`)) as {
    object: { sha: string };
  };
  const data = await api(`/repos/${r}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({
      ref: `refs/heads/${branchName}`,
      sha: refData.object.sha,
    }),
  });
  return { success: true, branch: branchName, from: fromBranch, data };
}

export async function createPullRequest(
  title: string,
  head: string,
  base = 'main',
  body?: string,
  repo?: string
): Promise<unknown> {
  const r = getRepo(repo);
  const data = (await api(`/repos/${r}/pulls`, {
    method: 'POST',
    body: JSON.stringify({ title, head, base, body: body || '' }),
  })) as { number: number; html_url: string; title: string };
  return {
    success: true,
    pr_number: data.number,
    url: data.html_url,
    title: data.title,
  };
}

// ─── Tarball-grep code search (v1.3) ─────────────────────────────
// Replaces GitHub /search/code, whose index returns 0 results for
// these private repos. One tarball fetch per repo@ref per 120s, then
// pure in-memory grep. Binary blobs (NUL byte in the first 8KB) and
// files >1MB are skipped.

interface SearchMatch {
  line: number;
  text: string;
}

const TARBALL_CACHE = new Map<string, { files: Map<string, string>; fetchedAt: number }>();
const TARBALL_TTL_MS = 120000;
const TARBALL_CACHE_MAX = 4;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_RESULT_FILES = 50;
const MAX_MATCHES_PER_FILE = 5;
const MAX_LINE_LEN = 200;

/**
 * Minimal tar parser (ustar/pax as produced by git archive / GitHub
 * tarballs). Handles pax extended headers ('x') and GNU longnames
 * ('L') for long paths; skips dirs, global headers, and symlinks.
 */
function parseTarEntries(tarBuf: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  let offset = 0;
  let pendingLongName: string | null = null;

  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive zero block

    const rawName = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const sizeOctal = header.toString('utf8', 124, 136).replace(/[^0-7]/g, '');
    const size = parseInt(sizeOctal || '0', 8) || 0;
    const typeflag = String.fromCharCode(header[156]);
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');

    const dataStart = offset + 512;
    const body = tarBuf.subarray(dataStart, Math.min(dataStart + size, tarBuf.length));

    const name = pendingLongName || (prefix ? `${prefix}/${rawName}` : rawName);
    pendingLongName = null;

    if (typeflag === 'L') {
      // GNU longname: body is the real name of the NEXT entry
      pendingLongName = body.toString('utf8').replace(/\0.*$/, '');
    } else if (typeflag === 'x' || typeflag === 'X') {
      // pax extended header: "<len> path=<value>\n" applies to NEXT entry
      const m = body.toString('utf8').match(/\d+ path=([^\n]+)\n/);
      if (m) pendingLongName = m[1];
    } else if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
      // Regular file. GitHub tarballs prefix every path with a root
      // dir ("owner-repo-shortsha/") — strip the first segment.
      const rel = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
      const looksBinary = body.subarray(0, 8192).includes(0);
      if (rel && size <= MAX_FILE_BYTES && !looksBinary) {
        files.set(rel, body.toString('utf8'));
      }
    }
    // 'g' (pax global), '5' (dir), symlinks etc.: skip body

    offset = dataStart + size + ((512 - (size % 512)) % 512);
  }
  return files;
}

async function fetchRepoFiles(repo: string, ref: string): Promise<Map<string, string>> {
  const key = `${repo}@${ref}`;
  const cached = TARBALL_CACHE.get(key);
  if (cached && Date.now() - cached.fetchedAt < TARBALL_TTL_MS) return cached.files;

  // Redirects to a signed codeload URL — fetch follows automatically.
  const res = await fetch(`${GITHUB_API}/repos/${repo}/tarball/${encodeURIComponent(ref)}`, {
    headers: getHeaders(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub tarball ${res.status}: ${text}`);
  }

  const gz = Buffer.from(await res.arrayBuffer());
  const tar = zlib.gunzipSync(gz);
  const files = parseTarEntries(tar);

  TARBALL_CACHE.set(key, { files, fetchedAt: Date.now() });
  if (TARBALL_CACHE.size > TARBALL_CACHE_MAX) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [k, v] of TARBALL_CACHE) {
      if (v.fetchedAt < oldestAt) {
        oldestAt = v.fetchedAt;
        oldestKey = k;
      }
    }
    if (oldestKey) TARBALL_CACHE.delete(oldestKey);
  }
  return files;
}

/**
 * Search code across the repo. Case-insensitive exact-substring grep
 * over the repo tarball (see v1.3 note above). Return shape is
 * backward compatible with the previous implementation:
 * { total_count, results: [{ file, path, url }] }. Additions: url
 * deep-links to the first matching line, match_count = matching line
 * count (results sorted by it, descending), and matches carries up to
 * 5 { line, text } snippets per file.
 */
export async function searchCode(query: string, repo?: string, ref = 'main'): Promise<unknown> {
  if (!query || !query.trim()) return { total_count: 0, results: [] };

  const r = getRepo(repo);
  const files = await fetchRepoFiles(r, ref);
  const needle = query.toLowerCase();

  const results: Array<{
    file: string;
    path: string;
    url: string;
    match_count: number;
    matches: SearchMatch[];
  }> = [];

  for (const [path, content] of files) {
    if (!content.toLowerCase().includes(needle)) continue;

    const lines = content.split('\n');
    const matches: SearchMatch[] = [];
    let matchCount = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        matchCount++;
        if (matches.length < MAX_MATCHES_PER_FILE) {
          matches.push({ line: i + 1, text: lines[i].trim().slice(0, MAX_LINE_LEN) });
        }
      }
    }

    results.push({
      file: path.split('/').pop() || path,
      path,
      url: `https://github.com/${r}/blob/${ref}/${path}#L${matches[0]?.line || 1}`,
      match_count: matchCount,
      matches,
    });
    if (results.length >= MAX_RESULT_FILES) break;
  }

  // Most-relevant (most matching lines) first
  results.sort((a, b) => b.match_count - a.match_count);

  return { total_count: results.length, results, search_method: 'tarball-grep', ref };
}
