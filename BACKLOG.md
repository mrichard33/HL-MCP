# HL MCP / Action Executor — Backlog

Running list of executor improvements, gaps, and follow-ups identified during live operation.

---

## Open

### 1. Native `create_opportunity` action handler

**Status:** Open
**Identified:** 2026-04-29 (Jim Riddle CXL rescue, action 28844)
**Priority:** Medium

The Action Executor v4.0 currently supports these action types:
`update_contact`, `move_opportunity`, `add_tag`, `remove_tag`, `add_to_workflow`, `remove_from_workflow`, `send_message`, `create_task`, `send_notification`.

It does **not** have a native `create_opportunity` handler. This is the same gap that hit us earlier when spawning P3 reactivation opps from the loss intelligence flow — agents have to either fall back to `create_task` as a proxy (loses the intent in the action queue) or the change has to be made out-of-band via direct HL MCP `create_opportunity` calls (loses the audit trail and the rollback hook).

**Concrete case:** Jim Riddle (`lbhonQ5MpyKume0fKRWM`) — CXL on 2026-04-04, batch `jim-riddle-cxl-rescue-2026-04-29`, action 28844 had to be queued as `create_task` because the executor cannot spawn the P3 opportunity at Stage 6 (Reactivation Queue) natively.

**Why it matters:**

- Loss intelligence flow (WF1 Loss Router → WF2 Loss Reason Recovery) is supposed to spawn P3 opps automatically on every soft loss. Without a native handler, every soft loss requires manual P3 creation or a workaround.
- The `create_task` proxy bypasses the executor's payload validation, rollback registration, and attribution logging.
- This is the bottleneck on full agentic P1↔P3 rebalancing.

**Proposed implementation:**

```ts
// src/executor/actions/create-opportunity.ts
{
  action_type: "create_opportunity",
  payload: {
    name: string,
    pipelineId: string,
    stageId: string,
    contactId: string,
    status?: "open" | "won" | "lost" | "abandoned",
    monetaryValue?: number,
    source?: string,
    customFields?: Array<{ id: string; field_value: string | number | boolean }>
  },
  rollback_payload: {
    opportunityId: string  // delete or set to abandoned on rollback
  }
}
```

Mirrors the `HL MCP:create_opportunity` tool signature so the agent rule schema stays consistent.

**Acceptance criteria:**

- `create_opportunity` accepted as a valid `action_type` in `agent_actions` table
- Executor handler creates the opp, captures the new `opportunityId` into the action's `result_payload`
- Rollback path: set the new opp to `abandoned` (don't hard-delete — preserves audit)
- Approval tier: defaults to `notify` (not auto) since opp creation has revenue-tracking implications

**Related:**

- WF1 Loss Router workflow `6dfb7300`
- P3 Reactivation Queue stage: `fda5f000-19a7-420f-935a-f1f2de0c7675`
- See also: action 28844 in `agent_actions` table for the proxied case
