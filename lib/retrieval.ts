import { readFileSync } from "node:fs";
import path from "node:path";
import type { Chunk, EmbeddedChunk, Retrieved, VectorStore } from "./types";

/**
 * In-memory cosine over a committed JSON file. Correct and fast to roughly
 * 5,000 chunks — a linear scan of 500 x 768 floats is well under a millisecond.
 * Past that: pgvector on Neon, or a hosted vector store.
 */

/**
 * Drop anything below this. Calibrated with `npm run sweep` against
 * evals/questions.jsonl — see the sweep table in evals/RESULTS.md.
 *
 * The build spec's suggested 0.35 is meaningless for gemini-embedding-001, which
 * occupies a much narrower band of the cosine range: on this corpus every
 * question, on-topic or not, scores above 0.60, so a 0.35 floor never rejects
 * anything and the guard is dead code. Measured top-1 scores:
 *
 *   answerable    0.701 - 0.811
 *   unanswerable  0.610 - 0.656
 *
 * 0.68 sits in the gap, roughly 0.02 clear on each side: 100% of the off-corpus
 * questions are refused without an LLM call, and none of the answerable ones are
 * starved of context. Re-run the sweep after ANY change to the corpus, the chunker
 * or the embedding model — the usable band moves with all three, and the margin
 * here is thin enough that a genuinely borderline question could fall in it.
 */
export const SIMILARITY_FLOOR = Number(process.env.SIMILARITY_FLOOR ?? 0.68);

/** At most this many chunks from one document, so a verbose section can't crowd out the corpus. */
export const MAX_PER_SOURCE = 3;

let cache: VectorStore | null = null;
/** Cached too, so a corrupt store isn't re-parsed (6.5 MB) on every request. */
let loadError: Error | null = null;

/** Module-scope cache: a warm lambda parses the JSON once, not once per request. */
export function loadVectors(): VectorStore {
  if (cache) return cache;
  if (loadError) throw loadError;
  try {
    const file = path.join(process.cwd(), "data", "vectors.json");
    const store = JSON.parse(readFileSync(file, "utf8")) as VectorStore;
    if (!store.chunks?.length) throw new Error("data/vectors.json contains no chunks");
    cache = store;
    return cache;
  } catch (err) {
    loadError = err instanceof Error ? err : new Error(String(err));
    throw loadError;
  }
}

/**
 * A query embedded at a different width than the store is not comparable to it:
 * cosine would silently score on the overlapping prefix and return confident
 * nonsense. Fail loudly instead.
 */
export function assertComparable(queryVector: number[]): void {
  const { dims, model } = loadVectors();
  if (queryVector.length !== dims) {
    throw new Error(
      `query vector is ${queryVector.length}-dimensional but data/vectors.json is ${dims} ` +
        `(model "${model}"). Re-run "npm run embed", or fix GOOGLE_EMBED_DIMS/GOOGLE_EMBED_MODEL.`,
    );
  }
}

/** True when data/vectors.json is present and non-empty. The UI degrades instead of crashing. */
export function vectorsReady(): boolean {
  try {
    return loadVectors().chunks.length > 0;
  } catch {
    return false;
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export function rank(
  queryVector: number[],
  chunks: EmbeddedChunk[],
  k: number,
  floor: number,
  maxPerSource: number,
): Retrieved[] {
  // The query norm is constant across the scan, so hoisting it out drops the
  // inner loop from three multiply-accumulates per dimension to two.
  let qNorm = 0;
  for (let i = 0; i < queryVector.length; i++) qNorm += queryVector[i] * queryVector[i];
  qNorm = Math.sqrt(qNorm);
  if (qNorm === 0) return [];

  const scored: Retrieved[] = [];
  for (const { vector, ...chunk } of chunks) {
    let dot = 0;
    let vNorm = 0;
    for (let i = 0; i < vector.length; i++) {
      dot += queryVector[i] * vector[i];
      vNorm += vector[i] * vector[i];
    }
    const denom = qNorm * Math.sqrt(vNorm);
    const score = denom === 0 ? 0 : dot / denom;
    if (score >= floor) scored.push({ chunk: chunk as Chunk, score });
  }
  scored.sort((a, b) => b.score - a.score);

  const perSource = new Map<string, number>();
  const out: Retrieved[] = [];
  for (const hit of scored) {
    const used = perSource.get(hit.chunk.source) ?? 0;
    if (used >= maxPerSource) continue;
    perSource.set(hit.chunk.source, used + 1);
    out.push(hit);
    if (out.length === k) break;
  }
  return out;
}

/**
 * Returns [] when nothing clears the floor. The route must then refuse WITHOUT
 * calling the LLM — this empty array is the anti-hallucination guarantee.
 */
export function retrieve(queryVector: number[], k = 5): Retrieved[] {
  assertComparable(queryVector);
  return rank(queryVector, loadVectors().chunks, k, SIMILARITY_FLOOR, MAX_PER_SOURCE);
}
