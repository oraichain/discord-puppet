/**
 * Transforms filter-sources.json into two JSONL datasets:
 *
 *   dataset/markets.jsonl  — one row per unique market (by threadId)
 *   dataset/news.jsonl     — one row per URL, labeled with market + direction
 *
 * Dedup logic: threads with the same threadId are merged — their P1/P2/P4
 * link blocks are unioned so no community evidence is lost.
 *
 * Usage: ts-node transform-dataset.ts
 */

import * as fs from "fs";
import * as path from "path";

const INPUT = path.join(__dirname, "filter-sources.json");
const OUT_DIR = path.join(__dirname, "dataset");

interface LinkBlock {
  links: string[];
  quotes: string[];
}

interface SourceItem {
  threadId: string;
  title: string;
  url: string;
  marketDescription: string;
  P1: LinkBlock[];
  P2: LinkBlock[];
  P4: LinkBlock[];
  settled?: string;
  polymarket_id: string;
  polymarket_slug: string;
  clarification?: string[];
}

interface MergedMarket {
  threadId: string;
  polymarket_id: string;
  polymarket_slug: string;
  question: string;
  resolution_criteria: string;
  settled: string | null;
  clarification: string[];
  P1: LinkBlock[];
  P2: LinkBlock[];
  P4: LinkBlock[];
}

interface MarketRow {
  polymarket_id: string;
  polymarket_slug: string;
  question: string;
  resolution_criteria: string;
  settled: string | null;
  clarification: string[];
}

interface NewsRow {
  url: string;
  market_id: string;
  question: string;
  direction: "P1" | "P2" | "P4";
  settled: string | null;
}

function stripTitleSuffix(title: string): string {
  return title.replace(/\s*-\s*\d+\s*$/, "").trim();
}

function extractResolutionCriteria(description: string): string {
  // Pull the Description: ... block up to (but not including) "market_id:")
  const m = description.match(/Description:\s*([\s\S]*?)(?:market_id:|$)/i);
  return m ? m[1].trim() : description.split("market_id:")[0].trim();
}

function mergeBlocks(existing: LinkBlock[], incoming: LinkBlock[]): LinkBlock[] {
  const seen = new Set(existing.flatMap((b) => b.links));
  for (const block of incoming) {
    const newLinks = block.links.filter((l) => !seen.has(l));
    if (newLinks.length > 0) {
      existing.push({ links: newLinks, quotes: block.quotes });
      newLinks.forEach((l) => seen.add(l));
    }
  }
  return existing;
}

function collectUrls(blocks: LinkBlock[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const block of blocks) {
    for (const link of block.links) {
      if (!seen.has(link)) {
        seen.add(link);
        result.push(link);
      }
    }
  }
  return result;
}

function main() {
  const raw = fs.readFileSync(INPUT, "utf8");
  const items: SourceItem[] = JSON.parse(raw);

  // Merge items with the same threadId
  const byThread = new Map<string, MergedMarket>();

  for (const item of items) {
    const question = stripTitleSuffix(item.title);
    const resCriteria = extractResolutionCriteria(item.marketDescription ?? "");

    if (!byThread.has(item.threadId)) {
      byThread.set(item.threadId, {
        threadId: item.threadId,
        polymarket_id: item.polymarket_id,
        polymarket_slug: item.polymarket_slug,
        question,
        resolution_criteria: resCriteria,
        settled: item.settled ?? null,
        clarification: item.clarification ?? [],
        P1: [...(item.P1 ?? [])],
        P2: [...(item.P2 ?? [])],
        P4: [...(item.P4 ?? [])],
      });
    } else {
      const existing = byThread.get(item.threadId)!;
      mergeBlocks(existing.P1, item.P1 ?? []);
      mergeBlocks(existing.P2, item.P2 ?? []);
      mergeBlocks(existing.P4, item.P4 ?? []);
      // Keep settled if not yet set
      if (!existing.settled && item.settled) existing.settled = item.settled;
    }
  }

  const markets = [...byThread.values()];
  console.log(`Unique markets: ${markets.length} (from ${items.length} source rows)`);

  // Build output rows
  const marketRows: MarketRow[] = [];
  const newsRows: NewsRow[] = [];

  for (const m of markets) {
    marketRows.push({
      polymarket_id: m.polymarket_id,
      polymarket_slug: m.polymarket_slug,
      question: m.question,
      resolution_criteria: m.resolution_criteria,
      settled: m.settled,
      clarification: m.clarification,
    });

    const directions: Array<["P1" | "P2" | "P4", LinkBlock[]]> = [
      ["P1", m.P1],
      ["P2", m.P2],
      ["P4", m.P4],
    ];

    for (const [direction, blocks] of directions) {
      for (const url of collectUrls(blocks)) {
        newsRows.push({
          url,
          market_id: m.threadId,
          question: m.question,
          direction,
          settled: m.settled,
        });
      }
    }
  }

  // Write output
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const marketsPath = path.join(OUT_DIR, "markets.jsonl");
  fs.writeFileSync(marketsPath, marketRows.map((r) => JSON.stringify(r)).join("\n"), "utf8");

  const newsPath = path.join(OUT_DIR, "news.jsonl");
  fs.writeFileSync(newsPath, newsRows.map((r) => JSON.stringify(r)).join("\n"), "utf8");

  const labeled = marketRows.filter((r) => r.settled).length;
  const totalUrls = newsRows.length;
  const uniqueUrls = new Set(newsRows.map((r) => r.url)).size;

  console.log(`markets.jsonl : ${marketRows.length} rows (${labeled} with settled label)`);
  console.log(`news.jsonl    : ${totalUrls} rows (${uniqueUrls} unique URLs)`);
}

main();
