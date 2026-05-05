import puppeteer from "puppeteer-extra"
import StealthPlugin from "puppeteer-extra-plugin-stealth"
import UserDir from "puppeteer-extra-plugin-user-data-dir"
import {Browser, ElementHandle, Page} from "puppeteer"
import * as console from "console"
import {Message, Ids, Option} from "./interfaces"
import {ForumThreadRef, ThreadMessageRecord, DisputeThreadRow} from "./interfaces/thread-export.interface"
import {Label} from "./utils/language-pack";
import {ValidateFn} from "./types/callback";

export default class Puppet {
    protected browser: Browser
    protected page: Page
    protected options: Option

    constructor(options: Option) {
        puppeteer.use(StealthPlugin())
        puppeteer.use(UserDir())
        this.options = options
    }

    label(label: Label): string {
        return this.options.language.value(label)
    }

    async start(serverId?: string) {
        this.browser = await puppeteer.launch({
            headless: this.options.headless,
            userDataDir: this.options.userDataDir,
            args: this.options.args,
            ignoreDefaultArgs: this.options.ignoreDefaultArgs
        })
        this.page = await this.browser.newPage()
        if (serverId != null) {
            await this.goToServer(serverId)
        } else {
            await this.goToMain()
        }
        await this.login()
        await this.waitExecution(2)
        await this.closeAllPopups()
    }

    async shutdown() {
        await this.browser.close()
    }

    async closeAllPopups() {
        const btns = await this.page.$$(`button[aria-label="${this.label(Label.Close)}"]`)
        for (const btn of btns) {
            await btn.click()
            await this.waitExecution()
        }
    }

    async goToMain() {
        this.log(`[Main]: go`)
        await this.page.goto('https://discord.com/app', {waitUntil: 'load'})
        await this.waitExecution()
        this.log(`[Main]: done`)
    }

    async gotToChannel(serverId: string, channelId: string) {
        this.log(`channel[${serverId}, ${channelId}]: go`)
        await this.page.goto(`https://discord.com/channels/${serverId}/${channelId}`, {waitUntil: 'load'})
        this.log(`channel[${serverId}, ${channelId}]: navigate`)
        await this.page.waitForSelector(`ol[data-list-id="chat-messages"]`, {visible: true})
        await this.waitExecution()
        this.log(`channel[${serverId}, ${channelId}]: done`)
    }

    async goToServer(serverId: string) {
        this.log(`server[${serverId}]: go`)
        await this.page.goto(`https://discord.com/channels/${serverId}`, {waitUntil: 'load'})
        this.log(`server[${serverId}]: navigate`)
        await this.page.waitForSelector(`div[aria-label="${this.label(Label.Servers)}"]`, {visible: true})
        await this.waitExecution()
        this.log(`server[${serverId}]: done`)
    }

    async clickChannel(channel: string) {
        this.log(`channel[${channel}]: click`)
        await this.page.waitForSelector(`a[aria-label*="${channel}"]`, {visible: true})
        await this.page.click(`a[aria-label*="${channel}"]`)
        this.log(`channel[${channel}]: navigation`)
        await this.page.waitForSelector(`ol[data-list-id="chat-messages"]`, {visible: true})
        this.log(`channel[${channel}]: done`)
    }

    async clickServer(server: string) {
        this.log(`server[${server}]: click`)
        await this.page.waitForSelector(`div[aria-label="${this.label(Label.Servers)}"]`, {visible: true})
        await this.page.waitForSelector(`div[data-dnd-name="${server}"]`, {visible: true})
        await this.page.click(`div[data-dnd-name="${server}"]`)
        this.log(`server[${server}]: navigation`)
        await this.page.waitForSelector(`ul[aria-label="${this.label(Label.Channels)}"]`, {visible: true})
        this.log(`server[${server}]: done`)
    }

    async sendMessage(message: string) {
        this.log(`send message{${message}}`)
        await this.page.click('[data-slate-editor="true"]')
        await this.page.type('[data-slate-editor="true"]', message)
        await this.page.keyboard.press('Enter')
    }

