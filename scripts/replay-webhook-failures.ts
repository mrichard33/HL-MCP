#!/usr/bin/env npx tsx
/**
 * Replay dropped GHL tag webhooks — scripts/replay-webhook-failures.ts
 *
 * Recovers events recorded in webhook_failures for lp-mcp:/webhooks/ghl-tag.
 *
 * ── WHY THIS DOES NOT RE-POST THE STORED PAYLOAD ────────────────────
 * The obvious implementation — read each failed row, POST its payload back —
 * is actively destructive here, and the data says so.
 *
 * LP MCP's handler does not apply the payload; it DIFFS it against
 * contact_tag_snapshot and emits ghl.tag_added / ghl.tag_removed for the
 * difference. The stored payloads are stale snapshots, sometimes days stale.
 * Every one of the 24 contacts in the current 14-day window already has a
 * snapshot updated AFTER its failure — the state self-heals on the next
 * successful webhook — and in almost every case it now holds MORE tags than
 * the failed payload carried.
 *
 * Re-posting those payloads would therefore diff a small stale tag set
 * against a larger current one and emit the difference as REMOVALS. Measured
 * on 2026-08-29: contact ToVJqqPyr2Ef9HEFzcOo failed carrying 2-8 tags and
 * now holds 24, so a naive replay fires ~16-22 phantom tag_removed events at
 * a contact that has since closed won.
 *
 * ── WHAT IT DOES INSTEAD ────────────────────────────────────────────
 * Reconciles against live GHL. For each affected contact it fetches the
 * contact's CURRENT tags from GHL and posts those. The handler then diffs
 * live truth against the snapshot, so it can only emit genuine drift:
 *
 *   - snapshot already correct  → no diff, nothing emitted (the common case)
 *   - snapshot missing a tag    → a real tag_added, which is the recovery
 *   - snapshot holds a stale tag → a real tag_removed, correct by definition
 *
 * This is safe by construction rather than by care: there is no input under
 * which it can emit an event that does not reflect GHL right now.
 *
 * ── SCOPE ───────────────────────────────────────────────────────────
 * Hard-bounded to the last 14 days, in the query, not by a flag. Older tag
 * states are superseded; replaying them would fire stale automation against
 * contacts whose situation has since changed. The bound is not adjustable
 * from the command line on purpose.
 *
 * Usage:
 *   npx tsx scripts/replay-webhook-failures.ts                 # dry run
 *   npx tsx scripts/replay-webhook-failures.ts --limit 1 --execute
 *   npx tsx scripts/replay-webhook-failures.ts --execute
 *
 * Run --limit 1 first and verify that contact before the rest. That single-
 * event verification is a required control, not a suggestion.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const envPath = resolve(import.meta.dirname || '.', '..', '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!process.env[key]) process.env[key] = trimmed.slice(eqIdx + 1).trim();
  }
}

const { getSupabaseClient } = await import('../src/clients/supabase.js');
const { GHLClient } = await import('../src/clients/ghl.js');

/** The replay window. Deliberately a constant — see SCOPE above. */
const REPLAY_WINDOW_DAYS = 14;
const ENDPOINT = 'lp-mcp:/webhooks/ghl-tag';

interface Args { execute: boolean; limit: number | null }

function parseArgs(argv: string[]): Args {
  const args: Args = { execute: false, limit: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--execute') args.execute = true;
    else if (argv[i] === '--dry-run') args.execute = false;
    else if (argv[i] === '--limit') {
      const n = parseInt(argv[++i], 10);
      if (!Number.isFinite(n) || n < 1) throw new Error('--limit needs a positive integer');
      args.limit = n;
    }
  }
  return args;
}

interface FailureRow {
  id: string;
  created_at: string;
  error_message: string | null;
  payload: { contact_id?: string } | null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const supabase = getSupabaseClient();
  const ghl = new GHLClient();
  const lpBase = process.env.LP_MCP_BASE_URL || 'https://lp-mcp-production.up.railway.app';

  const since = new Date(Date.now() - REPLAY_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('webhook_failures')
    .select('id, created_at, error_message, payload')
    .eq('endpoint', ENDPOINT)
    .is('replayed_at', null)
    .gte('created_at', since)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`webhook_failures query failed: ${error.message}`);

  const rows = (data || []) as FailureRow[];

  // Group by contact: multiple failures for one contact are one reconcile.
  const byContact = new Map<string, FailureRow[]>();
  const orphaned: FailureRow[] = [];
  for (const row of rows) {
    const cid = row.payload?.contact_id;
    if (!cid) { orphaned.push(row); continue; }
    if (!byContact.has(cid)) byContact.set(cid, []);
    byContact.get(cid)!.push(row);
  }

  let contacts = [...byContact.keys()];
  if (args.limit !== null) contacts = contacts.slice(0, args.limit);

  console.log(`\nReplay scope — last ${REPLAY_WINDOW_DAYS} days, ${ENDPOINT}`);
  console.log(`  unreplayed rows:    ${rows.length}`);
  console.log(`  distinct contacts:  ${byContact.size}`);
  if (orphaned.length) console.log(`  rows with no contact_id: ${orphaned.length} (skipped)`);
  if (args.limit !== null) console.log(`  --limit ${args.limit} → reconciling ${contacts.length}`);
  console.log(`  mode:               ${args.execute ? 'EXECUTE' : 'DRY RUN (no writes)'}\n`);

  if (contacts.length === 0) {
    console.log('Nothing to replay.\n');
    return;
  }

  let reconciled = 0;
  let emitted = 0;
  let failed = 0;

  for (const contactId of contacts) {
    const rowsForContact = byContact.get(contactId)!;
    let liveTags: string[];

    try {
      const contact = await ghl.getContact(contactId);
      liveTags = (contact.tags || []) as string[];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A deleted contact has no tags to reconcile and never will. Leave
      // replayed_at NULL so it stays visible rather than looking recovered.
      console.error(`  ✗ ${contactId}: GHL fetch failed — ${msg}`);
      failed++;
      continue;
    }

    if (!args.execute) {
      console.log(
        `  · ${contactId}: would post ${liveTags.length} live tag(s), ` +
        `clearing ${rowsForContact.length} failure row(s)`,
      );
      reconciled++;
      continue;
    }

    try {
      const res = await fetch(`${lpBase}/webhooks/ghl-tag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contact_id: contactId,
          tags: liveTags,
          occurred_at: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '<no body>');
        throw new Error(`LP MCP returned ${res.status}: ${text}`);
      }
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;

      const { error: markErr } = await supabase
        .from('webhook_failures')
        .update({ replayed_at: new Date().toISOString() })
        .in('id', rowsForContact.map((r) => r.id));

      if (markErr) throw new Error(`replayed_at update failed: ${markErr.message}`);

      reconciled++;
      if (body.queued) emitted++;
      console.log(
        `  ✓ ${contactId}: posted ${liveTags.length} live tag(s), ` +
        `${rowsForContact.length} row(s) marked replayed`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ ${contactId}: ${msg}`);
      failed++;
    }
  }

  console.log(
    `\n${args.execute ? 'Replayed' : 'Would replay'}: ${reconciled} contact(s), ` +
    `${failed} failed.`,
  );
  if (args.execute) {
    console.log(
      'The tag work is queued in LP MCP\'s ghl_tag_inbox and runs on its next tick.\n' +
      'Zero new tag events is the expected outcome when the snapshot already\n' +
      'matches GHL — that is a pass, not a failure.\n',
    );
  } else {
    console.log('Re-run with --execute to commit. Start with --limit 1.\n');
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
