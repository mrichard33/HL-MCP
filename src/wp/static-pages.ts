/**
 * WP Static Pages — src/wp/static-pages.ts
 *
 * Serves the four self-contained "Weakest Point" journey pages from
 * public/wp/. The HTML is finished and vendored verbatim — no templating.
 * index.html is ~2 MB (embedded images), so each file is cached in memory
 * with pre-built gzip/brotli variants and an ETag for 304 revalidation.
 *
 * Routes:
 *   GET /        -> public/wp/index.html  (film page)
 *   GET /find    -> public/wp/find.html   (Step 1, address)
 *   GET /unlock  -> public/wp/unlock.html (Step 2, details + contact)
 *   GET /report  -> public/wp/report.html (Step 3, report)
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip as gzipCb, brotliCompress as brotliCb, constants as zlibConstants } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const gzip = promisify(gzipCb);
const brotliCompress = promisify(brotliCb);

// dist/wp/static-pages.js -> ../../public/wp (= /app/public/wp in Docker)
const PAGES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'wp');

const PAGE_ROUTES: Record<string, string> = {
  '/': 'index.html',
  '/find': 'find.html',
  '/unlock': 'unlock.html',
  '/report': 'report.html',
};

interface CachedPage {
  identity: Buffer;
  gzip: Buffer;
  br: Buffer;
  etag: string;
}

const pageCache = new Map<string, Promise<CachedPage>>();

async function loadPage(filename: string): Promise<CachedPage> {
  const identity = await readFile(resolve(PAGES_DIR, filename));
  // Brotli quality 5: near-instant even on the 2 MB index page; quality 11
  // takes seconds and the win over gzip is marginal on base64-heavy HTML.
  const [gz, br] = await Promise.all([
    gzip(identity),
    brotliCompress(identity, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }),
  ]);
  const etag = `"${createHash('sha256').update(identity).digest('hex').slice(0, 24)}"`;
  return { identity, gzip: gz, br, etag };
}

function getPage(filename: string): Promise<CachedPage> {
  let cached = pageCache.get(filename);
  if (!cached) {
    cached = loadPage(filename);
    // Drop failed loads so a transient read error doesn't poison the cache
    cached.catch(() => pageCache.delete(filename));
    pageCache.set(filename, cached);
  }
  return cached;
}

/** Pre-compress all four pages at boot so first visitors skip the work. */
export function warmWpPages(): void {
  for (const filename of Object.values(PAGE_ROUTES)) {
    void getPage(filename).catch((err) => {
      console.error(`[wp-pages] warm failed for ${filename}:`, err instanceof Error ? err.message : err);
    });
  }
}

function pickEncoding(acceptEncoding: string): 'br' | 'gzip' | 'identity' {
  // Cheap containment check is enough — beacons/browsers send well-formed values
  if (/\bbr\b/.test(acceptEncoding)) return 'br';
  if (/\bgzip\b/.test(acceptEncoding)) return 'gzip';
  return 'identity';
}

export async function serveWpPage(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const filename = PAGE_ROUTES[pathname];
  if (!filename) return false;

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return true;
  }

  let page: CachedPage;
  try {
    page = await getPage(filename);
  } catch (err) {
    console.error(`[wp-pages] failed to load ${filename}:`, err instanceof Error ? err.message : err);
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return true;
  }

  const headers: Record<string, string | number> = {
    'Content-Type': 'text/html; charset=utf-8',
    // Short max-age: these files will be iterated; ETag handles revalidation
    'Cache-Control': 'public, max-age=60',
    ETag: page.etag,
    Vary: 'Accept-Encoding',
  };

  if (req.headers['if-none-match'] === page.etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }

  const encoding = pickEncoding(String(req.headers['accept-encoding'] ?? ''));
  const body = encoding === 'br' ? page.br : encoding === 'gzip' ? page.gzip : page.identity;
  if (encoding !== 'identity') headers['Content-Encoding'] = encoding;
  headers['Content-Length'] = body.length;

  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}