    async sendCommand(command: string, args?: string) {
        this.log(`send command{${command}: ${args}}`)
        await this.page.click('[data-slate-editor="true"]')
        await this.page.keyboard.press('/')
        await this.waitExecution()
        await this.page.type('[data-slate-editor="true"]', `${command}`)
        await this.waitExecution(2)
        await this.page.keyboard.press('Enter')
        await this.waitExecution()
        if (args != null) {
            await this.page.type('[data-slate-editor="true"]', `${args}`)
        }
        await this.page.keyboard.press('Enter')
        await this.waitExecution()
    }

    async getLastMsgRaw(): Promise<ElementHandle> {
        await this.page.waitForSelector('ol[data-list-id="chat-messages"] > li:last-of-type')
        return await this.page.$('ol[data-list-id="chat-messages"] > li:last-of-type')
    }


    async getLastMsg(): Promise<Message> {
        await this.page.waitForSelector('ol[data-list-id="chat-messages"] > li:last-of-type')
        const li = await this.page.$('ol[data-list-id="chat-messages"] > li:last-of-type')
        return this.parseMessage(li)
    }

    async getMessage(messageId: string): Promise<Message> {
        const li = await this.page.$(`li[id$="${messageId}"]`)
        if (li == null) {
            throw new Error(`Message ${messageId} not found`)
        }
        return await this.parseMessage(li)
    }

    async parseMessage(li: ElementHandle): Promise<Message> {
        const liId = await this.getProperty(li, 'id')
        const {channelId, messageId} = this.parseIds(liId)
        await this.page.waitForSelector(`li[id="${liId}"] div[id="message-content-${messageId}"]`)
        const content = await li.$eval(`div[id="message-content-${messageId}"]`, it => it.textContent)
        const aTag = await li.$('a[data-role="img"]')
        const imgTag = await li.$('img[alt="Image"]')
        const imageUrl = await this.getProperty(aTag, 'href')
        const lazyImageUrl = await this.getProperty(imgTag, 'src')
        const article = await li.$('div[class*="embedDescription"]')
        let articleContent = null
        if (article != null) {
            articleContent = await li.$eval('div[class*="embedDescription"]', it => it.textContent)
        }
        const accessories = await li.$('div[id*="message-accessories"]')
        const divs = await accessories.$$('button');
        const actions = {};
        for (const div of divs) {
            const textContent = await div.evaluate(el => el.textContent)
            if (textContent.startsWith('U') || textContent.startsWith('V')) {
                actions[textContent] = div
            }
        }
        return {
            channelId: channelId,
            messageId: messageId,
            messageContent: content,
            imageUrl: imageUrl,
            lazyImageUrl: lazyImageUrl,
            article: articleContent,
            actions: actions
        }
    }

    parseIds(id: string): Ids {
        const ids = id.split("-")
        return {
            channelId: ids[2],
            messageId: ids[3]
        }
    }

    async getProperty(elem: ElementHandle | null, property: string): Promise<string | null> {
        const jsProperty = await elem?.getProperty(property)
        const v = await jsProperty?.jsonValue()
        return v == null ? null : String(v)
    }

    async login(): Promise<boolean> {
        if (await this.isLoggedIn()) {
            return true
        }
        try {
            const onLoggingPage = await this.page.$('div[class*="mainLoginContainer"]')
            if (!onLoggingPage) {
                await this.page.goto("https://discord.com/login", { waitUntil: "load" })
                await this.waitExecution(2)
            }
            await this.humanPaceLoginCredentials()
            await this.page.click('button[type="submit"]')
            await this.page.waitForNavigation({waitUntil: 'load'})
            await this.waitExecution()
        } catch (e) {
            this.log("[login]: fail >", e)
        }
        const isLoggedIn = await this.waitLogin()
        if (isLoggedIn) {
            this.log('[login] successful!')
        } else {
            this.log('[login] failed!')
        }
        return isLoggedIn
    }

