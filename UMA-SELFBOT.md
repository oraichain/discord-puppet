# UMA Dispute Thread Scraper (`uma-selfbot.ts`)

Scrapes messages from UMA's `dispute-threads` Discord channel and saves each thread as a JSON file under `uma-threads/`.

---

## Navigation flow (non-technical)

1. Log in to Discord using a real user account (not a bot token).
2. Click the UMA server in the left sidebar.
3. Click the `dispute-threads` channel.
4. Scroll the thread list to the bottom (newest threads first).
5. For each visible thread in the lookback window:
   - Click "Open Thread" on the list item → the thread opens (either as a side panel on the right, or full navigation to the thread page).
   - Scroll the thread to the bottom to ensure the newest messages are visible.
   - Scroll up repeatedly to load older messages until hitting the lookback cutoff.
   - Save all collected messages to a JSON file in `uma-threads/`.
6. After processing all visible threads, scroll the thread list older to reveal more threads.
7. Stop when all visible threads are older than the lookback window, or after 6 consecutive scrolls with no new threads found.

---

## Functional requirements

- **Lookback window**: configurable via `THREAD_LOOKBACK_DAYS` env var (default: 1). Only threads with activity within this window are scraped; only messages newer than `Date.now() - LOOKBACK_DAYS * 24h` are saved.
- **Idempotency / skip logic**: on startup, all existing `uma-threads/*.json` files are loaded. A thread is skipped if:
  1. Its title + activity timestamp already matches a saved file (`rowKey` match), OR
  2. Its thread channelId (detected from DOM) already matches a saved file (`threadId` match).
- **Output format**: one JSON file per thread, named `{sanitized-title}_{date}.json`. If a filename conflicts, a numeric suffix is appended (`_1`, `_2`, …).
- **Output schema** (`ThreadExportFile`):
  ```json
  {
    "threadId": "<Discord snowflake of the thread channel>",
    "title": "<thread title from the list>",
    "url": "<Discord URL at time of scrape>",
    "activityFromList": "<ISO timestamp from the list stub>",
    "scrapedAt": "<ISO timestamp of scrape>",
    "newerThan": "<ISO timestamp of lookback cutoff>",
    "messages": [
      {
        "messageId": "<Discord snowflake>",
        "channelId": "<thread channelId>",
        "author": "<username or undefined>",
        "timestamp": "<ISO datetime>",
        "content": "<text content or null>",
        "imageUrl": "<attachment URL or null>"
      }
    ]
  }
  ```
- **Human-like behavior**: random sleep pauses between actions (`humanSleepReading`) to avoid rate-limiting.
- **No bot token**: uses a real Discord user account (credentials via `DISCORD_USERNAME` / `DISCORD_PASSWORD` env vars).

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `DISCORD_USERNAME` | — | Discord account email |
| `DISCORD_PASSWORD` | — | Discord account password |
| `THREAD_LOOKBACK_DAYS` | `1` | How many days back to scrape threads and messages |

---

## Running

```bash
ts-node uma-selfbot.ts
```

To run headless, set `config.headless = true` in `uma-selfbot.ts` (line 77).

---

## Technical details and tricky behavior

### Discord's virtual DOM (list virtualization)
Discord only renders `li` elements for thread list items that are near the current scroll position. Items far from the viewport are removed from the DOM entirely. This means:
- A thread row collected by `collectDisputeChannelThreadRows` may no longer exist in the DOM by the time `openDisputeThreadFromListItem` tries to click it, if any scroll has happened in between.
- `scrollIntoView` only works when the element is in the DOM but off-screen. If it was recycled, it returns `null`.

### Thread opening: side panel vs. full navigation
When "Open Thread" is clicked, Discord may either:
- **Open a side panel** (right panel, 2nd `ol[data-list-id="chat-messages"]` appears, URL may or may not change).
- **Navigate to the thread page** (URL changes, single `ol` with thread messages replaces the channel list).

The code detects readiness by waiting for either a URL change or an increase in the number of `ol[data-list-id="chat-messages"]` elements. A 3-second fallback handles cases where neither signal fires (e.g. side panel swap with same ol count).

### Two `ol[data-list-id="chat-messages"]` elements
When the thread side panel is open, there are two `ol` elements in the DOM:
1. **First `ol`**: the channel list (thread stubs with "Open Thread" buttons).
2. **Last `ol`**: the thread side panel (actual thread messages).

Every method that queries messages or scrolls must target the correct `ol`:
- `scrollChannelThreadListOlder` explicitly targets the first `ol` to avoid scrolling the side panel.
- `scrapeThreadMessagesSince`, `scrollThreadChatOlder`, and `scrollThreadToBottom` identify the correct `ol` by scanning for `li[id^="chat-messages-{threadChannelId}-"]`.

### Thread channelId detection (`detectThreadChannelId`)
The thread channelId (used for message filtering and deduplication) is detected from the DOM, not from the URL, because:
- When a thread opens as a side panel, the URL may not update.
- Legacy 4-segment URLs (`/channels/{guild}/{parentChannel}`) return the parent channel ID from URL parsing, which is wrong.

Detection strategy:
1. Extract parent channel ID from the URL (always segment index 2 in `/channels/{guild}/{parentChannel}/...`).
2. If URL has `/threads/{id}` and that ID differs from the parent, use it directly.
3. Otherwise, scan all `li[id^="chat-messages-"]` across all `ol` elements and pick the channelId that differs from the parent.

### Message ID format
Every Discord message `li` element has `id="chat-messages-{channelId}-{messageId}"`. Parsing this gives both the channel the message belongs to and the message snowflake. Thread messages use the thread's own channelId (different from the parent channel), which is the key to filtering out parent-channel messages.

### Scrolling to collect all thread messages
When a thread opens, Discord renders from an arbitrary scroll position (not necessarily the bottom). The scraper:
1. First calls `scrollThreadToBottom` to ensure the newest messages are visible and collected.
2. Then enters a loop calling `scrollThreadChatOlder` to load progressively older messages.
3. Stops when the oldest visible message is before the lookback cutoff, or after 8 consecutive rounds with no new messages (up to 120 rounds max).

### `moreAboveCutoff` logic
The scroll loop checks whether the **first** (oldest) visible message in the thread panel is still within the lookback window. If it is, there may be older messages above that also need collecting, so it continues scrolling. Once the first message is older than the cutoff, it stops. This is checked on the thread panel's `ol`, not the channel list's `ol`.

### Deduplication: two levels
1. **`rowKey`** (`title + activityIso`): fast pre-check before even opening the thread. Avoids re-opening threads that are already saved based on their list-view metadata.
2. **`threadId`**: checked after opening the thread, using the channelId detected from the DOM. Catches cases where the same thread appears in the list under a slightly different activity timestamp.

### `scrollChannelThreadListToLatest` on startup
Called once at the start to scroll the thread list to the bottom (newest threads). Discord's thread list shows newest activity at the bottom in `dispute-threads`. This ensures the most recently active threads are visible first before collection starts.

### Idle scroll limit
The outer loop scrolls older after each batch. If 6 consecutive scroll rounds produce no new threads to process, the loop exits. This prevents infinite loops when the channel has very few threads in the lookback window.
