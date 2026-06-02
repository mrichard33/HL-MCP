# Architecture Boards — Reece Antifragile Sales System

The three living Mermaid architecture boards for the Antifragile Sales System. Each serves a different audience; **all three must stay synchronized** after any system change. Edit them with the `mermaid-board-architect` skill (it encodes the rendering rules, classDef library, and three-board sync discipline).

## The boards

| Board | File | Direction | Audience | Purpose |
|---|---|---|---|---|
| **A** | `Board_A_Revenue_Architecture_Blueprint_v5_18.mmd` | `flowchart LR` | Architect | Strategy, funnel position, buyer psychology, story-arc assignments, trust levels |
| **B** | `Board_B_Revenue_Automation_Engine_v6_18.mmd` | `flowchart LR` | Builder | GHL implementation: workflow names, step counts, triggers, tags, calendar IDs |
| **C** | `Board_C_Revenue_Operations_Playbook_v2_3.mmd` | `flowchart TD` | Sales/marketing team | Simplified operator-facing flow |

## Canonical naming rule (non-negotiable)

Boards reference workflows by **`canonical_code`** (`E.0`, `S1.1`, `S5.2`, `L.1`, `A.MV`, …) — **never** the legacy `W`-prefix names. The `workflow_registry` table (HL-MCP Supabase) is the source of truth; legacy `W`-names survive only as `workflow_registry.legacy_name` for archival lookup. When the registry and a board disagree, the registry wins — update the board.

`active-w*` **tags** are a separate GHL tag convention and are intentionally left as-is — they are not workflow-name references.

## Migration status

- **v5.18 / v6.18 (2026-06-02):** Board A (15 codes) and Board B (229 codes) migrated from `W`-prefix to canonical codes using the exact `workflow_registry.legacy_name → canonical_code` mapping (the W→S numbers are **not** 1:1 — e.g. `W2.1→S2.5`, `W6.0→S4.6`, `W7.0→S4.7`, `W10→S4.10`). Structure verified byte-stable (line/classDef/subgraph/edge counts unchanged). Board C had no `W`-codes (unchanged).
- **Open — unmapped codes:** `W5.0`, `W5.3`, `W6.1`, `W6.2`, `W6.4` have no `workflow_registry` entry and were **left untouched** pending classification. Resolve before considering the migration complete.
- **Open — brand pass:** boards still say "Review Session"; current brand is "Protection Profile Review." Separate content pass, not yet applied.

## Rendering

Paste a `.mmd` into [mermaid.live](https://mermaid.live) → download **SVG** (not PNG). For large-format printing, tile the SVG `viewBox` (Board A: 3–4 tiles landscape; Board B: 3 tiles landscape; Board C: 1–2 pages portrait). See the `mermaid-board-architect` skill for tiling details.

## Contributing

- **Branch discipline:** commit to `dev`, never `main`; open a PR `dev`→`main`. (Matches repo-wide rule.)
- **File size:** Boards A and B exceed the GitHub MCP write-tool limit (~35–48KB) — **commit/edit them via Claude Code or a manual commit, not the MCP `create_or_update_file` tool.** Board C (~27KB) is under the limit.
- **Version bumps:** increment the version in the filename on any modified board; keep all three in sync per the `mermaid-board-architect` checklist.
- **Sync check after edits:** Board A node names match Board B workflow names; Board B step counts match live MCP data; Board C reflects Board A's current structure.