    /**
     * Type email/password with gaps and per-key delay; ensures at least 5–7s from first focus to ready-for-submit.
     */
    protected async humanPaceLoginCredentials(): Promise<void> {
        const minPacingMs = 5000 + Math.floor(Math.random() * 2001)
        const keyDelay = 45 + Math.floor(Math.random() * 36)
        const t0 = Date.now()

        await this.page.click('input[name="email"]')
        await new Promise(r => setTimeout(r, 200 + Math.floor(Math.random() * 400)))
        await this.page.type('input[name="email"]', this.options.username, {delay: keyDelay})

        await new Promise(r => setTimeout(r, 700 + Math.floor(Math.random() * 900)))

        await this.page.click('input[name="password"]')
        await new Promise(r => setTimeout(r, 150 + Math.floor(Math.random() * 350)))
        await this.page.type('input[name="password"]', this.options.password, {delay: keyDelay})

        const spent = Date.now() - t0
        if (spent < minPacingMs) {
            await new Promise(r => setTimeout(r, minPacingMs - spent))
        }
        await new Promise(r => setTimeout(r, 400 + Math.floor(Math.random() * 500)))
    }

    async isLoggedIn(): Promise<boolean> {
        const sidebar = await this.page.$('div[class*="sidebar"]')
        this.log("[login]: is in? ", sidebar !== null ? "yes" : "no")
        return sidebar !== null
    }

    async waitLogin(): Promise<boolean> {
        this.log("[login]: wait")
        let tryCount = 0
        let isLoggedIn = await this.isLoggedIn()
        while (!isLoggedIn && tryCount < this.options.waitLogin) {
            isLoggedIn = await this.isLoggedIn()
            tryCount++
            if (isLoggedIn || tryCount >= this.options.waitLogin) {
                break
            }
            await this.waitExecution()
        }
        return isLoggedIn
    }

    async waitElement(requiredEval: string, validate?: ValidateFn) {
        let tryCount = 0

        while (tryCount < this.options.waitElement) {
            const last: ElementHandle = await this.getLastMsgRaw()
            const found = await last.$(requiredEval)
            let isValid = found != null
            if (isValid && validate != null) {
                isValid = await validate(found)
            }
            this.log(`[waitElement]: found[${found !== null ? "yes" : "no"}] valid[${isValid ? "yes" : "no"}]`)
            tryCount++
            if (isValid || tryCount >= this.options.waitElement) {
                break
            }
            await this.waitExecution()
        }
    }

    /**
     * Random pause 10–30s to mimic human reading pace between thread actions.
     */
    async humanSleepReading(minMs: number = 5_000, maxMs: number = 15_000): Promise<void> {
        const ms = minMs + Math.floor(Math.random() * (maxMs - minMs))
        this.log(`[human] reading pause ${Math.round(ms / 1000)}s`)
        await new Promise(resolve => setTimeout(resolve, ms))
    }

    async navigateToThread(threadUrl: string): Promise<void> {
        this.log(`[thread]: navigate`)
        await this.page.goto(threadUrl, {waitUntil: "load"})
        await this.page.waitForSelector(`ol[data-list-id="chat-messages"]`, {visible: true})
        await this.waitExecution()
        this.log(`[thread]: ready`)
    }

    getCurrentUrl(): string {
        return this.page.url()
    }

    /**
     * Discord dispute-threads channel lists threads as system messages + "Open Thread" controls (no /channels/ href).
     */
    async collectDisputeChannelThreadRows(newerThan: Date): Promise<DisputeThreadRow[]> {
        const sinceMs = newerThan.getTime()
        return await this.page.evaluate(sMs => {
            type Row = {listItemId: string; title: string; activityIso: string | null}
            const out: Row[] = []
            const seen = new Set<string>()
            document
                .querySelectorAll('ol[data-list-id="chat-messages"] > li[id^="chat-messages-"]')
                .forEach(li => {
                    const openBtn = li.querySelector(
                        '[aria-roledescription="Open Thread Button"][role="button"]',
                    )
                    if (openBtn == null) {
                        return
                    }
                    if (seen.has(li.id)) {
                        return
                    }
                    seen.add(li.id)
                    const timeEl = li.querySelector("time[datetime]")
                    const ts = timeEl?.getAttribute("datetime") ?? null
                    if (ts != null && ts !== "" && new Date(ts).getTime() < sMs) {
                        return
                    }
                    let title = ""
                    const nameEl = li.querySelector(".name__9271d")
                    if (nameEl != null) {
                        title = (nameEl.textContent || "").trim()
                    }
                    if (title === "") {
                        const titleLink = li.querySelector(
                            'strong a[role="link"], strong a.anchor_edefb8',
                        )
                        if (titleLink != null) {
                            title = (titleLink.textContent || "").trim()
                        }
                    }
                    if (title === "") {
                        return
                    }
                    out.push({listItemId: li.id, title, activityIso: ts})
                })
            return out
        }, sinceMs)
    }

