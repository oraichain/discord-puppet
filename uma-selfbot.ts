import { mkdir, writeFile, readdir, readFile } from "fs/promises"
import path from "path"
import { Puppet, options, DisputeThreadRow, ThreadExportFile } from "./index"
import { sanitizeThreadFileName } from "./src/utils/sanitize-filename"
import Option from "./src/interfaces/option.interface"
import "dotenv/config"

const OUTPUT_DIR = path.join(process.cwd(), "uma-threads")
/** How far back from now to read threads and messages (env THREAD_LOOKBACK_DAYS or default 1). */
const LOOKBACK_DAYS = Math.max(
    1,
    Number.parseInt(process.env.THREAD_LOOKBACK_DAYS || "1", 10) || 1,
)
const LOOKBACK_MS = LOOKBACK_DAYS * 24 * 60 * 60 * 1000

function buildBaseFileName(row: DisputeThreadRow): string {
    const datePart =
        row.activityIso != null && row.activityIso.length >= 10
            ? row.activityIso.slice(0, 10)
            : new Date().toISOString().slice(0, 10)
    return sanitizeThreadFileName(`${row.title}_${datePart}`)
}

function allocateFileName(base: string, used: Set<string>): string {
    let candidate = `${base}.json`
    let i = 1
    while (used.has(candidate)) {
        candidate = `${base}_${i++}.json`
    }
    used.add(candidate)
    return candidate
}

/** Stable key matching saved ThreadExportFile title + activityFromList. */
function scrapedRowKey(title: string, activityIso: string | null): string {
    return `${title}\0${activityIso ?? ""}`
}

async function loadExistingUmaExports(dir: string): Promise<{
    threadIds: Set<string>
    rowKeys: Set<string>
    fileNames: Set<string>
}> {
    const threadIds = new Set<string>()
    const rowKeys = new Set<string>()
    const fileNames = new Set<string>()
    let names: string[] = []
    try {
        names = await readdir(dir)
    } catch {
        return { threadIds, rowKeys, fileNames }
    }
    for (const name of names) {
        if (!name.endsWith(".json")) {
            continue
        }
        fileNames.add(name)
        try {
            const raw = await readFile(path.join(dir, name), "utf8")
            const j = JSON.parse(raw) as ThreadExportFile
            if (j.threadId != null && j.threadId !== "") {
                threadIds.add(j.threadId)
            }
            rowKeys.add(scrapedRowKey(j.title, j.activityFromList))
        } catch {
            // ignore unreadable or invalid JSON
        }
    }
    return {threadIds, rowKeys, fileNames}
}

async function main() {
    let config: Option = options(
        process.env.DISCORD_USERNAME || "",
        process.env.DISCORD_PASSWORD || "",
    )
    config.headless = true
    const puppet = new Puppet(config)

    await puppet.start()

    await puppet.clickServer("UMA")
    await puppet.humanSleepReading()

    await puppet.clickChannel("dispute-threads")
    await puppet.humanSleepReading()

    await puppet.scrollChannelThreadListToLatest()
    await new Promise(r => setTimeout(r, 600))

    const channelListUrl = puppet.getCurrentUrl()
    const newerThan = new Date(Date.now() - LOOKBACK_MS)

    await mkdir(OUTPUT_DIR, {recursive: true})
    const scraped = await loadExistingUmaExports(OUTPUT_DIR)
    const usedNames = new Set<string>(scraped.fileNames)
    const processedListItemIds = new Set<string>()

    if (scraped.rowKeys.size > 0 || scraped.threadIds.size > 0) {
        console.log(
            `Found ${scraped.fileNames.size} file(s) in uma-threads; skipping matching threads (${scraped.rowKeys.size} list keys, ${scraped.threadIds.size} thread ids).`,
        )
    }

    let idleScrolls = 0
    while (idleScrolls < 6) {
        const prevCount = processedListItemIds.size
        const rows = await puppet.collectDisputeChannelThreadRows(newerThan)
        const fresh = rows.filter(r => !processedListItemIds.has(r.listItemId))

        console.log(
            `Visible thread rows in last ${LOOKBACK_DAYS}d: ${rows.length} (${fresh.length} new to process)`,
        )

        for (const row of fresh) {
            if (scraped.rowKeys.has(scrapedRowKey(row.title, row.activityIso))) {
                console.log(`Skip (already in uma-threads): ${row.title}`)
                processedListItemIds.add(row.listItemId)
                continue
            }

            await puppet.openDisputeThreadFromListItem(row.listItemId)
            await puppet.humanSleepReading()

            const threadUrl = puppet.getCurrentUrl()
            const threadId = Puppet.threadIdFromDiscordUrl(threadUrl)
            if (threadId !== "" && scraped.threadIds.has(threadId)) {
                console.log(`Skip (threadId ${threadId} already saved)`)
                processedListItemIds.add(row.listItemId)
                await puppet.returnToDisputeChannelList(channelListUrl)
                await puppet.humanSleepReading()
                continue
            }

            const messages = await puppet.scrapeThreadMessagesSince(newerThan)

            const payload: ThreadExportFile = {
                threadId: threadId || row.listItemId,
                title: row.title,
                url: threadUrl,
                activityFromList: row.activityIso,
                scrapedAt: new Date().toISOString(),
                newerThan: newerThan.toISOString(),
                messages,
            }

            const base = buildBaseFileName(row)
            const fileName = allocateFileName(base, usedNames)
            await writeFile(
                path.join(OUTPUT_DIR, fileName),
                JSON.stringify(payload, null, 2),
                "utf8",
            )
            console.log(`Wrote ${fileName} (${messages.length} messages in lookback window)`)

            scraped.threadIds.add(payload.threadId)
            scraped.rowKeys.add(scrapedRowKey(row.title, row.activityIso))

            processedListItemIds.add(row.listItemId)

            await puppet.returnToDisputeChannelList(channelListUrl)
            await puppet.humanSleepReading(5, 7)
        }

        await puppet.scrollChannelThreadListOlder()
        await new Promise(r => setTimeout(r, 600))

        if (await puppet.disputeChannelListPastLookbackCutoff(newerThan)) {
            console.log(
                `Thread list scrolled to stubs older than lookback (${LOOKBACK_DAYS}d); stopping.`,
            )
            break
        }

        if (processedListItemIds.size === prevCount) {
            idleScrolls++
        } else {
            idleScrolls = 0
        }
    }

    console.log(`Done. Handled ${processedListItemIds.size} list rows (new scrapes + skips).`)
    await puppet.shutdown()
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
