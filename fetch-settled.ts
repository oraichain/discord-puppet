/**
 * Fetch Polymarket resolution for each market in filter-sources.json and add:
 *   "settled"        — "P2" (Yes) or "P1" (No)
 *   "polymarket_id"  — Polymarket numeric market ID
 *   "polymarket_slug"— Polymarket market slug (stable reference for future lookups)
 *   "clarification"  — array of clarification strings from /market-clarifications (empty if none)
 *
 * Strategy:
 *   - Items with `market_id: NNN` in marketDescription → GET /markets/{id}
 *   - Otherwise → derive market slug from question, GET /markets?slug=...&closed=true&archived=true
 *   - If slug lookup misses (market has an unpredictable suffix like "...-771"),
 *     fall back to search-v2 with a high limit.
 *
 * Usage: ts-node fetch-settled.ts
 */

import * as fs from "fs";
import * as path from "path";
import "dotenv/config";

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const FILTER_SOURCES_PATH = path.join(__dirname, "filter-sources.json");
const LLM_BASE_URL = process.env.LLM_BASE_URL ?? "http://localhost:11434/v1";
const LLM_MODEL = process.env.LLM_MODEL ?? "qwen2.5:3b";
const LLM_API_KEY = process.env.LLM_API_KEY ?? "";

interface MarketResult {
  settled: string | null;
  polymarket_id: string | null;
  polymarket_slug: string | null;
}

async function httpGet<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.log(`  HTTP ${res.status} for ${url}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (e) {
    console.log(`  ERROR fetching ${url}: ${e}`);
    return null;
  }
}

// Polymarket sometimes returns outcomePrices/outcomes as a JSON string and
// sometimes as a real array depending on the endpoint — handle both.
function parseJsonOrArray(value: unknown): string[] | null {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return null; }
  }
  return null;
}

function resolveOutcome(market: Record<string, unknown>): string | null {
  const prices = parseJsonOrArray(market["outcomePrices"]);
  const outcomes = parseJsonOrArray(market["outcomes"]);
  if (!prices || !outcomes) return null;
  for (let i = 0; i < outcomes.length; i++) {
    if (parseFloat(prices[i]) < 0.99) continue;
    const winner = outcomes[i].toLowerCase();
    if (winner === "yes") return "P2";
    if (winner === "no") return "P1";
    return null;
  }
  return null;
}

function marketResult(market: Record<string, unknown>): MarketResult {
  return {
    settled: resolveOutcome(market),
    polymarket_id: String(market["id"] ?? ""),
    polymarket_slug: (market["slug"] as string) ?? null,
  };
}

async function fetchByMarketId(marketId: string): Promise<MarketResult> {
  const data = await httpGet<Record<string, unknown>>(
    `${GAMMA_BASE}/markets/${marketId}`
  );
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { settled: null, polymarket_id: null, polymarket_slug: null };
  }
  return marketResult(data);
}

function questionToMarketSlug(question: string): string {
  return question
    .toLowerCase()
    .replace(/\./g, "")           // strip periods so "U.S." → "us"
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function fetchByQuestionSlug(question: string): Promise<MarketResult> {
  const slug = questionToMarketSlug(question);
  const data = await httpGet<Record<string, unknown>[]>(
    `${GAMMA_BASE}/markets?slug=${slug}&closed=true&archived=true`
  );
  // Slug → market is a deterministic Polymarket mapping, so any single result
  // is the right market even if its question was later renamed.
  if (Array.isArray(data) && data.length === 1) return marketResult(data[0]);
  return { settled: null, polymarket_id: null, polymarket_slug: null };
}

async function searchAndResolve(question: string): Promise<MarketResult> {
  // Fallback for markets whose slug has an unpredictable numeric suffix
  // (e.g. "...-771"), which slug derivation can't reproduce.
  const url =
    `${GAMMA_BASE}/search-v2?q=${encodeURIComponent(question)}` +
    `&optimized=true&limit_per_type=100&type=events` +
    `&search_tags=true&search_profiles=true&cache=false`;
  const data = await httpGet<Record<string, unknown>>(url);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { settled: null, polymarket_id: null, polymarket_slug: null };
  }

  const q = question.trim();
  for (const event of (data["events"] as Record<string, unknown>[]) ?? []) {
    for (const market of (event["markets"] as Record<string, unknown>[]) ?? []) {
      if ((market["question"] as string)?.trim() === q) {
        return marketResult(market);
      }
    }
  }
  return { settled: null, polymarket_id: null, polymarket_slug: null };
}

async function fetchClarifications(marketId: string): Promise<string[]> {
  const data = await httpGet<Record<string, unknown>[]>(
    `${GAMMA_BASE}/market-clarifications?market_id=${marketId}`
  );
  if (!Array.isArray(data)) return [];
  return (data as Record<string, unknown>[])
    .sort((a, b) => String(a["scheduledFor"] ?? "").localeCompare(String(b["scheduledFor"] ?? "")))
    .map((c) => String(c["content"] ?? "").trim())
    .filter((c) => c && !c.startsWith(`We're aware of the dispute on this market`));
}

