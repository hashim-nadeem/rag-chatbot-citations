"use client";

import { motion, useReducedMotion } from "motion/react";

/** §9.4 — 8 chips above the composer while the transcript is empty. */
export function SuggestedQuestions({
  questions,
  onPick,
}: {
  questions: string[];
  onPick: (q: string) => void;
}) {
  const reduced = useReducedMotion();
  if (!questions.length) return null;

  return (
    <div>
      <p className="mb-2.5 text-[13px] text-[var(--text-muted)]">
        Try one of these — they answer instantly from{" "}
        <code className="font-mono text-[12px]">data/canned.json</code>, with no model call.
      </p>
      <ul className="flex flex-wrap gap-2">
        {questions.map((q, i) => (
          <motion.li
            key={q}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: "easeOut", delay: reduced ? 0 : i * 0.06 }}
          >
            <button
              type="button"
              onClick={() => onPick(q)}
              className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-left text-[13px] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              {q}
            </button>
          </motion.li>
        ))}
      </ul>
    </div>
  );
}
