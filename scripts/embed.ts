/**
 * Build-time only: corpus/ -> data/vectors.json. Never runs at request time.
 * Usage: npm run embed
 */
import { appendFile, readFile, readdir, writeFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { extractPdf } from "../lib/pdf.ts";
import { chunkDocument, type Page } from "../lib/chunk.ts";
import { embed, embedModel, LlmError } from "../lib/llm.ts";
import type { Chunk, EmbeddedChunk, VectorStore } from "../lib/types.ts";

/**
 * The free embedding tier is capped on tokens per minute, not just requests, so
 * batches are small and deliberately paced. Both are env-tunable for a paid key,
 * where this can run flat out.
 */
const BATCH = Number(process.env.EMBED_BATCH ?? 50);
const PACE_MS = Number(process.env.EMBED_PACE_MS ?? 25_000);
const ATTEMPTS = 5;

const ROOT = process.cwd();
const CORPUS = path.join(ROOT, "corpus");
const OUT = path.join(ROOT, "data", "vectors.json");
const META = path.join(ROOT, "data", "index-meta.json");
/**
 * Resume cache, appended after every batch so a rate-limit stop costs one batch.
 * JSONL rather than one JSON object: rewriting the whole map each time is O(n^2)
 * in batch count, ~60 MB of writes to checkpoint 6.5 MB of vectors.
 */
const CACHE = path.join(ROOT, "data", ".embed-cache.jsonl");

/** Provenance notes live in corpus/ too, but they are documentation, not corpus. */
const NOT_CORPUS = new Set(["sources.md", "readme.md"]);

try {
  process.loadEnvFile(path.join(ROOT, ".env.local"));
} catch {
  /* .env.local is optional; Vercel and CI supply real env vars */
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
const keyOf = (c: Chunk) => `${c.id}\u0000${c.text}`;

async function readPages(file: string): Promise<Page[]> {
  const full = path.join(CORPUS, file);
  if (/\.mdx?$/i.test(file)) return [{ page: null, text: await readFile(full, "utf8") }];
  return extractPdf(new Uint8Array(await readFile(full)));
}

/**
 * Exponential backoff. Free-tier limits are per-minute, so the waits start long
 * enough to outlast the window rather than burning every attempt inside it.
 */
async function embedWithRetry(texts: string[], label: string): Promise<number[][]> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await embed(texts, "document");
    } catch (err) {
      // A missing key or a bad model id fails identically five times over.
      if (err instanceof LlmError && err.kind === "config") throw err;
      if (attempt >= ATTEMPTS) throw err;
      const wait = 15_000 * 2 ** (attempt - 1);
      console.warn(
        `\n  ${label}: ${(err as Error).message} — retry ${attempt}/${ATTEMPTS - 1} in ${wait / 1000}s`,
      );
      await sleep(wait);
    }
  }
}

/**
 * Reuse vectors for chunks whose text is byte-identical, so a re-run is free and
 * idempotent. Draws on the committed store and on the resume cache an interrupted
 * run left behind.
 */
async function loadPrevious(): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  const model = embedModel();

  try {
    const prev = JSON.parse(await readFile(OUT, "utf8")) as VectorStore;
    if (prev.model === model) for (const c of prev.chunks) out.set(keyOf(c), c.vector);
  } catch {
    /* nothing committed yet */
  }
  try {
    for (const line of (await readFile(CACHE, "utf8")).split("\n")) {
      if (!line.trim()) continue;
      // A run interrupted mid-write can leave a partial final line; skip it.
      let row: { model: string; key: string; vector: number[] };
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row.model === model) out.set(row.key, row.vector);
    }
  } catch {
    /* no interrupted run to resume */
  }
  return out;
}

async function previousCreatedAt(): Promise<string> {
  try {
    return (JSON.parse(await readFile(OUT, "utf8")) as VectorStore).createdAt;
  } catch {
    return new Date().toISOString();
  }
}

