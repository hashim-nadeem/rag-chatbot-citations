"use client";

import { motion, useReducedMotion } from "motion/react";
import { AlertTriangle, FileSearch } from "lucide-react";
import type { Citation } from "@/lib/types";
import { CitationChip } from "./citation-chip";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
  refused: boolean;
  cached: boolean;
  error?: string;
  streaming?: boolean;
};

/** Split an answer on [n] markers and swap each one for a chip. */
function renderWithCitations(
  text: string,
  citations: Citation[],
  onOpen: (c: Citation) => void,
): React.ReactNode[] {
  const byNumber = new Map(citations.map((c) => [c.n, c]));
  const out: React.ReactNode[] = [];
  const re = /\[(\d{1,2})\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;

  while ((m = re.exec(text))) {
    const citation = byNumber.get(Number(m[1]));
    // A marker with no matching block is left as literal text rather than
    // rendered as a chip that would open nothing.
    if (!citation) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<CitationChip key={`c${key++}`} citation={citation} onOpen={onOpen} />);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Bare-minimum block rendering: paragraphs, and bullets when the model lists things. */
function Body({
  text,
  citations,
  onOpen,
}: {
  text: string;
  citations: Citation[];
  onOpen: (c: Citation) => void;
}) {
  const lines = text.split("\n").filter((l) => l.trim());
  const nodes: React.ReactNode[] = [];
  let bullets: string[] = [];

  const flush = () => {
    if (!bullets.length) return;
    nodes.push(
      <ul key={`u${nodes.length}`} className="my-1 list-disc space-y-1 pl-5">
        {bullets.map((b, i) => (
          <li key={i}>{renderWithCitations(b, citations, onOpen)}</li>
        ))}
      </ul>,
    );
    bullets = [];
  };

  for (const line of lines) {
    const bullet = line.match(/^\s*(?:[-*\u2022]|\d+\.)\s+(.*)$/);
    if (bullet) bullets.push(bullet[1]);
    else {
      flush();
      nodes.push(
        <p key={`p${nodes.length}`} className="my-1 first:mt-0 last:mb-0">
          {renderWithCitations(line, citations, onOpen)}
        </p>,
      );
    }
  }
  flush();
  return <>{nodes}</>;
}

export function Message({
  message,
  onOpenSource,
}: {
  message: ChatMessage;
  onOpenSource: (c: Citation) => void;
}) {
  const reduced = useReducedMotion();
  const entry = reduced
    ? { initial: { opacity: 0 }, animate: { opacity: 1 } }
    : { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 } };

  if (message.role === "user") {
    return (
      <motion.div
        {...entry}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className="flex justify-end"
      >
        <p className="max-w-[80%] rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2.5 text-[var(--accent-fg)]">
          {message.content}
        </p>
      </motion.div>
    );
  }

  if (message.error) {
    return (
      <motion.div
        {...entry}
        transition={{ duration: 0.2, ease: "easeOut" }}
        role="alert"
        className="flex items-start gap-2.5 rounded-[var(--radius)] border border-[var(--danger)]/40 bg-[var(--surface)] p-4 text-[var(--text-muted)]"
      >
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-[var(--danger)]" aria-hidden />
        <p>{message.error}</p>
      </motion.div>
    );
  }

  // §9.4 — the refusal is the feature, so it gets its own deliberate treatment.
  if (message.refused) {
    return (
      <motion.div
        {...entry}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className="rounded-[var(--radius)] border border-dashed border-[var(--border)] bg-[var(--surface)] p-4"
      >
        <div className="flex items-start gap-2.5">
          <FileSearch size={16} className="mt-0.5 shrink-0 text-[var(--text-muted)]" aria-hidden />
          <div>
            <p className="text-[var(--text)]">{message.content}</p>
            <p className="mt-1.5 text-[13px] text-[var(--text-muted)]">
              Nothing in the corpus covers this — the model was not asked.
            </p>
          </div>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      {...entry}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4"
    >
      <div className={message.streaming && message.content ? "caret" : undefined}>
        {message.content ? (
          <Body text={message.content} citations={message.citations} onOpen={onOpenSource} />
        ) : (
          <span className="sr-only">Retrieving</span>
        )}
        {!message.content && (
          <div aria-hidden className="space-y-2">
            <div className="h-3 w-4/5 animate-pulse rounded bg-[var(--surface-2)]" />
            <div className="h-3 w-3/5 animate-pulse rounded bg-[var(--surface-2)]" />
          </div>
        )}
      </div>

      {message.citations.length > 0 && !message.streaming && (
        <p className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-[var(--border)] pt-2.5 text-[12px] text-[var(--text-muted)]">
          <span>Sources</span>
          {message.citations.map((c) => (
            <CitationChip key={c.n} citation={c} onOpen={onOpenSource} />
          ))}
          {message.cached && <span className="ml-auto font-mono text-[11px]">cached · 0 tokens</span>}
        </p>
      )}
    </motion.div>
  );
}