    /**
     * Click the in-list "Open Thread" control (channel list must be visible).
     */
    async openDisputeThreadFromListItem(listItemId: string): Promise<void> {
        const safeId = listItemId.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
        const sel = `li[id="${safeId}"] [aria-roledescription="Open Thread Button"]`
        this.log(`[dispute]: open thread`)
        await this.page.waitForSelector(sel, {visible: true, timeout: 20000})
        const urlBefore = this.page.url()
        await this.page.click(sel)
        try {
            await this.page.waitForFunction(
                (u: string) => window.location.href !== u,
                {timeout: 30000},
                urlBefore,
            )
        } catch {
            this.log("[dispute]: URL still same; waiting for thread view")
            await new Promise(r => setTimeout(r, 4500))
        }
        await this.page.waitForSelector(`ol[data-list-id="chat-messages"]`, {
            visible: true,
            timeout: 60000,
        })
        await this.waitExecution()
    }

    /**
     * After viewing a thread opened from the list, return to the channel list.
     */
    async returnToDisputeChannelList(fallbackListUrl: string): Promise<void> {
        this.log(`[dispute]: return to list`)
        try {
            await this.page.goBack({waitUntil: "load", timeout: 30000})
        } catch {
            await this.page.goto(fallbackListUrl, {waitUntil: "load"})
        }
        await this.page.waitForSelector(`ol[data-list-id="chat-messages"]`, {
            visible: true,
            timeout: 60000,
        })
        await this.waitExecution()
    }

    /** Same as scrolling older messages; works for dispute-threads list (same chat scroller). */
    async scrollChannelThreadListOlder(): Promise<void> {
        await this.scrollChatOlder()
    }

    /**
     * Jump the channel thread list to the bottom so the newest thread stubs are in view first.
     * Repeats briefly so lazily-loaded rows at the bottom can settle.
     */
    async scrollChannelThreadListToLatest(): Promise<void> {
        this.log("[dispute]: scroll list to latest")
        for (let i = 0; i < 14; i++) {
            await this.page.evaluate(() => {
                const ol = document.querySelector('ol[data-list-id="chat-messages"]')
                if (ol == null) {
                    return
                }
                let el: HTMLElement | null = ol as unknown as HTMLElement
                for (let depth = 0; depth < 25 && el != null; depth++) {
                    const canScroll = el.scrollHeight > el.clientHeight + 5
                    const st = window.getComputedStyle(el)
                    const cls = el.classList.toString()
                    if (
                        canScroll &&
                        (st.overflowY === "auto" ||
                            st.overflowY === "scroll" ||
                            st.overflowY === "overlay" ||
                            cls.includes("scroller"))
                    ) {
                        el.scrollTop = el.scrollHeight - el.clientHeight
                        return
                    }
                    el = el.parentElement
                }
            })
            await new Promise(r => setTimeout(r, 420))
        }
    }

    /**
     * True when every visible dispute thread row is older than lookbackStart (all list times &lt; newerThan),
     * so continuing to scroll up will not reveal more in-window threads. Rows without a time never trigger stop.
     */
    async disputeChannelListPastLookbackCutoff(lookbackStart: Date): Promise<boolean> {
        const sMs = lookbackStart.getTime()
        return await this.page.evaluate(sinceMs => {
            const lis = document.querySelectorAll(
                'ol[data-list-id="chat-messages"] > li[id^="chat-messages-"]',
            )
            let sawOpenThread = false
            let anyInLookback = false
            let anyUnknownTime = false
            for (let i = 0; i < lis.length; i++) {
                const li = lis[i]
                const openBtn = li.querySelector(
                    '[aria-roledescription="Open Thread Button"][role="button"]',
                )
                if (openBtn == null) {
                    continue
                }
                sawOpenThread = true
                const ts = li.querySelector("time[datetime]")?.getAttribute("datetime")
                if (ts == null || ts === "") {
                    anyUnknownTime = true
                    continue
                }
                if (new Date(ts).getTime() >= sinceMs) {
                    anyInLookback = true
                    break
                }
            }
            if (!sawOpenThread) {
                return false
            }
            if (anyUnknownTime) {
                return false
            }
            return !anyInLookback
        }, sMs)
    }

