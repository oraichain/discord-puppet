/** Safe basename for JSON exports (no path segments). */
export function sanitizeThreadFileName(name: string): string {
    const s = name
        .replace(/[/\\?%*:|"<>.\u0000-\u001f]/g, "-")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120)
        .replace(/[. -]+$/g, "")
    return s.length > 0 ? s : "thread"
}
