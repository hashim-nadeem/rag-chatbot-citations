/**
 * The eval suite. Runs the same pipeline the API route runs — embed, retrieve,
 * guard, generate — against evals/questions.jsonl, and writes the numbers the
 * README publishes. Defaults to Ollama so it is free and repeatable.
 *
 *   npm run eval              full run (embeds, retrieves, generates)
 *   npm run eval -- --sweep   retrieval-only similarity-floor sweep, no LLM calls
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { embed, embedModel, generateText, LlmError, withRetry } from "../lib/llm.ts";
import { loadVectors, rank, MAX_PER_SOURCE, SIMILARITY_FLOOR } from "../lib/retrieval.ts";
import { buildUserMessage, SYSTEM_PROMPT } from "../lib/prompt.ts";
import { REFUSAL } from "../lib/types.ts";
import { MIN_CHARS, OVERLAP_CHARS, TARGET_CHARS } from "../lib/chunk.ts";

const ROOT = process.cwd();
try {
  process.loadEnvFile(path.join(ROOT, ".env.local"));
} catch {
  /* .env.local is optional */
}

type Question = {
  id: string;
  question: string;
  expectedSourceIds: string[];
  expectedContains: string[];
  answerable: boolean;
};

type Result = Question & {
  answer: string;
  topIds: string[];
  topScore: number;
  hit: boolean;
  contained: boolean;
  cited: boolean;
  refused: boolean;
  latencyMs: number;
  error?: string;
};

const K = 5;
/**
 * Wide on purpose. Different embedding models occupy very different parts of the
 * cosine range: gemini-embedding-001 scores two unrelated English passages around
 * 0.6, so a floor tuned for an older model sits far below anything it can separate
 * and the guard never fires.
 */
