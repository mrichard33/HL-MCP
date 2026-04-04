# Conversation Sync Improvements

## Changes on `dev` Branch (Ready for Merge)

### 2026-04-04 — Fix: 71% of conversations missing messages

**Root Cause:** After switching from OAuth to API key auth on 2026-03-29, the `request()` method
had no 429 retry logic (only `requestWithOAuth()` did). During bulk sync, message fetches hit GHL
rate limits, silently failed, but the conversation's `synced_at` was already bumped — so the
round-robin scheduler moved on and never retried.

**Result:** 1,557 of 2,198 conversations (71%) had metadata but zero stored messages.

#### Commit 1: `src/clients/ghl.ts`
- **Added 429 retry logic to `request()` method** — 3 attempts with exponential backoff (2s, 4s, 8s)
- Matches existing `requestWithOAuth()` retry pattern
- All API callers (contacts, opps, conversations, messages) now benefit

#### Commit 2: `src/extractor/entity-syncer.ts`
- **Retry failed conversations:** On message fetch failure, reset `synced_at` to `'2000-01-01'`
  so the conversation is prioritized for retry in the next round-robin cycle
- **Reduced rate-limit pressure:**
  - `BATCH_SIZE`: 3 → 2 (fewer concurrent API calls per batch)
  - `BATCH_DELAY_MS`: 3000 → 5000 (more breathing room between batches)
  - `MAX_CONTACTS_PER_SYNC`: 500 → 300 (fewer contacts per 15-min cycle)
  - Added `INTER_CONV_DELAY_MS`: 1000ms pause between conversations within a contact
- **Better observability:** Logs message fetch failure count in sync summary

### Prior Changes (Already Merged to Main)

#### `src/clients/ghl.ts`
- Default `maxPages` in `getAllMessages()`: 5 → 20
- Conversations with long histories were being truncated

#### `src/tools/conversations.ts`
- `sync_conversations` no longer requires `contactId` — omitting it triggers the full bulk sync
- Imports `syncConversationsAndMessages` from entity-syncer for bulk mode
- Single-contact sync still works when contactId is provided

#### `src/extractor/entity-syncer.ts`
- `MAX_CONTACTS_PER_SYNC`: 200 → 500 (now adjusted to 300 in latest fix)
- `getAllMessages(conv.id, 5)` → `getAllMessages(conv.id, 20)` to match new default
