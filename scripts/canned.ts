/**
 * Phase 9 — quota-proofing. Runs the eight showcase questions once and stores
 * the answers, so the suggested chips return instantly, consume no tokens, and
 * keep working after the daily free-tier quota is gone.
 *
 *   npm run canned
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { embed, embedModel, generateText, withRetry } from "../lib/llm.ts";
import { retrieve } from "../lib/retrieval.ts";
import { buildUserMessage, SYSTEM_PROMPT, toCitations } from "../lib/prompt.ts";
import { REFUSAL, type CannedAnswer } from "../lib/types.ts";

const ROOT = process.cwd();
try {
  process.loadEnvFile(path.join(ROOT, ".env.local"));
} catch {
  /* .env.local is optional */
}

/**
 * Seven answerable questions that show the corpus off, plus one that the
 * documents deliberately do not cover — a visitor who only ever clicks the
 * chips still sees the refusal, which is the point of the whole demo.
 */
const QUESTIONS = [
  "What is the social security wage base limit for 2026?",
  "What is the FUTA tax rate for 2026?",
  "Under the monthly deposit schedule, when are employment taxes due?",
  "What flat withholding rate applies to supplemental wages?",
  "How long do I have to keep employment tax records?",
  "When is Form 941 due?",
  "What is the backup withholding rate?",
  "Do employees have to report tips in a month when they earned only a small amount in tips?",
];

/**
 * The eval runner caches its question embeddings; reuse them when a canned
 * question happens to match, so regenerating costs no embedding quota.
 */
async function queryCache(): Promise<Record<string, number[]>> {
  try {
    const saved = JSON.parse(
      await readFile(path.join(ROOT, "evals", ".query-cache.json"), "utf8"),
    ) as { model: string; vectors: Record<string, number[]> };
    return saved.model === embedModel() ? saved.vectors : {};
  } catch {
    return {};
  }
}

async function main() {
  const out: CannedAnswer[] = [];
  const cache = await queryCache();

  for (const question of QUESTIONS) {
    const queryVector =
      cache[question] ?? (await withRetry(() => embed([question], "query"), question.slice(0, 40)))[0];
    const hits = retrieve(queryVector, 5);

    if (hits.length === 0) {
      console.log(`  refused  ${question}`);
      out.push({ question, answer: REFUSAL, citations: [] });
      continue;
    }

    const answer = (
      await withRetry(
        () => generateText(SYSTEM_PROMPT, [{ role: "user", content: buildUserMessage(question, hits) }]),
        question.slice(0, 40),
      )
    ).trim();
    const citations = toCitations(hits);

    if (!/\[\d{1,2}\]/.test(answer)) {
      console.warn(`  WARNING: no citation marker in the answer to "${question}"`);
    }
    console.log(`  ok       ${question}`);
    out.push({ question, answer, citations });
  }

  await writeFile(path.join(ROOT, "data", "canned.json"), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`\nwrote data/canned.json (${out.length} answers)`);
}

main().catch((err) => {
  console.error(`\ncanned failed: ${err.message}`);
  process.exit(1);
});