const SWEEP_FLOORS = [
  0.3, 0.4, 0.5, 0.55, 0.6, 0.62, 0.64, 0.66, 0.68, 0.7, 0.72, 0.75, 0.8,
];

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((n / d) * 100).toFixed(0)}%`);
const ratio = (n: number, d: number) => (d === 0 ? null : n / d);

async function loadQuestions(): Promise<Question[]> {
  const raw = await readFile(path.join(ROOT, "evals", "questions.jsonl"), "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Question);
}

const QUERY_CACHE = path.join(ROOT, "evals", ".query-cache.json");

/**
 * Embed every question once and cache it on disk, keyed by model and question
 * text. The question set is fixed, so a re-run costs no quota and retrieval
 * numbers stay bit-identical between runs — which is what makes the published
 * score reproducible rather than merely plausible.
 */
async function embedQuestions(questions: Question[]): Promise<Map<string, number[]>> {
  const model = embedModel();
  let cache: Record<string, number[]> = {};
  try {
    const saved = JSON.parse(await readFile(QUERY_CACHE, "utf8")) as {
      model: string;
      vectors: Record<string, number[]>;
    };
    if (saved.model === model) cache = saved.vectors;
  } catch {
    /* first run */
  }

  const out = new Map<string, number[]>();
  const missing = questions.filter((q) => !cache[q.question]);

  // Small batches: the free embedding tier counts every item in a batch request
  // against the per-minute allowance, so a 30-item call trips it in one go.
  const QBATCH = Number(process.env.EVAL_QUERY_BATCH ?? 5);
  for (let i = 0; i < missing.length; i += QBATCH) {
    const batch = missing.slice(i, i + QBATCH);
    const vectors = await withRetry(
      () => embed(batch.map((q) => q.question), "query"),
      `question embeddings ${i + 1}-${i + batch.length}`,
    );
    batch.forEach((q, j) => {
      cache[q.question] = vectors[j];
    });
    await writeFile(QUERY_CACHE, JSON.stringify({ model, vectors: cache }));
    if (i + QBATCH < missing.length) await new Promise((r) => setTimeout(r, 4000));
  }

  for (const q of questions) out.set(q.id, cache[q.question]);
  return out;
}

/** Retrieval-only: how the similarity floor trades recall against the guard. */
function sweep(questions: Question[], vectors: Map<string, number[]>) {
  const chunks = loadVectors().chunks;
  const answerable = questions.filter((q) => q.answerable);
  const unanswerable = questions.filter((q) => !q.answerable);

  return SWEEP_FLOORS.map((floor) => {
    let hits = 0;
    let starved = 0;
    for (const q of answerable) {
      const top = rank(vectors.get(q.id)!, chunks, K, floor, MAX_PER_SOURCE);
      if (top.some((h) => q.expectedSourceIds.includes(h.chunk.id))) hits++;
      if (top.length === 0) starved++;
    }
    let guarded = 0;
    for (const q of unanswerable) {
      if (rank(vectors.get(q.id)!, chunks, K, floor, MAX_PER_SOURCE).length === 0) guarded++;
    }
    return {
      floor,
      hitAt5: ratio(hits, answerable.length)!,
      // Answerable questions the floor starves of context: a guaranteed false refusal.
      starvedRate: ratio(starved, answerable.length)!,
      // Off-corpus questions the floor stops before the model is ever called.
      guardedRate: ratio(guarded, unanswerable.length)!,
    };
  });
}

async function runOne(q: Question, queryVector: number[]): Promise<Result> {
  const started = Date.now();
  const base = { ...q, topIds: [] as string[], topScore: 0, hit: false, contained: false, cited: false };

  const hits = rank(queryVector, loadVectors().chunks, K, SIMILARITY_FLOOR, MAX_PER_SOURCE);
  const retrieveMs = Date.now() - started;
  const topIds = hits.map((h) => h.chunk.id);
  const hit = q.expectedSourceIds.some((id) => topIds.includes(id));

  // The guard: nothing cleared the floor, so the model is never asked.
  if (hits.length === 0) {
    return { ...base, topIds, hit, answer: REFUSAL, refused: true, latencyMs: retrieveMs };
  }

  let answer = "";
  let error: string | undefined;
  // Timed around the successful attempt only. withRetry can sleep 15-120s
  // between attempts, and folding that backoff into the published latency would
  // report a number no real request ever experiences.
  let generateMs = 0;
  try {
    const raw = await withRetry(async () => {
      const attemptStarted = Date.now();
      const text = await generateText(SYSTEM_PROMPT, [
        { role: "user", content: buildUserMessage(q.question, hits) },
      ]);
      generateMs = Date.now() - attemptStarted;
      return text;
    }, q.id);
    answer = raw.trim();
  } catch (err) {
    error = err instanceof LlmError ? `${err.kind}: ${err.message}` : String(err);
  }

  return {
    ...base,
    topIds,
    topScore: hits[0].score,
    hit,
    answer,
    error,
    refused: answer.toLowerCase().includes(REFUSAL.toLowerCase().slice(0, 30)),
    contained: q.expectedContains.every((s) => answer.includes(s)),
    cited: /\[\d{1,2}\]/.test(answer),
    latencyMs: retrieveMs + generateMs,
  };
}

/**
 * Scored over results that actually completed. A provider error is an
 * infrastructure failure, not a wrong answer — counting one as the other
 * understates the score just as dishonestly as inflating it, so errored
 * questions are excluded here and the run is marked incomplete instead.
 */
function metrics(results: Result[]) {
  const ok = results.filter((r) => !r.error);
  const answerable = ok.filter((r) => r.answerable);
  const unanswerable = ok.filter((r) => !r.answerable);
  const answered = answerable.filter((r) => !r.refused);
  const errors = results.filter((r) => r.error);

  // Refusals short-circuit before the model, so averaging them together with
  // generated answers would report a latency no real answer ever has.
  const mean = (rs: Result[]) =>
    rs.length ? Math.round(rs.reduce((n, r) => n + r.latencyMs, 0) / rs.length) : null;
  const refusals = ok.filter((r) => r.refused);

  return {
    retrievalHitAt5: ratio(answerable.filter((r) => r.hit).length, answerable.length),
    answerAccuracy: ratio(answerable.filter((r) => r.contained).length, answerable.length),
    citationRate: ratio(answered.filter((r) => r.cited).length, answered.length),
    refusalPrecision: ratio(unanswerable.filter((r) => r.refused).length, unanswerable.length),
    falseRefusalRate: ratio(answerable.filter((r) => r.refused).length, answerable.length),
    meanLatencyMs: mean(answered),
    meanRefusalLatencyMs: mean(refusals),
    scored: ok.length,
    errored: errors.length,
    incomplete: errors.length > 0,
  };
}

function failureNote(f: Result): string {
  if (f.error) return `error — ${f.error}`;
  if (!f.answerable) return "answered instead of refusing";
  const missing = f.expectedContains
    .filter((s) => !f.answer.includes(s))
    .map((s) => "`" + s + "`")
    .join(", ");
  return `${f.refused ? "refused; " : ""}missing ${missing || "(nothing)"}`;
}

function markdown(
  results: Result[],
  m: ReturnType<typeof metrics>,
  floors: ReturnType<typeof sweep>,
  meta: { provider: string; ranAt: string; chunks: number },
) {
  const ok = results.filter((r) => !r.error);
  const answerable = ok.filter((r) => r.answerable);
  const unanswerable = ok.filter((r) => !r.answerable);
  const answered = answerable.filter((r) => !r.refused);
  const failures = results.filter((r) => r.error || (r.answerable ? !r.contained : !r.refused));

  const metricRows = [
    ["Retrieval hit@5", pct(answerable.filter((r) => r.hit).length, answerable.length), "an expected source id appears in the top 5"],
    ["Answer accuracy", pct(answerable.filter((r) => r.contained).length, answerable.length), "every expected string appears in the answer"],
    ["Citation rate", pct(answered.filter((r) => r.cited).length, answered.length), "answers carrying at least one `[n]` marker"],
    ["Refusal precision", pct(unanswerable.filter((r) => r.refused).length, unanswerable.length), "unanswerable questions correctly refused"],
    ["False refusal rate", pct(answerable.filter((r) => r.refused).length, answerable.length), "answerable questions wrongly refused (lower is better)"],
    ["Mean latency (answers)", `${m.meanLatencyMs ?? "—"} ms`, "retrieve + generate. **Excludes query embedding**, which is cached across runs, and excludes retry backoff"],
    ["Mean latency (refusals)", `${m.meanRefusalLatencyMs ?? "—"} ms`, "retrieve only — the guard short-circuits before any model call"],
  ]
    .map(([a, b, c]) => `| ${a} | ${b} | ${c} |`)
    .join("\n");

  const banner = m.incomplete
    ? `> **INCOMPLETE RUN — DO NOT PUBLISH THESE NUMBERS.** ${m.errored} of ${results.length}\n` +
      `> questions failed on provider errors and are excluded from the scores below, which\n` +
      `> are therefore computed over only ${m.scored} questions. Re-run \`npm run eval\` once the\n` +
      `> provider is healthy.\n\n`
    : "";

  const floorRows = floors
    .map((f) => {
      const inUse = f.floor === SIMILARITY_FLOOR ? " **(in use)**" : "";
      return `| ${f.floor.toFixed(2)}${inUse} | ${(f.hitAt5 * 100).toFixed(0)}% | ${(f.starvedRate * 100).toFixed(0)}% | ${(f.guardedRate * 100).toFixed(0)}% |`;
    })
    .join("\n");

  const failureTable =
    failures.length === 0
      ? "None."
      : ["| id | question | what happened |", "|---|---|---|"]
          .concat(failures.map((f) => `| ${f.id} | ${f.question} | ${failureNote(f)} |`))
          .join("\n");

  return `# Eval results

Generated by \`npm run eval\`. Do not edit by hand.

${banner}- **Corpus:** IRS Publication 15 (Circular E) and Publication 15-B, 2026 editions — ${meta.chunks} chunks
- **Run at:** ${meta.ranAt}
- **Provider:** \`${meta.provider}\`
- **Retrieval:** top-${K}, cosine, similarity floor **${SIMILARITY_FLOOR}**, at most ${MAX_PER_SOURCE} chunks per source
- **Chunking:** ~${TARGET_CHARS} chars, ${OVERLAP_CHARS} chars overlap, ${MIN_CHARS}-char floor
- **Questions:** ${answerable.length} answerable, ${unanswerable.length} unanswerable

## Metrics

| Metric | Score | Definition |
|---|---|---|
${metricRows}

## Similarity floor

Retrieval-only sweep over the same question set — no model calls, so these
numbers are deterministic. \`starved\` is the share of answerable questions left
with zero context (a guaranteed false refusal); \`guarded\` is the share of
off-corpus questions stopped before the model is ever called.

| Floor | hit@5 | starved | guarded |
|---|---|---|---|
${floorRows}

## Failures

${failureTable}
`;
}

