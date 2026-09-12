import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Read at build time and rendered into the stat bar. These are the numbers a
 * client sees first, so they come from the generated artefacts — never typed in
 * by hand, never rounded up.
 */
export type Stats = {
  chunks: number | null;
  sources: string[];
  answerAccuracy: number | null;
  meanLatencyMs: number | null;
  evalDate: string | null;
};

type IndexMeta = { chunks: number; sources: string[] };
type EvalResults = { answerAccuracy: number; meanLatencyMs: number; ranAt: string };

// Statically scoped so Next's tracer includes exactly these two files, not the repo.
const readJson = <T,>(file: string): T | null => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
};

export function getStats(): Stats {
  const index = readJson<IndexMeta>(path.join(process.cwd(), "data", "index-meta.json"));
  const evals = readJson<EvalResults>(path.join(process.cwd(), "evals", "results.json"));
  return {
    chunks: index?.chunks ?? null,
    sources: index?.sources ?? [],
    answerAccuracy: evals?.answerAccuracy ?? null,
    meanLatencyMs: evals?.meanLatencyMs ?? null,
    evalDate: evals?.ranAt?.slice(0, 10) ?? null,
  };
}
