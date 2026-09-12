import { z } from "zod";
import { embed, generateStream, LlmError } from "@/lib/llm";
import { retrieve, vectorsReady } from "@/lib/retrieval";
import { buildUserMessage, SYSTEM_PROMPT, toCitations } from "@/lib/prompt";
import { checkRateLimit, clientIp } from "@/lib/ratelimit";
import { findCanned } from "@/lib/canned";
import { REFUSAL, type ChatMeta } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Vercel's default function timeout is 10s, which a streamed answer can exceed:
 * generation plus reasoning tokens regularly runs longer, and the stream would
 * be cut mid-sentence. 60s is the Hobby ceiling and far more than any real
 * answer needs — it is a safety net, not a target.
 */
export const maxDuration = 60;

const Body = z.object({
  message: z.string().trim().min(1, "Ask a question first.").max(500, "Questions are capped at 500 characters."),
});

const encoder = new TextEncoder();
const line = (obj: unknown) => encoder.encode(`${JSON.stringify(obj)}\n`);

/** NDJSON: one meta line, then one {"t": "..."} line per token. */
function ndjson(meta: ChatMeta, tokens: ReadableStream<string> | string): Response {
  let reader: ReadableStreamDefaultReader<string> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(line({ meta }));
      if (typeof tokens === "string") {
        controller.enqueue(line({ t: tokens }));
        controller.close();
      }
    },
    // pull() rather than draining in start(): the consumer's demand paces the
    // upstream read instead of the whole answer buffering into the queue.
    async pull(controller) {
      if (typeof tokens === "string") return;
      reader ??= tokens.getReader();
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        if (value) controller.enqueue(line({ t: value }));
      } catch (err) {
        console.error("[chat] stream aborted:", err);
        controller.enqueue(line({ error: "The model didn't respond. Try again." }));
        controller.close();
      }
    },
    cancel(reason) {
      // The client went away: stop reading so the provider request is dropped
      // rather than billed to completion.
      void reader?.cancel(reason);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}

const fail = (status: number, message: string) =>
  Response.json({ error: message }, { status, headers: { "cache-control": "no-store" } });

/** The longest legal body is a 500-char question plus JSON framing; 4 KB is generous. */
const MAX_BODY_BYTES = 4096;

/**
 * Reads the body with a hard byte ceiling, returning null if it is exceeded.
 *
 * `req.json()` would materialise the whole payload before the 500-character
 * field limit is ever applied. `content-length` is checked first as a cheap
 * reject, but it is client-supplied and a chunked request need not send it, so
 * the real limit is enforced against the stream as it arrives.
 */
async function readBounded(req: Request, max: number): Promise<string | null> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return null;
  if (!req.body) {
    const text = await req.text();
    return text.length > max ? null : text;
  }
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        return null;
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(parts));
}

export async function POST(req: Request) {
  let message: string;
  try {
    const raw = await readBounded(req, MAX_BODY_BYTES);
    if (raw === null) return fail(413, "That request is too large.");
    const parsed = Body.safeParse(JSON.parse(raw));
    if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? "Invalid request.");
    message = parsed.data.message;
  } catch {
    return fail(400, "Invalid request.");
  }

  if (!(await checkRateLimit(clientIp(req))).ok) {
    return fail(
      429,
      "You've hit the demo limit — try again in an hour. The example questions below still work.",
    );
  }

  // A suggested question: answered from disk, no LLM call, no quota consumed.
  const canned = findCanned(message);
  if (canned) {
    return ndjson({ citations: canned.citations, refused: false, cached: true }, canned.answer);
  }

  if (!vectorsReady()) {
    return fail(503, "The document index hasn't been built yet. Run `npm run embed`.");
  }

  try {
    // req.signal aborts when the client disconnects, so an abandoned request
    // stops costing embedding and generation quota the moment the tab closes.
    const [queryVector] = await embed([message], "query", req.signal);
    const hits = retrieve(queryVector, 5);

    // THE GUARD: nothing cleared the similarity floor, so the model is never asked.
    if (hits.length === 0) {
      return ndjson({ citations: [], refused: true, cached: false }, REFUSAL);
    }

    const stream = await generateStream(
      SYSTEM_PROMPT,
      [{ role: "user", content: buildUserMessage(message, hits) }],
      req.signal,
    );
    return ndjson({ citations: toCitations(hits), refused: false, cached: false }, stream);
  } catch (err) {
    // A disconnect is the expected end of an abandoned request, not an incident.
    if (req.signal.aborted) return new Response(null, { status: 499 });
    console.error("[chat]", err);
    if (err instanceof LlmError && err.kind === "quota") {
      return fail(503, "Live demo quota reached for today. The example questions below still work.");
    }
    if (err instanceof LlmError && err.kind === "config") {
      return fail(503, "The demo isn't configured with a model provider yet.");
    }
    return fail(502, "The model didn't respond. Try again.");
  }
}