async function main() {
  const questions = await loadQuestions();
  const store = loadVectors();
  const provider = (process.env.LLM_PROVIDER ?? "google").toLowerCase();
  const sweepOnly = process.argv.includes("--sweep");

  // A query embedded by a different model than the store is not comparable to it;
  // the numbers would look plausible and mean nothing.
  if (store.model !== embedModel()) {
    throw new Error(
      `data/vectors.json was built with "${store.model}" but this run embeds with "${embedModel()}".\n` +
        `Set the matching provider in .env.local, or re-run "npm run embed" with this one.`,
    );
  }

  console.log(`${questions.length} questions · ${store.chunks.length} chunks · provider ${provider}`);
  const vectors = await embedQuestions(questions);
  const floors = sweep(questions, vectors);

  if (sweepOnly) {
    // The top-1 distributions are what actually decide the floor: it has to sit
    // above what off-corpus questions score and below what real ones score.
    const chunks = store.chunks;
    const top1 = (qs: Question[]) =>
      qs
        .map((q) => rank(vectors.get(q.id)!, chunks, 1, -1, MAX_PER_SOURCE)[0]?.score ?? 0)
        .sort((a, b) => a - b);
    const answerableTop = top1(questions.filter((q) => q.answerable));
    const unanswerableTop = top1(questions.filter((q) => !q.answerable));
    const f = (n: number | undefined) => (n === undefined ? "—" : n.toFixed(3));
    console.log(
      `\ntop-1 answerable   min ${f(answerableTop[0])}  median ${f(answerableTop[answerableTop.length >> 1])}  max ${f(answerableTop.at(-1))}`,
    );
    console.log(
      `top-1 unanswerable min ${f(unanswerableTop[0])}  median ${f(unanswerableTop[unanswerableTop.length >> 1])}  max ${f(unanswerableTop.at(-1))}\n`,
    );
    console.table(floors);
    return;
  }

  const results: Result[] = [];
  let consecutiveErrors = 0;
  for (const q of questions) {
    const r = await runOne(q, vectors.get(q.id)!);
    results.push(r);
    const mark = r.error ? "ERR " : r.answerable ? (r.contained ? "ok  " : "MISS") : r.refused ? "ok  " : "MISS";
    console.log(`  ${mark} ${r.id}  ${String(r.latencyMs).padStart(6)}ms  ${r.question.slice(0, 56)}`);

    // Each failure already burned its full retry ladder; a provider that is down
    // stays down, so stop rather than spending four more minutes proving it.
    consecutiveErrors = r.error ? consecutiveErrors + 1 : 0;
    if (consecutiveErrors >= 3) {
      console.error(`\n  aborting: ${consecutiveErrors} provider failures in a row`);
      break;
    }
  }

  const m = metrics(results);
  const ranAt = new Date().toISOString();

  // RESULTS.md is written either way, because the failure list is how you debug
  // the run. results.json is what the stat bar reads, so it is only written for a
  // clean run — a contaminated score must never reach the UI or the README.
  await writeFile(
    path.join(ROOT, "evals", "RESULTS.md"),
    markdown(results, m, floors, { provider, ranAt, chunks: store.chunks.length }),
  );

  if (m.incomplete) {
    console.error(
      `\n${m.errored} of ${results.length} questions failed on provider errors.` +
        `\nevals/RESULTS.md lists them, but results.json was NOT written: these numbers` +
        `\nare not publishable. Re-run once the provider is healthy.`,
    );
    process.exit(1);
  }

  await writeFile(
    path.join(ROOT, "evals", "results.json"),
    `${JSON.stringify({ ...m, ranAt, provider, chunks: store.chunks.length }, null, 2)}\n`,
  );

  console.log(`\n${JSON.stringify(m, null, 2)}`);
  console.log("\nwrote evals/RESULTS.md and evals/results.json");
}

main().catch((err) => {
  console.error(`\neval failed: ${err.message}`);
  process.exit(1);
});
