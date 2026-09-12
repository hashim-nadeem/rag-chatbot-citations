"use client";

import type { Citation } from "@/lib/types";

/** §9.4 — inline [n] as a small mono pill. Focusable, and opens the source drawer. */
export function CitationChip({
  citation,
  onOpen,
}: {
  citation: Citation;
  onOpen: (c: Citation) => void;
}) {
  const page = citation.page === null ? "" : `, p.${citation.page}`;
  return (
    <button
      type="button"
      onClick={() => onOpen(citation)}
      aria-label={`Source ${citation.n}: ${citation.source}, ${citation.section}${page}. Open the cited passage.`}
      className="mx-0.5 inline-flex rounded-[4px] bg-[var(--accent-soft)] px-1.5 py-px align-baseline font-mono text-[11px] leading-[1.4] font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--accent-fg)]"
    >
      {citation.n}
    </button>
  );
}
