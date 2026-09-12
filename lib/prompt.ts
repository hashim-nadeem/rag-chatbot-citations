import type { Citation, Retrieved } from "./types";
import { REFUSAL } from "./types";

/** Written out in full and frozen here, never improvised at call time. */
export const SYSTEM_PROMPT = `You are a document assistant. You answer questions using ONLY the numbered context blocks supplied in the user message.

Rules, in order of importance:
1. Use only the context blocks. You have no other knowledge. Never use outside knowledge, never speculate, never guess, never fill a gap from memory.
2. End every factual sentence with one or more citation markers in square brackets, like [1] or [2][3]. The number is the number of the context block the fact came from. A sentence stating a fact without a marker is an error.
3. If the context blocks do not contain the answer, reply with exactly this and nothing else:
${REFUSAL}
4. Do not apologise, do not explain your reasoning, do not restate the question, do not mention "the context" or "the documents provided".
5. Answer in 1 to 4 sentences. Use a short bulleted list only when the question asks for several items, and cite every bullet.
6. Quote figures, dates, dollar amounts and deadlines exactly as they appear in the context.`;

/**
 * Numbered blocks. The marker numbers the model emits are 1-based positions in
 * this list, which is also the order of the citations sent to the UI.
 */
export function assembleContext(hits: Retrieved[]): string {
  return hits
    .map((hit, i) => {
      const page = hit.chunk.page === null ? "" : `, p.${hit.chunk.page}`;
      const body = hit.chunk.text.split("\n\n").slice(1).join("\n\n") || hit.chunk.text;
      return `[${i + 1}] (${hit.chunk.source} — ${hit.chunk.section}${page})\n${body}`;
    })
    .join("\n\n");
}

export function buildUserMessage(question: string, hits: Retrieved[]): string {
  return `Context blocks:\n\n${assembleContext(hits)}\n\n---\nQuestion: ${question}`;
}

export function toCitations(hits: Retrieved[]): Citation[] {
  return hits.map((hit, i) => ({
    n: i + 1,
    id: hit.chunk.id,
    source: hit.chunk.source,
    section: hit.chunk.section,
    page: hit.chunk.page,
    text: hit.chunk.text.split("\n\n").slice(1).join("\n\n") || hit.chunk.text,
    score: Math.round(hit.score * 1000) / 1000,
  }));
}