    /**
     * Last path segment of https://discord.com/channels/&lt;guild&gt;/&lt;parent&gt;/&lt;thread&gt;
     */
    static threadIdFromDiscordUrl(url: string): string {
        try {
            const parts = new URL(url).pathname.split("/").filter(Boolean)
            if (parts.length < 2 || parts[0] !== "channels") {
                return ""
            }
            return parts[parts.length - 1] ?? ""
        } catch {
            return ""
        }
    }

    /**
     * While on a forum channel page, scroll the post list and collect thread links.
     * Keeps threads whose list timestamp is missing or &gt;= newerThan.
     */
    async collectForumThreadRefs(newerThan: Date): Promise<ForumThreadRef[]> {
        const sinceMs = newerThan.getTime()
        const merged = new Map<string, ForumThreadRef>()
        let idle = 0
        for (let i = 0; i < 80 && idle < 5; i++) {
            const batch = await this.page.evaluate(() => {
                type R = {
                    threadId: string
                    url: string
                    title: string
                    activityIso: string | null
                }
                const out: R[] = []
                const seen = new Set<string>()
                document.querySelectorAll('a[href*="/channels/"]').forEach(a => {
                    const href = a.getAttribute("href") || ""
                    const m = href.match(/\/channels\/(\d+)\/(\d+)\/(\d+)/)
                    if (!m) {
                        return
                    }
                    const threadId = m[3]
                    if (seen.has(threadId)) {
                        return
                    }
                    seen.add(threadId)
                    let title = (a.textContent || "").trim().replace(/\s+/g, " ")
                    if (!title) {
                        title = (a.getAttribute("aria-label") || "").trim()
                    }
                    let activityIso: string | null = null
                    let p: Element | null = a
                    for (let d = 0; d < 15 && p; d++) {
                        const tm = p.querySelector("time[datetime]")
                        if (tm) {
                            activityIso = tm.getAttribute("datetime")
                            break
                        }
                        p = p.parentElement
                    }
                    const url = `https://discord.com/channels/${m[1]}/${m[2]}/${m[3]}`
                    out.push({threadId, url, title, activityIso})
                })
                return out
            })

            let newCount = 0
            for (const r of batch) {
                if (r.activityIso != null && new Date(r.activityIso).getTime() < sinceMs) {
                    continue
                }
                if (!merged.has(r.threadId)) {
                    merged.set(r.threadId, {
                        threadId: r.threadId,
                        url: r.url,
                        title: r.title.length > 0 ? r.title : `thread-${r.threadId}`,
                        activityIso: r.activityIso,
                    })
                    newCount++
                }
            }
            if (newCount === 0) {
                idle++
            } else {
                idle = 0
            }

            await this.scrollForumListForMore()
            await new Promise(r => setTimeout(r, 500))
        }
        return Array.from(merged.values())
    }

