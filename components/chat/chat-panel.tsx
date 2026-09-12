"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import type { Citation, ChatMeta } from "@/lib/types";
import { Message, type ChatMessage } from "./message";
import { Composer } from "./composer";
import { SuggestedQuestions } from "./suggested-questions";
import { SourceDrawer } from "./source-drawer";

const NETWORK_ERROR = "The model didn't respond. Try again.";

let seq = 0;
const nextId = () => `m${++seq}`;

export function ChatPanel({ suggestions }: { suggestions: string[] }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<Citation | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  // setMessages is stable, so this is safe to leave out of send()'s deps.
  const patch = useCallback(
    (id: string, update: Partial<ChatMessage>) =>
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...update } : m))),
    [],
  );

  // Abort an in-flight request when the component unmounts, so the server sees
  // the disconnect and stops paying for a response nobody will read.
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => () => inFlight.current?.abort(), []);

  const send = useCallback(
    async (question: string) => {
      const answerId = nextId();
      const controller = new AbortController();
      inFlight.current?.abort();
      inFlight.current = controller;
      setBusy(true);
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: "user", content: question, citations: [], refused: false, cached: false },
        {
          id: answerId,
          role: "assistant",
          content: "",
          citations: [],
          refused: false,
          cached: false,
          streaming: true,
        },
      ]);

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: question }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          const { error } = (await res.json().catch(() => ({}))) as { error?: string };
          patch(answerId, { error: error ?? NETWORK_ERROR, streaming: false });
          return;
        }

        // NDJSON: a meta line with the citations, then one line per token.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let content = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const raw of lines) {
            if (!raw.trim()) continue;
            // Parsed per line: one malformed frame from an intermediary must not
            // throw away an answer that has already partly streamed in.
            let evt: { meta?: ChatMeta; t?: string; error?: string };
            try {
              evt = JSON.parse(raw);
            } catch {
              console.warn("[chat] skipping unparseable stream line");
              continue;
            }
            if (evt.meta) patch(answerId, { citations: evt.meta.citations, refused: evt.meta.refused, cached: evt.meta.cached });
            if (evt.t) {
              content += evt.t;
              patch(answerId, { content });
            }
            if (evt.error) patch(answerId, { error: evt.error });
          }
        }
        patch(answerId, { streaming: false });
      } catch (err) {
        // An abort is this component tearing down, not a failure worth showing.
        if ((err as Error)?.name === "AbortError") return;
        console.error(err);
        patch(answerId, { error: NETWORK_ERROR, streaming: false });
      } finally {
        if (inFlight.current === controller) {
          inFlight.current = null;
          setBusy(false);
        }
      }
    },
    [patch],
  );

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-5">
          {messages.length === 0 ? (
            <div className="space-y-6">
              <div>
                <h2 className="text-[20px] font-semibold tracking-tight">
                  Ask the IRS employer tax guides
                </h2>
                <p className="mt-1.5 max-w-[68ch] text-[var(--text-muted)]">
                  Every answer cites the exact chunk it came from — click a{" "}
                  <span className="rounded-[4px] bg-[var(--accent-soft)] px-1.5 py-px font-mono text-[11px] text-[var(--accent)]">
                    1
                  </span>{" "}
                  to read the source passage. Ask something the documents don&apos;t cover and it
                  refuses instead of guessing.
                </p>
              </div>
              <SuggestedQuestions questions={suggestions} onPick={send} />
            </div>
          ) : (
            <div className="space-y-4" aria-live="polite" aria-atomic="false">
              <AnimatePresence initial={false}>
                {messages.map((m) => (
                  <Message key={m.id} message={m} onOpenSource={setSource} />
                ))}
              </AnimatePresence>
              <div ref={endRef} />
            </div>
          )}
        </div>

        <Composer onSend={send} busy={busy} />
      </div>

      <SourceDrawer citation={source} onClose={() => setSource(null)} />
    </>
  );
}
