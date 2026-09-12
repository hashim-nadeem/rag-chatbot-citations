"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import type { Citation } from "@/lib/types";

/**
 * A native <dialog>: the platform supplies the focus trap, Escape-to-close and
 * inertness that a hand-rolled slide-over gets wrong. Slide-over on desktop,
 * bottom sheet under 640px (§9.7).
 *
 * This is the component that proves retrieval is real rather than the model
 * improvising, so it shows the whole stored chunk, not an excerpt.
 */
export function SourceDrawer({
  citation,
  onClose,
}: {
  citation: Citation | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (citation && !el.open) el.showModal();
    if (!citation && el.open) el.close();
  }, [citation]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        // A modal <dialog> IS its own backdrop: clicks outside the panel land on
        // the dialog element itself, and the panel below stops propagation.
        // Keep the panel as this element's only child, or this stops matching.
        if (e.target === ref.current) onClose();
      }}
      aria-label="Cited source passage"
      className="m-0 h-full max-h-full w-full bg-transparent p-0 backdrop:bg-black/40 open:ml-auto sm:w-[min(30rem,100vw)]"
    >
      {citation && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="motion-safe:animate-[drawer-in_250ms_ease-in-out] flex h-full flex-col border-l border-[var(--border)] bg-[var(--bg)] text-[var(--text)] max-sm:mt-auto max-sm:h-[85vh] max-sm:rounded-t-[var(--radius)] max-sm:border-t max-sm:border-l-0"
        >
          <header className="flex items-start gap-3 border-b border-[var(--border)] px-5 py-4">
            <div className="min-w-0 flex-1">
              <p className="font-mono text-[13px] break-words text-[var(--text)]">{citation.source}</p>
              <p className="mt-1 text-[13px] break-words text-[var(--text-muted)]">
                {citation.section}
                {citation.page !== null && (
                  <span className="font-mono"> · p.{citation.page}</span>
                )}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span
                title="Cosine similarity to the question"
                className="rounded-[4px] bg-[var(--accent-soft)] px-1.5 py-0.5 font-mono text-[12px] tabular-nums text-[var(--accent)]"
              >
                {citation.score.toFixed(2)}
              </span>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close source"
                className="grid size-11 place-items-center rounded-[var(--radius)] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
              >
                <X size={16} />
              </button>
            </div>
          </header>

          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <p className="mb-2 font-mono text-[11px] tracking-[0.08em] text-[var(--text-muted)] uppercase">
              chunk {citation.id}
            </p>
            <p className="rounded-[var(--radius)] border border-[var(--accent-soft)] bg-[var(--accent-soft)] p-3 text-[14px] leading-[1.7] whitespace-pre-wrap">
              {citation.text}
            </p>
            <p className="mt-4 text-[12px] text-[var(--text-muted)]">
              This is the exact text that was sent to the model as context block [{citation.n}].
            </p>
          </div>
        </div>
      )}
    </dialog>
  );
}
