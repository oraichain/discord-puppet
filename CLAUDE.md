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
| `DISCORD_USER_DATA_DIR` | `.discord-user-data` | Directory where Chromium stores login session, cookies, and browser profile. Can be reused across runs to skip login/captcha. |
| `HEADLESS` | `false` | Set to `"true"` to run in headless mode (server); `"false"` for visible browser window (development). |

---

## Running

**Local development:**
```bash
ts-node uma-selfbot.ts
```

**Headless server (first time):**
1. Run locally with `HEADLESS=false` to open a visible browser window, log in manually, and solve any captcha if prompted:
   ```bash
   HEADLESS=false ts-node uma-selfbot.ts
   ```
2. On subsequent server runs, set `HEADLESS=true` and reuse the saved session directory (see **Bypassing captcha on server** section below).

**With custom lookback window:**
```bash
THREAD_LOOKBACK_DAYS=120 ts-node uma-selfbot.ts
```

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

The code detects readiness by waiting for:
1. URL change (full navigation), OR
2. Increase in `ol[data-list-id="chat-messages"]` count (side panel opens), OR
3. Change in the second ol's channelId (panel swaps to a different thread while olCount stays at 2).

A 3-second fallback handles edge cases where none of these signals fire.

### Two `ol[data-list-id="chat-messages"]` elements and scoping
When the thread side panel is open, there are two `ol` elements in the DOM:
1. **First `ol`**: the channel list (thread stubs with "Open Thread" buttons).
2. **Second `ol`**: the thread side panel (actual thread messages).

**Critical**: all queries that interact with the channel list MUST target the **first `ol` only**, because:
- `li` elements have the same `id` format in both ols (e.g., `chat-messages-964000735073284127-1500776617969193100`).
- Global selectors like `li[id="..."]` without an ol prefix will match elements in either ol, causing clicks to hit the wrong element or queries to mix data from both lists.

Implementation:
- `collectDisputeChannelThreadRows`: uses `querySelector()` to get the first ol, then queries its children only.
- `openDisputeThreadFromListItem`: uses `page.evaluate` to find the button inside the first ol specifically, then clicks it via DOM `el.click()`.
- `disputeChannelListPastLookbackCutoff`: scopes to the first ol's children.
- `scrollChannelThreadListOlder`: explicitly targets the first ol to avoid scrolling the side panel.
- Thread message collection (`scrapeThreadMessagesSince`, `scrollThreadChatOlder`, `scrollThreadToBottom`): identify the correct ol (which contains the thread) by scanning for `li[id^="chat-messages-{threadChannelId}-"]`.

### Thread channelId detection (`detectThreadChannelId`)
The thread channelId (used for message filtering and deduplication) is detected from the DOM with priority to the URL, because:
- When a thread opens as a side panel, the URL may not update.
- Legacy 4-segment URLs (`/channels/{guild}/{parentChannel}`) return the parent channel ID, which is wrong for filtering.
- When 2 ols exist (side panel open), the thread panel's `li` elements are in the second ol — not the first.

Detection strategy (in order):
1. Extract parent channel ID from the URL (always segment index 2 in `/channels/{guild}/{parentChannel}/...`).
2. If URL has `/threads/{id}` and that ID differs from the parent, use it directly (most reliable, fastest path).
3. If 2+ ols exist (side panel open):
   - Wait up to 5 seconds for the second ol to have at least one message `li`.
   - Scan only the second ol's `li` elements and collect distinct channelIds.
   - Pick the first non-parent channelId (the thread's channelId).
4. If only 1 ol exists (full-page thread navigation):
   - Scan all message `li` elements and pick the non-parent channelId.
5. Fallback: URL-based detection (may be "" for plain channel view).

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

### Scroll termination: lookback cutoff
The outer loop scrolls older after each batch. It stops when `disputeChannelListPastLookbackCutoff` returns `true`, meaning all visible thread stubs have timestamps older than the lookback window. The loop runs indefinitely (no idle counter) — the only stop condition is reaching the lookback cutoff date or an error.

Note: When threads are already processed (saved in previous runs), new rows are still collected from the visible list but skipped via dedup checks. The presence of "already processed" rows does not trigger early exit — the loop only stops based on the lookback cutoff.

### Scroll step size
The outer loop calls `scrollChannelThreadListOlder()` which scrolls the first ol upward by 30% of its viewport height per scroll step. This overlap (70% of previous visible window stays visible) ensures no threads are skipped between consecutive `collectDisputeChannelThreadRows` calls.

---

## Bypassing captcha on server

Discord may prompt for human verification (hCaptcha) during login if it detects suspicious activity. Rather than automating captcha solving (which is error-prone and expensive), the simplest approach is to **reuse an authenticated browser session** across runs:

### Strategy: Session persistence

1. **First run (local, interactive)**:
   - Run with `HEADLESS=false` so you can see and interact with the browser:
     ```bash
     HEADLESS=false ts-node uma-selfbot.ts
     ```
   - The browser will open. Log in manually using your Discord credentials.
   - If a captcha appears, solve it manually in the visible browser.
   - The login session is automatically saved to the `DISCORD_USER_DATA_DIR` (default: `.discord-user-data/`).
   - Let the script run to completion (it will scrape threads and save JSON files).

2. **Subsequent server runs**:
   - Copy the `.discord-user-data/` directory from your local machine to the server (e.g., via `scp`, git, or ZIP upload):
     ```bash
     # Local:
     zip -r discord-user-data.zip .discord-user-data/
     # Upload to server, then on server:
     unzip discord-user-data.zip
     ```
   - Run the script on the server with `HEADLESS=true`:
     ```bash
     HEADLESS=true ts-node uma-selfbot.ts
     ```
   - The browser will reuse the saved session, bypass login entirely, and skip any captcha prompt.

### Why this works

- `puppeteer-extra-plugin-user-data-dir` persists Chromium's user profile directory, which includes:
  - Login cookies and session tokens.
  - Local storage and IndexedDB data (where Discord stores some state).
  - Browser cache and profile metadata.
- Discord recognizes the returning session and does not re-prompt for captcha.
- The stealth plugin (`puppeteer-extra-plugin-stealth`) masks automation signals, further reducing captcha triggers.

### When to refresh the session

If the Discord session expires (e.g., after 30+ days of inactivity), you'll need to repeat the local login step to generate a fresh `.discord-user-data/` directory. On re-login, any new captcha can be solved manually with `HEADLESS=false`.
