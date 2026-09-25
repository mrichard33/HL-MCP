/**
 * src/extractor/workflow-refresh.ts
 *
 * Refresh ONE workflow from GHL and rebuild its cached detail rows.
 *
 * 2026-09-25: moved here out of the refresh_workflow tool handler so the
 * nightly freshness job (workflow-nightly-refresh.ts) runs exactly the same
 * code as a manual refresh. On 2026-09-24 sync_workflow_intelligence refreshed
 * 266 workflows and rebuilt 0 steps; only this path was verified to rebuild
 * them (A.WE-1 → version 169, 231 steps). Two copies of it would drift, and
 * the one that drifted would be the one nobody runs by hand.
 *
 * One addition over the old handler: when the step rows really were rebuilt,
 * the workflow's `last_refreshed_version` is stamped. That column is what the
 * nightly job compares against GHL's live version, so a manual refresh counts
 * toward freshness too.
 */

import { GHLClient } from '../clients/ghl.js';
import { getSupabaseClient } from '../clients/supabase.js';
import {
  buildWorkflowDetailFromInternalJson,
  syncWorkflowDetailToSupabase,
  shouldRebuildWorkflowDetail,
  DEEP_WORKFLOW_SOURCE,
} from './workflow-extractor.js';
import { nowET } from '../utils/timezone.js';
import type { GHLWorkflow } from '../types/ghl.js';

type SupabaseLike = { from: (table: string) => any };

export interface RefreshWorkflowDeps {
  ghl?: GHLClient;
  supabase?: SupabaseLike;
  /**
   * The workflow's entry from the location list, when the caller already has
   * it. Saves a second full list call on the shallow fallback path.
   */
  listEntry?: GHLWorkflow;
}

export interface RefreshWorkflowResult {
  workflow_id: string;
  name: string;
  status: string;
  version: number;
  source: string;
  cache_updated: true;
  preserved_existing_raw_json: boolean;
  steps_rebuilt: boolean;
  steps_rebuilt_reason: string | null;
  steps_synced: number | null;
  triggers_synced: number | null;
  actions_synced: number | null;
  connections_synced: number | null;
  detail_errors: string[];
  /** True when last_refreshed_version was written for this refresh. */
  version_recorded: boolean;
  version_record_error: string | null;
  refreshed_at: string;
  raw_json_top_level_keys: string[];
}

