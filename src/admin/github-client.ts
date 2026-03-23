/**
 * GitHub REST API v3 wrapper for the HL MCP repository.
 */

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

function getRepo(): string {
  const repo = process.env.GITHUB_REPO;
  if (!repo) throw new Error('Missing GITHUB_REPO environment variable (format: owner/repo)');
  return repo;
}

async function api(path: string, options: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: { ...getHeaders(), ...(options.headers as Record<string, string> || {}) },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status}: ${text}`);
  }
  return res.json();
}

export async function listFiles(path = '', branch?: string): Promise<unknown> {
  const repo = getRepo();
  let url = `/repos/${repo}/contents/${path}`;
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
      : data, // single file case
  };
}

export async function getFile(
  path: string,
  branch?: string
): Promise<{ content: string; sha: string; size: number; path: string }> {
  const repo = getRepo();
  let url = `/repos/${repo}/contents/${path}`;
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
  sha?: string
): Promise<unknown> {
  const repo = getRepo();
  const body: Record<string, unknown> = {
    message,
    content: Buffer.from(content).toString('base64'),
  };
  if (branch) body.branch = branch;
  if (sha) body.sha = sha;

  const data = await api(`/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return data;
}

export async function getRecentCommits(branch?: string, limit = 10): Promise<unknown> {
  const repo = getRepo();
  let url = `/repos/${repo}/commits?per_page=${Math.min(limit, 30)}`;
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

export async function createBranch(branchName: string, fromBranch = 'main'): Promise<unknown> {
  const repo = getRepo();
  // Get the SHA of the source branch
  const refData = (await api(`/repos/${repo}/git/ref/heads/${encodeURIComponent(fromBranch)}`)) as {
    object: { sha: string };
  };
  // Create the new branch
  const data = await api(`/repos/${repo}/git/refs`, {
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
  body?: string
): Promise<unknown> {
  const repo = getRepo();
  const data = (await api(`/repos/${repo}/pulls`, {
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

export async function searchCode(query: string): Promise<unknown> {
  const repo = getRepo();
  const q = encodeURIComponent(`${query} repo:${repo}`);
  const data = (await api(`/search/code?q=${q}`)) as {
    total_count: number;
    items: Array<{ name: string; path: string; html_url: string }>;
  };
  return {
    total_count: data.total_count,
    results: data.items.map((item) => ({
      file: item.name,
      path: item.path,
      url: item.html_url,
    })),
  };
}