function stripTitleSuffix(title: string): string {
  return title.replace(/\s*-\s*\d+\s*$/, "").trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function extractLinksFromClarifications(
  clarifications: string[],
): Promise<{ links: string[]; quotes: string[] }> {
  if (clarifications.length === 0) return { links: [], quotes: [] };
  const content = clarifications.join("\n\n");
  const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(LLM_API_KEY !== "" ? { Authorization: `Bearer ${LLM_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        {
          role: "system",
          content:
            "Extract all HTTP/HTTPS URLs from the clarification text. Return ONLY a JSON object: {\"links\": string[]}",
        },
        { role: "user", content },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 500,
    }),
  });
  if (!res.ok) {
    console.log(`  LLM error ${res.status}: ${await res.text()}`);
    return { links: [], quotes: [] };
  }
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  const raw = data.choices?.[0]?.message?.content?.trim() ?? "";
  try {
    const parsed = JSON.parse(raw) as { links?: string[] };
    return {
      links: Array.isArray(parsed.links) ? parsed.links.filter((s) => typeof s === "string") : [],
      quotes: clarifications,
    };
  } catch {
    return { links: [], quotes: [] };
  }
}

async function main() {
  const raw = fs.readFileSync(FILTER_SOURCES_PATH, "utf8");
  const file = JSON.parse(raw) as { processed?: string[]; results?: Record<string, unknown>[] };
  const data: Record<string, unknown>[] = Array.isArray(file) ? file : (file.results ?? []);

  const total = data.length;
  let updated = 0;
  let unresolved = 0;

  for (let i = 0; i < data.length; i++) {
    const item = data[i];
    // Skip only if all fields including clarification link extraction are done
    if (
      "settled" in item &&
      "polymarket_slug" in item &&
      "clarification" in item &&
      "clarification_links_extracted" in item
    )
      continue;

    const title = (item["title"] as string) ?? "";
    const desc = (item["marketDescription"] as string) ?? "";

    const marketIdMatch = desc.match(/market_id:\s*(\d+)/);
    let result: MarketResult;

    if (marketIdMatch) {
      const marketId = marketIdMatch[1];
      console.log(`[${i + 1}/${total}] market_id=${marketId} | ${title}`);
      result = await fetchByMarketId(marketId);
    } else {
      const question = stripTitleSuffix(title);
      console.log(`[${i + 1}/${total}] slug-lookup: ${question}`);
      result = await fetchByQuestionSlug(question);
      if (result.settled === null && result.polymarket_slug === null) {
        console.log(`  slug missed, falling back to search-v2`);
        result = await searchAndResolve(question);
      }
    }

    if (result.settled !== null || result.polymarket_slug !== null) {
      if (result.settled !== null) item["settled"] = result.settled;
      if (result.polymarket_id) item["polymarket_id"] = result.polymarket_id;
      if (result.polymarket_slug) item["polymarket_slug"] = result.polymarket_slug;
      updated++;
      console.log(`  → settled: ${result.settled} | slug: ${result.polymarket_slug} | id: ${result.polymarket_id}`);
    } else {
      unresolved++;
      console.log(`  → not resolved yet (skipped)`);
    }

    // Fetch clarifications if we have a polymarket_id and haven't fetched yet
    if (!("clarification" in item)) {
      const marketId = (item["polymarket_id"] as string) ?? result.polymarket_id ?? "";
      if (marketId) {
        const clarifications = await fetchClarifications(marketId);
        item["clarification"] = clarifications;
        if (clarifications.length > 0) {
          console.log(`  → ${clarifications.length} clarification(s) found`);
        }
        await sleep(200);
      } else {
        item["clarification"] = [];
      }
    }

    // Use LLM to extract links from clarifications and append to the settled outcome array
    if (!("clarification_links_extracted" in item)) {
      const settled = item["settled"] as "P1" | "P2" | null;
      const clarifications = item["clarification"] as string[];
      if (settled && (settled === "P1" || settled === "P2") && clarifications.length > 0) {
        const { links, quotes } = await extractLinksFromClarifications(clarifications);
        if (links.length > 0) {
          const arr = (item[settled] as unknown[]) ?? [];
          arr.push({ links, quotes });
          item[settled] = arr;
          console.log(`  → extracted ${links.length} link(s) from clarifications → appended to ${settled}`);
        }
      }
      item["clarification_links_extracted"] = true;
      await sleep(200);
    }

    await sleep(300);
  }

  if (!Array.isArray(file)) file.results = data;
  fs.writeFileSync(FILTER_SOURCES_PATH, JSON.stringify(Array.isArray(file) ? data : file, null, 2), "utf8");
  console.log(`\nDone: ${updated} enriched, ${unresolved} unresolved out of ${total} total.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
