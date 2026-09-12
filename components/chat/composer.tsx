"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";

const MAX_CHARS = 500;
const COUNTER_FROM = 400;
const MAX_ROWS = 5;

/** §9.4 — auto-growing textarea, Enter sends, Shift+Enter newlines. */
export function Composer({
  onSend,
  busy,
}: {
  onSend: (message: string) => void;
  busy: boolean;
}) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow to the content, capped at five rows.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const line = parseFloat(getComputedStyle(el).lineHeight) || 22;
    el.style.height = `${Math.min(el.scrollHeight, line * MAX_ROWS + 20)}px`;
  }, [value]);

  const trimmed = value.trim();
  const tooLong = trimmed.length > MAX_CHARS;
  const canSend = trimmed.length > 0 && !tooLong && !busy;

  const submit = () => {
    if (!canSend) return;
    onSend(trimmed);
    setValue("");
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="border-t border-[var(--border)] bg-[var(--bg)] px-4 py-3"
    >
      <div className="flex items-end gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-2 focus-within:border-[var(--accent)]">
        <label htmlFor="composer" className="sr-only">
          Ask a question about the corpus
        </label>
        <textarea
          id="composer"
          ref={ref}
          rows={1}
          value={value}
          // Generous enough that the counter and the inline error still get a
          // chance to appear, while stopping a giant paste outright.
          maxLength={MAX_CHARS * 2}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Ask about payroll deposits, wage bases, penalties, fringe benefits…"
          aria-invalid={tooLong}
          aria-describedby={tooLong ? "composer-error" : undefined}
          className="max-h-40 min-h-[24px] flex-1 resize-none bg-transparent px-1.5 py-1 text-[14px] leading-[1.6] outline-none placeholder:text-[var(--text-muted)]"
        />
        <button
          type="submit"
          disabled={!canSend}
          aria-label="Send question"
          className="grid size-11 shrink-0 place-items-center rounded-[var(--radius)] bg-[var(--accent)] text-[var(--accent-fg)] transition-opacity disabled:cursor-not-allowed disabled:opacity-35"
        >
          <ArrowUp size={16} />
        </button>
      </div>

      <div className="mt-1.5 flex min-h-[18px] items-center gap-3 px-1 text-[12px] text-[var(--text-muted)]">
        <span className="hidden sm:inline">
          <kbd className="font-mono">Enter</kbd> to send ·{" "}
          <kbd className="font-mono">Shift</kbd>+<kbd className="font-mono">Enter</kbd> for a newline
        </span>
        {tooLong && (
          <span id="composer-error" role="alert" className="text-[var(--danger)]">
            Questions are capped at {MAX_CHARS} characters.
          </span>
        )}
        {trimmed.length > COUNTER_FROM && (
          <span
            className={`ml-auto font-mono tabular-nums ${tooLong ? "text-[var(--danger)]" : ""}`}
          >
            {trimmed.length}/{MAX_CHARS}
          </span>
        )}
      </div>
    </form>
  );
}
