/**
 * Regression: the branch filter must not hide real work, and the PR
 * overlap intersection must not report the wrong pairs.
 *
 * Both are pure, and both fail SILENTLY if wrong — a bad intersection
 * returns a confident, plausible, incorrect list of colliding PRs, and
 * an over-eager backup filter hides real branches while reporting a
 * clean list. Neither throws. That is why they are pinned here.
 *
 * Context: listBranches was a single `?per_page=100` with no page loop
 * and no truncation flag. LP-MCP carries ~93 daily bk-MM-DD-YYYY backup
 * branches, which consumed the page and cut the list off alphabetically
 * partway through claude/* — main and every feat/ and fix/ branch fell
 * off the end, silently. Fixed in github-client.ts v1.4; the filter that
 * came with the fix is what these tests guard.
 *
 * Runs against the BUILT module, so `npm run build` must precede it —
 * `npm test` chains both. Both helpers are pure and open no connections.
 */
import { test } from 'node:test';
import assert from 'node:assert';

import { isBackupBranch, computeOverlaps } from '../dist/admin/github-client.js';

const set = (...paths) => new Set(paths);
const pr = (number, title = `PR ${number}`, head = `feat/${number}`) => ({ number, title, head });

test('isBackupBranch matches the daily backup format', () => {
  assert.equal(isBackupBranch('bk-06-03-2026'), true);
  assert.equal(isBackupBranch('bk-12-31-2026'), true);
  assert.equal(isBackupBranch('BK-06-03-2026'), true, 'case-insensitive');
});

test('isBackupBranch does NOT swallow real branches that start with bk', () => {
  // The filter exists to hide noise. Hiding real work would be worse
  // than the noise it removes, so the pattern is anchored and exact.
  // backfill-coverage-probe is a real branch in LP-MCP.
  assert.equal(isBackupBranch('bk-fix/something'), false);
  assert.equal(isBackupBranch('backfill-coverage-probe'), false);
  assert.equal(isBackupBranch('bk-06-03-2026-hotfix'), false);
  assert.equal(isBackupBranch('feat/bk-06-03-2026'), false);
  assert.equal(isBackupBranch('main'), false);
  assert.equal(isBackupBranch('dev'), false);
  assert.equal(isBackupBranch('bk-6-3-2026'), false, 'wrong width');
});

test('isBackupBranch tolerates missing input', () => {
  assert.equal(isBackupBranch(undefined), false);
  assert.equal(isBackupBranch(null), false);
  assert.equal(isBackupBranch(''), false);
});

test('no shared files means no collision', () => {
  const { collisions, clean } = computeOverlaps([
    { pr: pr(1), files: set('src/a.ts') },
    { pr: pr(2), files: set('src/b.ts') },
  ]);
  assert.equal(collisions.length, 0);
  assert.deepEqual(clean.map((c) => c.number), [1, 2]);
});

test('a shared file is reported once, with the path named', () => {
  const { collisions, clean } = computeOverlaps([
    { pr: pr(822, 'capacity ranker cycle'), files: set('src/capacity/applyDialPriority.js', 'src/routes/capacityRanker.js') },
    { pr: pr(825, 'restart verify timing'), files: set('src/capacity/applyDialPriority.js', 'scripts/test-capacity-ranker.js') },
  ]);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].pr_a.number, 822);
  assert.equal(collisions[0].pr_b.number, 825);
  assert.equal(collisions[0].shared_file_count, 1);
  assert.deepEqual(collisions[0].shared_files, ['src/capacity/applyDialPriority.js']);
  assert.equal(clean.length, 0, 'both collided, so neither is clean');
});

test('every colliding pair is emitted, not just the first', () => {
  // Three PRs on one file is three pairs, not one cluster. Collapsing
  // them would hide which specific pair to open.
  const { collisions } = computeOverlaps([
    { pr: pr(1), files: set('shared.ts') },
    { pr: pr(2), files: set('shared.ts') },
    { pr: pr(3), files: set('shared.ts') },
  ]);
  assert.equal(collisions.length, 3);
  const pairs = collisions.map((c) => [c.pr_a.number, c.pr_b.number]).sort();
  assert.deepEqual(pairs, [[1, 2], [1, 3], [2, 3]]);
});

test('pairs sort by shared-file count, worst first', () => {
  const { collisions } = computeOverlaps([
    { pr: pr(1), files: set('a.ts', 'b.ts', 'c.ts') },
    { pr: pr(2), files: set('a.ts') },
    { pr: pr(3), files: set('a.ts', 'b.ts', 'c.ts') },
  ]);
  assert.equal(collisions[0].shared_file_count, 3);
  assert.deepEqual([collisions[0].pr_a.number, collisions[0].pr_b.number], [1, 3]);
});

test('a PR overlapping one sibling but not another is not listed as clean', () => {
  const { collisions, clean } = computeOverlaps([
    { pr: pr(1), files: set('a.ts') },
    { pr: pr(2), files: set('a.ts') },
    { pr: pr(3), files: set('z.ts') },
  ]);
  assert.equal(collisions.length, 1);
  assert.deepEqual(clean.map((c) => c.number), [3]);
});

test('shared_files is sorted so the same pair reads identically every run', () => {
  const { collisions } = computeOverlaps([
    { pr: pr(1), files: set('z.ts', 'a.ts', 'm.ts') },
    { pr: pr(2), files: set('m.ts', 'z.ts', 'a.ts') },
  ]);
  assert.deepEqual(collisions[0].shared_files, ['a.ts', 'm.ts', 'z.ts']);
});

test('single PR, empty list, and a fileless PR all return rather than throw', () => {
  const single = computeOverlaps([{ pr: pr(1), files: set('a.ts', 'b.ts') }]);
  assert.equal(single.collisions.length, 0);
  assert.deepEqual(single.clean, [{ number: 1, title: 'PR 1', files: 2 }]);

  const empty = computeOverlaps([]);
  assert.deepEqual(empty.collisions, []);
  assert.deepEqual(empty.clean, []);

  // GitHub can report an empty file list for an empty or reverted PR.
  const fileless = computeOverlaps([
    { pr: pr(1), files: set() },
    { pr: pr(2), files: set('a.ts') },
  ]);
  assert.equal(fileless.collisions.length, 0);
  assert.deepEqual(fileless.clean.map((c) => c.number), [1, 2]);
});
