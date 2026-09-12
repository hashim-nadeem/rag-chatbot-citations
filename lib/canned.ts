import { readFileSync } from "node:fs";
import path from "node:path";
import type { CannedAnswer } from "./types";

/**
 * Precomputed answers to the suggested questions. They cost no tokens and no
 * quota, so the demo still works after the daily free-tier limit is gone.
 */

export const normalizeQuestion = (q: string) => q.toLowerCase().replace(/\s+/g, " ").replace(/[?.!]+$/, "").trim();

let cache: CannedAnswer[] | null = null;

export function loadCanned(): CannedAnswer[] {
  if (cache) return cache;
  try {
    cache = JSON.parse(
      readFileSync(path.join(process.cwd(), "data", "canned.json"), "utf8"),
    ) as CannedAnswer[];
  } catch {
    cache = [];
  }
  return cache;
}

export function findCanned(question: string): CannedAnswer | undefined {
  const key = normalizeQuestion(question);
  return loadCanned().find((c) => normalizeQuestion(c.question) === key);
}
