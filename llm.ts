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

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
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
            `You are a content quality filter for a news intelligence service. Decide if the following prediction market describes an event that a Western news outlet (New York Times, Reuters, Financial Times, The Economist, Bloomberg or more) would cover as a news story or analysis — not as a trivia item or novelty.\n\n` +
            `Important: the market description may contain blockchain metadata (transaction hashes, network names, resolution criteria like p1/p2/p3). Ignore these — focus only on the underlying real-world event being predicted.\n\n` +
            `Answer only "yes" or "no".\n\n` +
            `Answer "yes" if the market is about:\n` +
            `- Geopolitics and international relations: ceasefires, peace negotiations, military operations, diplomatic contacts or meetings between any political leaders or senior officials (including phone calls, visits, or public communications), sanctions, treaties, armed conflict between state or non-state actors\n` +
            `- Leadership changes: removal, resignation, firing, or appointment of any notable figure — political (heads of state, ministers, governors, central bank chairs) or corporate (CEOs, executives of well-known companies) — whose departure or arrival would be covered as news\n` +
            `- Central bank and macroeconomic policy: interest rate decisions, quantitative easing/tightening, major fiscal policy changes\n` +
            `- AI and technology with strategic significance: major AI model releases or benchmark leaderboard shifts, AI government contracts or regulatory decisions, significant infrastructure decisions affecting entire industries\n` +
            `- Energy and commodities: production halts or resumptions by major state or private energy producers, disruptions to key shipping corridors (e.g., Strait of Hormuz)\n` +
            `- Armed conflict, security, and law enforcement: military escalations, strikes on infrastructure, cross-border attacks, counter-narcotics or anti-cartel operations, security operations by state forces against organized crime or insurgents\n` +
            `- Newsworthy announcements: official statements, policy declarations, or regulatory decisions by governments, central banks, major institutions, or publicly significant companies that would be reported as standalone news (e.g., executive orders, ETF approvals, sanctions announcements, major corporate decisions with broad market or policy impact)\n` +
            `- Legal, judicial, and investigative events: court rulings, indictments, arrests, document or evidence releases, whistleblower disclosures, or investigations involving public figures, government institutions, or matters of broad public interest (e.g., Epstein files, political corruption cases, major fraud trials)\n\n` +
            `- Any news worthy event or announcement that may be covered by a Western news outlet\n` +
            `Answer "no" if the market is about:\n` +
            `- Sports or esports: any match outcome, score, over/under bet, tournament result, or individual player performance (football, soccer, tennis, basketball, cricket, hockey, esports, etc.)\n` +
            `- Trivial political behavior: whether a politician will utter a specific word or phrase during a speech, dance, or perform a minor physical action at an event\n` +
            `- Cryptocurrency prices: Bitcoin, Ethereum, Solana, or any digital asset reaching a specific price level\n` +
            `- Individual stock price targets: a company's share price closing within a specific range\n` +
            `- Weather: temperature or weather conditions in any city on a specific date\n` +
            `- Crypto token sales and ICOs: public fundraising rounds or token launches for crypto projects\n` +
            `- Social media activity: tweet or post counts by any individual\n` +
            `- Meta or aggregate markets bundling many unrelated conditions (e.g., "nothing ever happens" compilations)\n\n` +
            `Prediction market title: ${threadTitle}\nMarket description: ${heraldContent}`,
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

  const BATCH_SIZE = 20;
  for (const batch of chunkArray(files, BATCH_SIZE)) {
    await Promise.all(
      batch.map(async (file) => {
        const filePath = path.join(THREADS_DIR, file);
        const thread: ThreadFile = JSON.parse(await readFile(filePath, "utf8"));
        const herald = thread.messages[0];
        if (herald?.content == null || herald.content === "") {
          console.log(`[skip]   ${file} — no UMA Herald content`);
          filtered++;
          return;
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
      }),
    );
  }

  console.log(
    `\nDone: ${copied} copied to ${OUTPUT_DIR}, ${filtered} filtered out.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