    /**
     * Collect message rows in the open thread with timestamp &gt;= newerThan.
     * Scrolls up to load older history until nothing new or past the cutoff.
     */
    async scrapeThreadMessagesSince(newerThan: Date): Promise<ThreadMessageRecord[]> {
        const sinceMs = newerThan.getTime()
        const byId = new Map<string, ThreadMessageRecord>()
        let noNewRounds = 0
        for (let round = 0; round < 120 && noNewRounds < 8; round++) {
            const chunk: ThreadMessageRecord[] = await this.page.evaluate(sMs => {
                const lis = document.querySelectorAll(
                    'ol[data-list-id="chat-messages"] > li[id^="chat-messages-"]',
                )
                const rows: ThreadMessageRecord[] = []
                lis.forEach(li => {
                    const id = li.id
                    const parts = id.split("-")
                    if (parts.length < 4) {
                        return
                    }
                    const channelId = parts[2]
                    const messageId = parts[3]
                    const timeEl = li.querySelector("time[datetime]")
                    const ts = timeEl?.getAttribute("datetime")
                    if (ts == null || ts === "") {
                        return
                    }
                    if (new Date(ts).getTime() < sMs) {
                        return
                    }
                    const contentEl = li.querySelector('[id^="message-content-"]')
                    const img = li.querySelector('a[data-role="img"]')
                    const imageUrl =
                        img != null ? img.getAttribute("href") : null
                    let author: string | undefined
                    const userEl = li.querySelector('[data-text][class*="username"]')
                    if (userEl != null) {
                        const dt = userEl.getAttribute("data-text")
                        if (dt != null && dt !== "") {
                            author = dt
                        }
                    }
                    if (author == null || author === "") {
                        const heading = li.querySelector("h3")
                        if (heading != null) {
                            const uname = heading.querySelector('[class*="username"]')
                            const t0 =
                                uname?.textContent?.trim() ||
                                heading.querySelector("span")?.textContent?.trim()
                            if (t0) {
                                author = t0
                            }
                        }
                    }
                    rows.push({
                        messageId,
                        channelId,
                        author,
                        timestamp: ts,
                        content: contentEl != null ? contentEl.textContent : null,
                        imageUrl,
                    })
                })
                return rows
            }, sinceMs)

            const beforeSize = byId.size
            for (const row of chunk) {
                byId.set(row.messageId, row)
            }
            if (byId.size === beforeSize) {
                noNewRounds++
            } else {
                noNewRounds = 0
            }

            const moreAboveCutoff = await this.page.evaluate(sMs => {
                const lis = document.querySelectorAll(
                    'ol[data-list-id="chat-messages"] > li[id^="chat-messages-"]',
                )
                if (lis.length === 0) {
                    return false
                }
                const first = lis[0]
                const timeEl = first.querySelector("time[datetime]")
                if (timeEl == null) {
                    return true
                }
                return new Date(timeEl.getAttribute("datetime") as string).getTime() >= sMs
            }, sinceMs)

            if (!moreAboveCutoff) {
                break
            }

            await this.scrollChatOlder()
            await new Promise(r => setTimeout(r, Math.max(300, this.options.waitExecution / 2)))
        }

        return Array.from(byId.values()).sort(
            (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        )
    }

    protected async scrollForumListForMore(): Promise<void> {
        await this.page.evaluate(() => {
            const divs = Array.from(document.querySelectorAll("div")).filter(el => {
                const h = el as HTMLElement
                return h.scrollHeight > h.clientHeight + 80 && h.clientHeight > 200
            })
            for (const el of divs) {
                const h = el as HTMLElement
                const r = h.getBoundingClientRect()
                if (r.width > 350 && r.left > 80) {
                    h.scrollTop += Math.floor(h.clientHeight * 0.75)
                    return
                }
            }
        })
    }

    protected async scrollChatOlder(): Promise<void> {
        await this.page.evaluate(() => {
            const ol = document.querySelector('ol[data-list-id="chat-messages"]')
            if (ol == null) {
                return
            }
            let el: HTMLElement | null = ol as unknown as HTMLElement
            for (let depth = 0; depth < 25 && el != null; depth++) {
                const canScroll = el.scrollHeight > el.clientHeight + 5
                const cls = el.classList.toString()
                const st = window.getComputedStyle(el)
                const overflowY = st.overflowY
                if (
                    canScroll &&
                    (overflowY === "auto" ||
                        overflowY === "scroll" ||
                        overflowY === "overlay" ||
                        cls.includes("scroller"))
                ) {
                    el.scrollTop = Math.max(0, el.scrollTop - Math.floor(el.clientHeight * 0.85))
                    return
                }
                el = el.parentElement
            }
        })
    }

    private log(message: string, ...args) {
        if (this.options.logs) {
            const time = new Date().toISOString()
            console.log(message, ...args, time)
        }
    }

    protected async waitExecution(ratio = 1) {
        return await (new Promise(r => setTimeout(r, this.options.waitExecution * ratio)))
    }
}