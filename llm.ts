import { readdir, readFile, copyFile, mkdir } from "fs/promises";
import * as path from "path";
import "dotenv/config";

const THREADS_DIR = "./uma-threads";
const OUTPUT_DIR = "./quality-uma-threads";
const LLM_BASE_URL = process.env.LLM_BASE_URL ?? "http://localhost:11434/v1";
const LLM_MODEL = process.env.LLM_MODEL ?? "gpt-4o-mini";
const LLM_API_KEY = process.env.LLM_API_KEY ?? "";

interface ThreadFile {
  title: string;
  messages: { author?: string; content: string | null }[];
}

async function isSportsOrEsports(
  heraldContent: string,
  threadTitle: string,
): Promise<boolean> {
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
          role: "user",
          content:
            `Is the following prediction market about politics, geopolitics, world news, technology, science, business, economics, finance, or other non-sports/esports topics? ` +
            `Reply with only "yes" or "no".\n\n${heraldContent}\n\nThread title: ${threadTitle}. Reply "no" if the topics are also: "crypto public sales", "total tweets posted", "stock price", "crypto price"`,
        },
      ],
      max_tokens: 5,
    }),
  });

  if (!res.ok) {
    throw new Error(`LLM error ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as {
    choices: { message: { content: string } }[];
  };
  const answer =
    data.choices?.[0]?.message?.content?.trim().toLowerCase() ?? "";
  return answer.startsWith("yes");
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const files = (await readdir(THREADS_DIR)).filter((f) => f.endsWith(".json"));
  console.log(
    `Classifying ${files.length} threads via ${LLM_BASE_URL} (model: ${LLM_MODEL})`,
  );

  let copied = 0;
  let filtered = 0;

  for (const file of files) {
    const filePath = path.join(THREADS_DIR, file);
    const thread: ThreadFile = JSON.parse(await readFile(filePath, "utf8"));

    const herald = thread.messages.find((m) => m.author === "UMA Herald");
    if (herald?.content == null || herald.content === "") {
      console.log(`[skip]   ${file} — no UMA Herald content`);
      filtered++;
      continue;
    }

    const notSports = await isSportsOrEsports(herald.content, thread.title);
    if (notSports) {
      await copyFile(filePath, path.join(OUTPUT_DIR, file));
      console.log(`[copy]   ${file}`);
      copied++;
    } else {
      console.log(`[filter] ${file}`);
      filtered++;
    }
  }

  console.log(
    `\nDone: ${copied} copied to ${OUTPUT_DIR}, ${filtered} filtered out.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
