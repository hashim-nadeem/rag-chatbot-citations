import { test } from "node:test";
import assert from "node:assert/strict";
import { cosine, rank } from "./retrieval.ts";
import type { EmbeddedChunk } from "./types.ts";

const chunk = (id: string, source: string, vector: number[]): EmbeddedChunk => ({
  id,
  text: `text of ${id}`,
  source,
  section: "S",
  page: 1,
  index: 0,
  vector,
});

test("cosine is 1 for identical, 0 for orthogonal, -1 for opposite", () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([1, 0], [-1, 0]), -1);
  assert.equal(cosine([0, 0], [1, 1]), 0, "zero vector must not divide by zero");
});

test("cosine ignores magnitude", () => {
  assert.ok(Math.abs(cosine([1, 2, 3], [10, 20, 30]) - 1) < 1e-12);
});

test("an off-topic query clears nothing and returns an empty array", () => {
  const corpus = [chunk("a", "x.pdf", [1, 0]), chunk("b", "x.pdf", [0.9, 0.1])];
  assert.deepEqual(rank([0, 1], corpus, 5, 0.35, 3), []);
});

test("results are ordered by score and capped at k", () => {
  const corpus = [
    chunk("far", "x.pdf", [0.6, 0.8]),
    chunk("near", "x.pdf", [1, 0.05]),
    chunk("mid", "y.pdf", [0.9, 0.4]),
  ];
  const hits = rank([1, 0], corpus, 2, 0.35, 3);
  assert.deepEqual(hits.map((h) => h.chunk.id), ["near", "mid"]);
  assert.ok(hits[0].score > hits[1].score);
});

test("source diversity caps one document at MAX_PER_SOURCE", () => {
  const corpus = [
    ...[0.99, 0.98, 0.97, 0.96].map((v, i) => chunk(`loud${i}`, "loud.pdf", [v, 1 - v])),
    chunk("quiet", "quiet.pdf", [0.8, 0.2]),
  ];
  const hits = rank([1, 0], corpus, 5, 0.35, 3);
  assert.equal(hits.filter((h) => h.chunk.source === "loud.pdf").length, 3);
  assert.ok(hits.some((h) => h.chunk.source === "quiet.pdf"), "the quieter source must survive");
});

test("rank scores agree with cosine after the query-norm hoist", () => {
  const corpus = [
    chunk("a", "x.pdf", [0.2, 0.9, 0.1]),
    chunk("b", "x.pdf", [0.7, 0.1, 0.4]),
    chunk("c", "y.pdf", [0.5, 0.5, 0.5]),
  ];
  const q = [0.3, 0.8, 0.2];
  for (const hit of rank(q, corpus, 5, -1, 3)) {
    const raw = corpus.find((c) => c.id === hit.chunk.id)!.vector;
    assert.ok(
      Math.abs(hit.score - cosine(q, raw)) < 1e-12,
      `${hit.chunk.id}: ${hit.score} vs ${cosine(q, raw)}`,
    );
  }
});

test("a zero query vector retrieves nothing instead of dividing by zero", () => {
  const corpus = [chunk("a", "x.pdf", [1, 0]), chunk("b", "y.pdf", [0, 1])];
  assert.deepEqual(rank([0, 0], corpus, 5, -1, 3), []);
});

test("the vector is stripped from returned chunks so it never reaches the client", () => {
  const hits = rank([1, 0], [chunk("a", "x.pdf", [1, 0])], 5, 0.35, 3);
  assert.ok(!("vector" in hits[0].chunk));
});
