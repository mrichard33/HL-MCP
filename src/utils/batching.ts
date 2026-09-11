/**
 * Batching + pagination constants shared by every sync path.
 *
 * These lived as module-private values in src/extractor/entity-syncer.ts, which
 * meant template-syncer.ts and workflow-extractor.ts each grew their own
 * hand-rolled slicing loops with different (or no) limits. Both limits below are
 * properties of PostgREST, not of any one entity, so they belong in one place.
 */

/**
 * Rows per bulk upsert. 500 is well under PostgREST's default 1000-row limit and
 * keeps any single request under ~5MB of JSON.
 *
 * Also used to size `.in(...)` prefetch batches: PostgREST serialises `.in()`
 * into the URL query string, and an unchunked list of 20k+ ids produces a URL
 * far past the server's limit.
 */
export const UPSERT_BATCH_SIZE = 500;

/**
 * PostgREST caps a single query result at 1000 rows by default. Any `.select()`
 * that can return more than that MUST page with `.range()` or it silently
 * truncates — the failure mode that made softDeleteMissing inert on the 21k
 * opportunities and 22k contacts tables.
 */
export const PAGINATION_PAGE_SIZE = 1000;

/** Split an array into batches of at most `size`. */
export function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}
