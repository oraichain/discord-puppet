export interface ForumThreadRef {
    threadId: string
    url: string
    title: string
    activityIso: string | null
}

/** Row from dispute-threads style channel (thread stubs as system messages; open via button, not /channels/ links). */
export interface DisputeThreadRow {
    listItemId: string
    title: string
    activityIso: string | null
}

export interface ThreadMessageRecord {
    messageId: string
    channelId: string
    author?: string
    timestamp: string
    content: string | null
    imageUrl?: string | null
}

export interface ThreadExportFile {
    threadId: string
    title: string
    url: string
    activityFromList: string | null
    scrapedAt: string
    newerThan: string
    messages: ThreadMessageRecord[]
}
