import { readdir, readFile, writeFile, access } from "fs/promises";
import * as path from "path";
import "dotenv/config";

const INPUT_DIR = "./quality-uma-threads";
const OUTPUT_FILE = "./filter-sources.json";
const LLM_BASE_URL = process.env.LLM_BASE_URL ?? "http://localhost:11434/v1";
const LLM_MODEL = process.env.LLM_MODEL ?? "gpt-4o-mini";
const LLM_API_KEY = process.env.LLM_API_KEY ?? "";
const MAX_FILES = Number(process.env.MAX_FILES ?? 10);
const FILE_CONCURRENCY = Number(process.env.FILE_CONCURRENCY ?? 1);
const MESSAGE_CONCURRENCY = Number(process.env.MESSAGE_CONCURRENCY ?? 1);

interface ThreadMessage {
  messageId: string;
  channelId: string;
  author?: string;
  timestamp: string;
  content: string | null;
  imageUrl: string | null;
}

interface ThreadFile {
  threadId: string;
  title: string;
  url: string;
  activityFromList: string;
  scrapedAt: string;
  newerThan: string;
  messages: ThreadMessage[];
}

type Category = "P1" | "P2" | "P4";

interface ClassifiedMessage {
  links: string[];
  quotes: string[];
}

interface FileResult {
  threadId: string;
  title: string;
  url: string;
  marketDescription: string | null;
  P1: ClassifiedMessage[];
  P2: ClassifiedMessage[];
  P4: ClassifiedMessage[];
}