async function main() {
  const files = (await readdir(CORPUS))
    .filter((f) => /\.(pdf|mdx?)$/i.test(f) && !NOT_CORPUS.has(f.toLowerCase()))
    .sort();
  if (!files.length) throw new Error(`no .pdf or .md files in ${CORPUS}`);

  const chunks: Chunk[] = [];
  for (const file of files) {
    const pages = await readPages(file);
    const docChunks = chunkDocument(file, pages);
    const headings = pages.reduce((n, p) => n + (p.headings?.size ?? 0), 0);
    const sections = new Set(docChunks.map((c) => c.section)).size;
    console.log(
      `${file}: ${pages.length} page(s), ${headings} heading(s) -> ${docChunks.length} chunks in ${sections} section(s)`,
    );
    // Every chunk landing in one section means heading detection found nothing
    // usable — retrieval still works, but each chunk loses the heading context
    // its body assumes, which measurably hurts it. Worth knowing loudly.
    if (/\.pdf$/i.test(file) && headings === 0) {
      console.warn(
        `  WARNING: no headings detected in ${file}. Font-metric detection needs a ` +
          `consistent type hierarchy; a scanned or flat-typeset PDF will not have one.`,
      );
    }
    chunks.push(...docChunks);
  }
  if (!chunks.length) throw new Error("chunking produced nothing — check the corpus");

  const known = await loadPrevious();
  const todo = chunks.filter((c) => !known.has(keyOf(c)));
  const batches = Math.ceil(todo.length / BATCH);
  console.log(
    `\n${chunks.length} chunks total, ${chunks.length - todo.length} reused, ${todo.length} to embed`,
  );
  if (todo.length) {
    console.log(`${batches} batches of ${BATCH}, paced ${PACE_MS / 1000}s apart\n`);
  }

  await mkdir(path.dirname(OUT), { recursive: true });
  let embeddedNow = 0;

  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const label = `batch ${Math.floor(i / BATCH) + 1}/${batches}`;
    process.stdout.write(`  ${label} (${batch.length} chunks)... `);

    const vectors = await embedWithRetry(
      batch.map((c) => c.text),
      label,
    );
    if (vectors.length !== batch.length)
      throw new Error(`expected ${batch.length} vectors, got ${vectors.length}`);
    batch.forEach((c, j) => known.set(keyOf(c), vectors[j].map(round6)));
    embeddedNow += batch.length;

    // Checkpoint before pacing, so Ctrl+C or a hard failure keeps the work.
    await appendFile(
      CACHE,
      batch
        .map((c) =>
          JSON.stringify({ model: embedModel(), key: keyOf(c), vector: known.get(keyOf(c)) }),
        )
        .join("\n") + "\n",
    );
    console.log("ok");
    if (i + BATCH < todo.length) await sleep(PACE_MS);
  }

  const embedded: EmbeddedChunk[] = chunks.map((c) => {
    const vector = known.get(keyOf(c));
    if (!vector) throw new Error(`no vector for ${c.id}`);
    return { ...c, vector };
  });

  const store: VectorStore = {
    model: embedModel(),
    dims: embedded[0].vector.length,
    // Stable across no-op re-runs: only bump when something actually changed.
    createdAt: embeddedNow === 0 ? await previousCreatedAt() : new Date().toISOString(),
    chunks: embedded,
  };

  await writeFile(OUT, JSON.stringify(store));
  const bytes = (await stat(OUT)).size;
  const avg = Math.round(chunks.reduce((n, c) => n + c.text.length, 0) / chunks.length);

  // A tiny sidecar so the stat bar doesn't parse a multi-megabyte file to count chunks.
  await writeFile(
    META,
    `${JSON.stringify(
      {
        chunks: embedded.length,
        sources: files,
        model: store.model,
        dims: store.dims,
        avgChunkChars: avg,
        createdAt: store.createdAt,
      },
      null,
      2,
    )}\n`,
  );

  // The store is complete, so the resume cache is now just a duplicate copy.
  await rm(CACHE, { force: true });

  console.log(
    [
      "",
      `files processed:    ${files.length} (${files.join(", ")})`,
      `chunks created:     ${embedded.length}`,
      `avg chunk length:   ${avg} chars`,
      `embedding model:    ${store.model} (${store.dims} dims)`,
      `data/vectors.json:  ${(bytes / 1024 / 1024).toFixed(2)} MB`,
    ].join("\n"),
  );
  if (bytes > 8 * 1024 * 1024) console.warn("\nWARNING: vectors.json is over 8 MB — trim the corpus.");
}

main().catch((err) => {
  console.error(`\nembed failed: ${err.message}`);
  console.error("progress is checkpointed in data/.embed-cache.json — re-run to resume.");
  process.exit(1);
});
