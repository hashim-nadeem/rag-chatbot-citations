import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFParse } from "pdf-parse";
import type { Page } from "./chunk";

/**
 * Extracted PDF text carries no structure, and guessing headings from line
 * shape alone fails badly: hard-wrapped body lines look exactly like headings.
 * The reliable signal is typography, so headings come from pdfjs font metrics
 * (a heading is set larger than the page's dominant body size) while the body
 * text keeps pdf-parse's reading order, which already handles the two-column
 * layout correctly.
 */

const MAJOR = 1.15; // a heading is at least 15% taller than body text
const H1 = 1.5; // ...and 50% taller means a top-level section head
const MAX_HEADING_CHARS = 60;

export const normalizeLine = (s: string) => s.replace(/\s+/g, " ").trim();

type Item = { str: string; height: number; x: number; y: number };

function looksLikeHeading(text: string): boolean {
  if (text.length < 3 || text.length > MAX_HEADING_CHARS) return false;
  if (!/[A-Za-z]{2}/.test(text)) return false; // bullet glyphs, rule lines, page numbers
  if (/[.,;:]$/.test(text)) return false; // a sentence set in display type is still a sentence
  if (/-$/.test(text)) return false; // hyphenated wrap: body text, not a heading
  return true;
}

/** Heading lines for one page, keyed by normalized text -> level (1 or 2). */
async function headingsForPage(
  doc: Awaited<ReturnType<typeof getDocument>["promise"]>,
  pageNum: number,
): Promise<Map<string, number>> {
  const page = await doc.getPage(pageNum);
  const pageWidth = page.getViewport({ scale: 1 }).width;
  const content = await page.getTextContent();
  const items: Item[] = (content.items as { str?: string; height?: number; transform?: number[] }[])
    .filter((i) => i.str?.trim())
    .map((i) => ({
      str: i.str as string,
      height: Math.round(i.height ?? 0),
      x: i.transform?.[4] ?? 0,
      y: i.transform?.[5] ?? 0,
    }));
  page.cleanup();
  if (!items.length) return new Map();

  // Body size = the height that covers the most characters on the page.
  const weight = new Map<number, number>();
  for (const i of items) weight.set(i.height, (weight.get(i.height) ?? 0) + i.str.length);
  const body = [...weight].sort((a, b) => b[1] - a[1])[0][0];
  if (!body) return new Map();

  // Group into visual lines: same baseline band, same column. Both bands are
  // derived from the page rather than hardcoded — a fixed pixel split silently
  // misgroups columns on any page size other than the one it was tuned against,
  // which degrades heading detection with no error to notice.
  const midX = pageWidth / 2;
  const band = Math.max(2, Math.round(body / 3));
  const lines = new Map<string, Item[]>();
  for (const i of items) {
    const key = `${Math.round(i.y / band)}|${i.x < midX ? 0 : 1}`;
    const bucket = lines.get(key);
    if (bucket) bucket.push(i);
    else lines.set(key, [i]);
  }

  const out = new Map<string, number>();
  for (const bucket of lines.values()) {
    if (!bucket.every((i) => i.height >= body * MAJOR)) continue;
    bucket.sort((a, b) => a.x - b.x);
    const text = normalizeLine(bucket.map((i) => i.str).join(""));
    if (!looksLikeHeading(text)) continue;
    const tallest = Math.max(...bucket.map((i) => i.height));
    out.set(text, tallest >= body * H1 ? 1 : 2);
  }
  return out;
}

export async function extractPdf(data: Uint8Array): Promise<Page[]> {
  const parser = new PDFParse({ data: new Uint8Array(data) });
  let pages: { num: number; text: string }[];
  try {
    pages = (await parser.getText()).pages;
  } finally {
    await parser.destroy();
  }

  const doc = await getDocument({ data: new Uint8Array(data) }).promise;
  try {
    const out: Page[] = [];
    for (const { num, text } of pages) {
      out.push({ page: num, text, headings: await headingsForPage(doc, num) });
    }
    return out;
  } finally {
    await doc.destroy();
  }
}
