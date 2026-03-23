# Conversation Sync Improvements

## Changes Already Committed on This Branch

### 1. `src/clients/ghl.ts`
- **Default `maxPages` in `getAllMessages()`**: 5 → **20**
- Conversations with long histories were being truncated

### 2. `src/tools/conversations.ts`
- **`sync_conversations` no longer requires `contactId`** — omitting it triggers the full bulk sync
- Imports `syncConversationsAndMessages` from entity-syncer for bulk mode
- Single-contact sync still works when contactId is provided

## ⚠️ Manual Changes Required in `src/extractor/entity-syncer.ts`

These two changes could not be auto-committed (file too large for MCP tool). 
**Make these edits in the GitHub UI before merging:**

### Change 1: Increase contacts per sync batch (line ~292)

```diff
- const MAX_CONTACTS_PER_SYNC = 200; // Limit per run to avoid timeouts
+ const MAX_CONTACTS_PER_SYNC = 500; // Increased from 200 for faster backfill
```

### Change 2: Increase message pagination (line ~366, inside the for loop)

```diff
- const messageList = await ghl.getAllMessages(conv.id, 5);
+ const messageList = await ghl.getAllMessages(conv.id, 20);
```

**Why these matter:**
- `MAX_CONTACTS_PER_SYNC = 200` means backfill of 1,868 contacts takes 10+ runs (2.5+ hours)
- `getAllMessages(conv.id, 5)` explicitly overrides the new default of 20, truncating message history