export async function refreshSingleWorkflow(
  workflowId: string,
  deps: RefreshWorkflowDeps = {},
): Promise<RefreshWorkflowResult> {
  const ghl = deps.ghl ?? new GHLClient();
  const supabase = deps.supabase ?? getSupabaseClient();

  // Deep workflow detail comes from the Firebase-authenticated internal
  // API (backend.leadconnectorhq.com). Returns null when Firebase auth
  // isn't configured or the internal call fails.
  const detail = await ghl.getWorkflowDetail(workflowId);

  let rawJson: Record<string, unknown>;
  let source: string;

  if (detail) {
    rawJson = detail;
    source = DEEP_WORKFLOW_SOURCE;
  } else {
    // FIX: GHL's public API v2 has NO `GET /workflows/{id}` endpoint —
    // only the location list endpoint `GET /workflows/?locationId=...`.
    // The previous fallback called ghl.getWorkflow(id), which hit
    // /workflows/{id} and always 404'd. Resolve via the list instead.
    const match = deps.listEntry && deps.listEntry.id === workflowId
      ? deps.listEntry
      : (await ghl.getWorkflows()).find((w) => w.id === workflowId);
    if (!match) {
      throw new Error(
        `Workflow ${workflowId} not found in GHL location ${ghl.getLocationId()}. ` +
        `It may have been deleted or the ID may be wrong. ` +
        `(GHL's public API has no single-workflow endpoint, so the location workflow ` +
        `list was searched. To capture deep detail — steps, triggers, actions — set ` +
        `GHL_FIREBASE_API_KEY and GHL_FIREBASE_REFRESH_TOKEN to enable the internal API.)`
      );
    }
    rawJson = JSON.parse(JSON.stringify(match)) as Record<string, unknown>;
    source = 'highlevel_public_api_list';
  }

  const name = (rawJson.name as string) || 'Unknown';
  const status = (rawJson.status as string) || 'unknown';
  const version = (rawJson.version as number) || 1;
  const locationId = (rawJson.locationId as string) || ghl.getLocationId();

  // Columns that are always safe to write from whichever source resolved.
  const row: Record<string, unknown> = {
    ghl_workflow_id: workflowId,
    ghl_location_id: locationId,
    name,
    status,
    version,
    synced_at: nowET(),
    deleted_at: null,
  };

  // raw_json handling: a shallow list-based refresh must never DOWNGRADE a
  // richer raw_json already cached (e.g. one captured by a prior internal-API
  // sync with steps/triggers/actions). The deep-detail path always writes;
  // the shallow path only writes raw_json when the cache has nothing richer.
  let preservedExistingRawJson = false;
  if (source === DEEP_WORKFLOW_SOURCE) {
    row.raw_json = rawJson;
  } else {
    const { data: existing } = await supabase
      .from('workflows')
      .select('raw_json')
      .eq('ghl_workflow_id', workflowId)
      .maybeSingle();
    const existingRaw = (existing?.raw_json || {}) as Record<string, unknown>;
    if (Object.keys(existingRaw).length > Object.keys(rawJson).length) {
      preservedExistingRawJson = true;
    } else {
      row.raw_json = rawJson;
    }
  }

  const { error: upsertError } = await supabase
    .from('workflows')
    .upsert(row, { onConflict: 'ghl_workflow_id' });

  if (upsertError) {
    throw new Error(`Failed to update cache: ${upsertError.message}`);
  }

  // Rebuild the detail rows — workflow_steps, workflow_connections,
  // workflow_triggers, workflow_actions.
  //
  // 2026-09-14: this used to write ONLY the workflows row. raw_json went
  // current while the step rows kept whatever the last full sync captured,
  // and every reader of workflow_steps (get_workflow_steps without
  // forceLive, src/analysis/detectors.ts, src/analysis/graph.ts, any direct
  // query) silently answered from pre-edit structure with no staleness
  // signal. On cca1f069-9524-4e57-8ebd-d1184704aa39 the cache sat two
  // structural revisions behind — 11 steps against 25 live — and produced
  // two wrong diagnostic answers in one session.
  //
  // Only the internal-API path carries step data. The public list fallback
  // is metadata only, so rebuilding from it would delete good rows and
  // replace them with nothing. steps_rebuilt tells the caller which
  // happened, so "rebuilt, zero steps" is distinguishable from
  // "not rebuilt".

  // Parse only on the deep path — the shallow payload has nothing to parse,
  // and buildWorkflowDetailFromInternalJson costs a backend trigger call.
  const built = source === DEEP_WORKFLOW_SOURCE
    ? await buildWorkflowDetailFromInternalJson(rawJson, { id: workflowId }, { ghl })
    : null;

  const gate = shouldRebuildWorkflowDetail(
    source,
    built ? (built.workflowDetail.steps?.length || 0) : null,
  );

  let detailCounts: { steps: number; triggers: number; actions: number; connections: number; errors: string[] } | null = null;
  if (gate.rebuild && built) {
    detailCounts = await syncWorkflowDetailToSupabase(built.workflowDetail, built.parsedConnections, { client: supabase });
  }

  // detail_hash is deliberately NOT written here. The next full sync then
  // sees a hash mismatch and rebuilds this workflow — a redundant rebuild,
  // never a skipped one. That is the safe direction to be wrong in.

  // Stamp last_refreshed_version only when the rows really are current: a
  // rebuild that ran AND wrote without error. A rebuild with insert errors may
  // have left the steps table empty for this workflow; stamping it would tell
  // the nightly job the cache is fresh and it would never look again. Leaving
  // it unstamped means the next night retries — the safe direction.
  let versionRecorded = false;
  let versionRecordError: string | null = null;
  if (gate.rebuild && detailCounts && detailCounts.errors.length === 0) {
    const { error } = await supabase
      .from('workflows')
      .update({ last_refreshed_version: version })
      .eq('ghl_workflow_id', workflowId);
    if (error) {
      // Most likely migration 018 is not applied yet. The refresh itself
      // still succeeded, so report rather than throw.
      versionRecordError = error.message;
    } else {
      versionRecorded = true;
    }
  }

  return {
    workflow_id: workflowId,
    name,
    status,
    version,
    source,
    cache_updated: true,
    preserved_existing_raw_json: preservedExistingRawJson,
    steps_rebuilt: gate.rebuild,
    steps_rebuilt_reason: gate.reason,
    steps_synced: detailCounts ? detailCounts.steps : null,
    triggers_synced: detailCounts ? detailCounts.triggers : null,
    actions_synced: detailCounts ? detailCounts.actions : null,
    connections_synced: detailCounts ? detailCounts.connections : null,
    detail_errors: detailCounts ? detailCounts.errors : [],
    version_recorded: versionRecorded,
    version_record_error: versionRecordError,
    refreshed_at: nowET(),
    raw_json_top_level_keys: Object.keys(rawJson),
  };
}
