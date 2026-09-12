import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkDocument, splitSentences, tailOverlap, OVERLAP_CHARS } from "./chunk.ts";

const sentence = (n: number) =>
  `Rule ${n} states that an employer must deposit the tax within ${n} days of the payday. `;

const fixture = `# Payroll

${sentence(1).repeat(6)}

${sentence(2).repeat(6)}

## Deposits

${sentence(3).repeat(14)}

## Penalties

${sentence(4).repeat(9)}
`;

test("3-heading fixture yields the expected chunks with the right section paths", () => {
  const chunks = chunkDocument("handbook.md", [{ page: null, text: fixture }]);
  assert.equal(chunks.length, 5);
  assert.deepEqual(
    [...new Set(chunks.map((c) => c.section))],
    ["Payroll", "Payroll > Deposits", "Payroll > Penalties"],
  );
  // every chunk is prefixed with its section path
  for (const c of chunks) assert.ok(c.text.startsWith(`${c.section}\n\n`));
  assert.deepEqual(
    chunks.map((c) => c.id),
    ["handbook-c0", "handbook-c1", "handbook-c2", "handbook-c3", "handbook-c4"],
  );
});

test("no chunk exceeds 1000 chars and none is shorter than 100", () => {
  const chunks = chunkDocument("handbook.md", [{ page: null, text: fixture }]);
  for (const c of chunks) {
    assert.ok(c.text.length <= 1000, `${c.id} is ${c.text.length} chars`);
    assert.ok(c.text.length >= 100, `${c.id} is ${c.text.length} chars`);
  }
});

test("consecutive chunks in the same section overlap", () => {
  const chunks = chunkDocument("handbook.md", [{ page: null, text: fixture }]);
  let compared = 0;
  for (let i = 1; i < chunks.length; i++) {
    if (chunks[i].section !== chunks[i - 1].section) continue;
    const prevBody = chunks[i - 1].text.split("\n\n")[1];
    const body = chunks[i].text.split("\n\n")[1];
    const overlap = tailOverlap(prevBody);
    assert.ok(body.startsWith(overlap), `chunk ${i} does not carry the previous tail`);
    assert.ok(overlap.length > OVERLAP_CHARS / 2, "overlap is too small to be useful");
    compared++;
  }
  assert.ok(compared >= 2, "fixture should produce at least two same-section pairs");
});

test("sentence splitting survives abbreviations", () => {
  assert.deepEqual(splitSentences("See Pub. 15 for details. It is free."), [
    "See Pub. 15 for details.",
    "It is free.",
  ]);
  assert.deepEqual(splitSentences("File Form No. 941 by Jan. 31 each year."), [
    "File Form No. 941 by Jan. 31 each year.",
  ]);
});

test("PDF pages get page-scoped ids and drop bare page-number lines", () => {
  const body = sentence(9).repeat(8);
  const chunks = chunkDocument("p15.pdf", [
    {
      page: 14,
      text: `Deposit Rules\n${body}\n14\n`,
      // supplied by lib/pdf.ts from font metrics, never guessed from line shape
      headings: new Map([["Deposit Rules", 1]]),
    },
  ]);
  assert.ok(chunks.length >= 1);
  assert.equal(chunks[0].page, 14);
  assert.equal(chunks[0].id, "p15-p14-c0");
  assert.equal(chunks[0].section, "Deposit Rules");
  assert.ok(!/\n14\n/.test(chunks[0].text));
});
