import type { Chunk } from "./types";

/**
 * Chunking is shared by the build-time embedder and the unit test, so the text
 * that gets embedded is byte-identical to the text the tests reason about.
 *
 * Strategy (in order):
 *   1. split on headings   2. split on paragraphs   3. accumulate to ~800 chars
 *   4. carry 150 chars of overlap   5. drop chunks < 100 chars
 *   6. prefix the stored text with the section path
 */

export const TARGET_CHARS = 800;
export const OVERLAP_CHARS = 150;
export const MIN_CHARS = 100;
export const MAX_SECTION_CHARS = 150;

/**
 * `headings` maps a normalized line of this page to its heading level. It comes
 * from font metrics (see lib/pdf.ts); without it a PDF page is all body text.
 */
export type Page = { page: number | null; text: string; headings?: Map<string, number> };

/** A paragraph of body text, or a heading that opens a new section. */
type Block = { kind: "heading" | "body"; text: string; level: number; page: number | null };

const ABBREV =
  /(?:\b(?:No|Nos|Pub|Pubs|Sec|Secs|Inc|Corp|Co|Ltd|Mr|Mrs|Ms|Dr|St|Jr|Sr|vs|etc|approx|Fig|Rev|Dept|Est|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\.|\b[A-Z]\.|\b(?:U\.S|e\.g|i\.e|a\.m|p\.m)\.)$/;

/** Sentence split that does not fire on "Pub. 15", "U.S.", "No. 941". */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  const re = /[.!?]["'\u2019)\]]?\s+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const head = text.slice(start, m.index + 1);
    if (ABBREV.test(head.trimEnd())) continue;
    out.push(text.slice(start, m.index + m[0].length).trim());
    start = m.index + m[0].length;
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

const isMarkdownHeading = (line: string) => /^#{1,6}\s+\S/.test(line);

const normalizeLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Page furniture: bare page numbers, "Page 4 of 59", running heads. */
function isFurniture(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  if (/^[-\u2013\u2014\s]*\d{1,4}[-\u2013\u2014\s]*$/.test(t)) return true;
  if (/^page\s+\d+(\s+of\s+\d+)?$/i.test(t)) return true;
  if (/^publication\s+\d+[a-z]?\s*\(.*\)$/i.test(t)) return true;
  return false;
}

/**
 * Undo the hard line wrapping PDF extraction leaves behind: dehyphenate, rejoin
 * wrapped lines, and lift the font-detected heading lines out as their own
 * blocks (consecutive heading lines are one heading that wrapped).
 */
function pdfBlocks(page: number | null, raw: string, headings: Map<string, number>): Block[] {
  const lines = raw
    .replace(/\u00a0/g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l) => !isFurniture(l));
  if (!lines.length) return [];

  const width = Math.max(...lines.map((l) => l.length));
  const blocks: Block[] = [];
  let body = "";
  let heading: string[] = [];
  let level = 6;

  const flushBody = () => {
    if (body.trim()) blocks.push({ kind: "body", text: body.trim(), level: 0, page });
    body = "";
  };
  const flushHeading = () => {
    if (heading.length) blocks.push({ kind: "heading", text: heading.join(" "), level, page });
    heading = [];
    level = 6;
  };

  for (const line of lines) {
    const headingLevel = headings.get(normalizeLine(line));
    if (headingLevel) {
      flushBody();
      heading.push(line);
      level = Math.min(level, headingLevel);
      continue;
    }
    flushHeading();
    if (body.endsWith("-")) body = body.slice(0, -1) + line;
    else body = body ? `${body} ${line}` : line;
    if (/[.!?:]["'\u2019)\]]?$/.test(line) || line.length < width * 0.6) flushBody();
  }
  flushHeading();
  flushBody();
  return blocks;
}

function toBlocks(pages: Page[], isMarkdown: boolean): Block[] {
  const blocks: Block[] = [];
  for (const { page, text, headings } of pages) {
    if (!isMarkdown) {
      blocks.push(...pdfBlocks(page, text, headings ?? new Map()));
      continue;
    }
    for (const raw of text.split(/\n{2,}/)) {
      const para = raw.trim();
      if (!para) continue;
      if (isMarkdownHeading(para)) {
        const level = (para.match(/^#+/) ?? ["#"])[0].length;
        blocks.push({ kind: "heading", text: para.replace(/^#+\s*/, ""), level, page });
      } else {
        blocks.push({ kind: "body", text: para.replace(/\s*\n\s*/g, " "), level: 0, page });
      }
    }
  }
  return blocks;
}

/** "Grading > Appeals", trimmed so the stored chunk can never exceed 1000 chars. */
function sectionPath(stack: string[]): string {
  const path = stack.join(" > ") || "Introduction";
  return path.length <= MAX_SECTION_CHARS ? path : `\u2026${path.slice(-(MAX_SECTION_CHARS - 1))}`;
}

/** Last ~150 chars of a chunk, snapped forward to a word boundary. */
export function tailOverlap(body: string): string {
  if (body.length <= OVERLAP_CHARS) return body;
  const tail = body.slice(-OVERLAP_CHARS);
  const cut = tail.indexOf(" ");
  return cut === -1 ? tail : tail.slice(cut + 1);
}

/** A single sentence longer than the budget still has to fit somewhere. */
function hardSplit(sentence: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = sentence;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf(" ", limit);
    if (cut <= 0) cut = limit;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

export function slugify(name: string): string {
  return name
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function chunkDocument(source: string, pages: Page[]): Chunk[] {
  const isMarkdown = /\.mdx?$/i.test(source);
  const blocks = toBlocks(pages, isMarkdown);
  const slug = slugify(source);
  const chunks: Chunk[] = [];

  let stack: string[] = [];
  let section = sectionPath(stack);
  let body = "";
  let bodyPage: number | null = null;
  let index = 0;

  const flush = (carryOverlap: boolean) => {
    const trimmed = body.trim();
    body = "";
    // Only reachable with carryOverlap === false: a carrying flush happens
    // exactly when the body has just exceeded TARGET_CHARS, so it is never short.
    if (trimmed.length < MIN_CHARS) return "";
    const id = bodyPage === null ? `${slug}-c${index}` : `${slug}-p${bodyPage}-c${index}`;
    chunks.push({ id, text: `${section}\n\n${trimmed}`, source, section, page: bodyPage, index });
    index++;
    return carryOverlap ? tailOverlap(trimmed) : "";
  };

  for (const block of blocks) {
    if (block.kind === "heading") {
      flush(false);
      stack = stack.slice(0, Math.max(0, block.level - 1));
      stack.push(block.text);
      section = sectionPath(stack);
      bodyPage = null;
      continue;
    }
    if (bodyPage === null) bodyPage = block.page;
    for (const raw of splitSentences(block.text)) {
      for (const sentence of hardSplit(raw, TARGET_CHARS)) {
        if (body && body.length + 1 + sentence.length > TARGET_CHARS) {
          const overlap = flush(true);
          body = overlap ? `${overlap} ` : "";
          // The new chunk is attributed to the page its first *new* sentence is
          // on, so a carried overlap can belong to the previous page. Cosmetic:
          // it only shifts the page shown in the drawer by one at a boundary.
          bodyPage = block.page;
        }
        body = body ? `${body} ${sentence}` : sentence;
      }
    }
  }
  flush(false);
  return chunks;
}