interface LLMClassification {
  category: "P1" | "P2" | "P4" | "NONE";
  links: string[];
  quotes: string[];
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

async function classifyMessage(
  threadTitle: string,
  marketDescription: string,
  messageContent: string,
): Promise<LLMClassification | null> {
  const systemPrompt =
    `You are analyzing dispute votes for a UMA prediction market thread. ` +
    `Each message is a vote by a disputer arguing for an outcome. ` +
    `The market resolves to one of: P1 (typically "No"), P2 (typically "Yes"), P3 (50/50/unknown — ignore), or P4 (early/disputed — needs more time).\n\n` +
    `Your task: classify the message into ONE category (P1, P2, P4, or NONE) based on what the author is voting for, ` +
    `and extract every URL and every quoted passage of evidence the author cites.\n\n` +
    `Rules:\n` +
    `- Look for explicit mentions like "P1", "P2", "P4", "P2 Yes", "P4 early vote", "I propose P2", "voting P1", etc.\n` +
    `- If the message clearly votes for one of P1/P2/P4, set category to that.\n` +
    `- If it mentions multiple, pick the one the author is currently voting for (look at edits, conclusions like "Clear P2").\n` +
    `- If the message is just chatter, a question, an admin message, a P3 vote, or has no clear P1/P2/P4 vote, set category to "NONE".\n` +
    `- "links": every URL appearing in the message (http/https) that are not Polymarket URLs. Include all of them, deduplicated, in order of appearance.\n` +
    `- "quotes": every passage the author quotes from sources — text inside straight or curly double quotes ("..." or "..."), or block-quoted with > . Extract the inner text only, no quote characters. Skip empty strings.\n\n` +
    `Respond with ONLY a JSON object, no prose, no markdown fences. Schema:\n` +
    `{"category": "P1" | "P2" | "P4" | "NONE", "links": string[], "quotes": string[]}`;

  const userPrompt =
    `Market title: ${threadTitle}\n\n` +
    `Market description (for context only, do not classify this):\n${marketDescription}\n\n` +
    `Message to classify:\n${messageContent}`;

  // console.log("userPrompt: ", userPrompt);
  const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(LLM_API_KEY !== "" ? { Authorization: `Bearer ${LLM_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 2000,
    }),
  });

  if (!res.ok) {
    throw new Error(`LLM error ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as {
    choices: { message: { content: string } }[];
  };
  const raw = data.choices?.[0]?.message?.content?.trim() ?? "";
  if (!raw) return null;

  const cleaned = raw.replace(/^```json\s*/i, "").replace(/```\s*$/i, "");
  let parsed: LLMClassification;
  try {
    parsed = JSON.parse(cleaned) as LLMClassification;
  } catch {
    return null;
  }

  const cat = parsed.category;
  if (cat !== "P1" && cat !== "P2" && cat !== "P4" && cat !== "NONE") {
    return null;
  }
  return {
    category: cat,
    links: Array.isArray(parsed.links) ? parsed.links.filter((s) => typeof s === "string") : [],
    quotes: Array.isArray(parsed.quotes) ? parsed.quotes.filter((s) => typeof s === "string") : [],
  };
}

async function processFile(
  filePath: string,
  fileName: string,
): Promise<FileResult | null> {
  const thread: ThreadFile = JSON.parse(await readFile(filePath, "utf8"));
  const herald = thread.messages[0];
  const marketDescription = herald?.content ?? null;
  if (!marketDescription) {
    console.log(`[skip]   ${fileName} — no market description`);
    return null;
  }

  const result: FileResult = {
    threadId: thread.threadId,
    title: thread.title,
    url: thread.url,
    marketDescription,
    P1: [],
    P2: [],
    P4: [],
  };

  const candidates = thread.messages.slice(1).filter(
    (m) => m.content != null && m.content.trim() !== "",
  );

  for (const batch of chunkArray(candidates, MESSAGE_CONCURRENCY)) {
    const classifications = await Promise.all(
      batch.map(async (msg) => {
        try {
          const cls = await classifyMessage(thread.title, marketDescription, msg.content!);
          console.log("cls: ", cls);
          return { msg, cls };
        } catch (err) {
          console.error(`  [err] ${fileName} msg ${msg.messageId}: ${(err as Error).message}`);
          return { msg, cls: null };
        }
      }),
    );

    for (const { msg, cls } of classifications) {
      if (!cls || cls.category === "NONE") continue;
      if (cls.links.length === 0) continue;
      const entry: ClassifiedMessage = {
        links: cls.links,
        quotes: cls.quotes,
      };
      result[cls.category].push(entry);
    }
  }

  console.log(
    `[done]   ${fileName} — P1:${result.P1.length} P2:${result.P2.length} P4:${result.P4.length} (of ${candidates.length} msgs)`,
  );
  if (result.P1.length === 0 && result.P2.length === 0 && result.P4.length === 0) {
    console.log(`[empty]  ${fileName} — no classified messages, dropping`);
    return null;
  }
  return result;
}

interface OutputFile {
  processed: string[];
  results: FileResult[];
}

async function loadOutput(): Promise<OutputFile> {
  try {
    await access(OUTPUT_FILE);
    const raw = await readFile(OUTPUT_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<OutputFile> | FileResult[];
    if (Array.isArray(parsed)) {
      // migrate legacy format (plain array)
      return { processed: (parsed as FileResult[]).map((r) => r.threadId), results: parsed as FileResult[] };
    }
    return {
      processed: parsed.processed ?? [],
      results: parsed.results ?? [],
    };
  } catch {
    return { processed: [], results: [] };
  }
}

async function flush(output: OutputFile): Promise<void> {
  await writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf8");
}

async function main() {
  const allFiles = (await readdir(INPUT_DIR))
    .filter((f) => f.endsWith(".json"))
    .sort();
    // .slice(0, MAX_FILES);

  const output = await loadOutput();
  const processedIds = new Set(output.processed);
  if (processedIds.size > 0) {
    console.log(`Resuming — ${processedIds.size} threads already processed, skipping them.`);
  }

  const files = allFiles.filter((file) => {
    const thread = JSON.parse(
      require("fs").readFileSync(path.join(INPUT_DIR, file), "utf8"),
    ) as { threadId: string };
    return !processedIds.has(thread.threadId);
  });

  console.log(
    `Filtering sources from ${files.length} remaining files via ${LLM_BASE_URL} (model: ${LLM_MODEL})`,
  );

  for (const batch of chunkArray(files, FILE_CONCURRENCY)) {
    const batchResults = await Promise.all(
      batch.map(async (file) => {
        const thread = JSON.parse(
          require("fs").readFileSync(path.join(INPUT_DIR, file), "utf8"),
        ) as { threadId: string };
        const result = await processFile(path.join(INPUT_DIR, file), file);
        return { threadId: thread.threadId, result };
      }),
    );
    for (const { threadId, result } of batchResults) {
      output.processed.push(threadId);
      if (result) output.results.push(result);
    }
    await flush(output);
  }

  const totals = output.results.reduce(
    (acc, r) => {
      acc.P1 += r.P1.length;
      acc.P2 += r.P2.length;
      acc.P4 += r.P4.length;
      return acc;
    },
    { P1: 0, P2: 0, P4: 0 },
  );
  console.log(
    `\nWrote ${output.results.length} threads to ${OUTPUT_FILE}. Totals — P1:${totals.P1} P2:${totals.P2} P4:${totals.P4}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
