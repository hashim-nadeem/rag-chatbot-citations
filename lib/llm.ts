/**
 * THE ONLY FILE IN THIS REPO THAT TALKS TO AN LLM PROVIDER.
 *
 * This shim exists so the provider is a one-file change: the app was built on a
 * free tier (Google AI Studio, Ollama for local dev) and runs unmodified on
 * Claude or GPT by editing this file only. Nothing else imports a provider SDK,
 * a provider URL, or a model id — everything downstream sees `embed()` and
 * `generateStream()` and nothing more.
 *
 * Deliberately plain `fetch` rather than a provider SDK: both APIs are a single
 * POST, and the dependency-free version is smaller than the wiring an SDK needs.
 */

export type Role = "user" | "assistant";
export type Message = { role: Role; content: string };

/** RETRIEVAL_QUERY vs RETRIEVAL_DOCUMENT measurably improves asymmetric search. */
export type EmbedKind = "document" | "query";

export type LlmErrorKind = "quota" | "unavailable" | "config";

export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

const provider = () => (process.env.LLM_PROVIDER ?? "google").toLowerCase();

/**
 * Read lazily, never at module scope: scripts load `.env.local` after the import
 * graph has already been evaluated.
 *
 * Verify these ids against your provider console — they move. `text-embedding-004`,
 * the obvious choice when this was written, has since been retired and now 404s.
 */
export const embedModel = () =>
  provider() === "ollama"
    ? (process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text")
    : (process.env.GOOGLE_EMBED_MODEL ?? "gemini-embedding-001");

const chatModel = () =>
  provider() === "ollama"
    ? (process.env.OLLAMA_MODEL ?? "llama3.2")
    : (process.env.GOOGLE_CHAT_MODEL ?? "gemini-3.6-flash");

/**
 * gemini-embedding-001 returns 3072 dimensions by default, which would make
 * data/vectors.json roughly 26 MB. It is a Matryoshka model, so truncating to 768
 * is supported and keeps the committed file near 6 MB. Cosine normalises, so the
 * renormalisation Google recommends after truncation is already covered.
 */
export const EMBED_DIMS = Number(process.env.GOOGLE_EMBED_DIMS ?? 768);

/**
 * Gemini 3 charges reasoning tokens against maxOutputTokens, so it needs an
 * explicit low level; Gemini 2.x rejects the field entirely. Defaults by family
 * and can be overridden — set it empty to omit the field altogether.
 */
const thinkingLevel = (): string =>
  process.env.GOOGLE_THINKING_LEVEL ?? (chatModel().startsWith("gemini-3") ? "low" : "");

const GOOGLE_BASE = "https://generativelanguage.googleapis.com/v1beta";
const ollamaBase = () => (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");

function googleKey(): string {
  const key = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!key) throw new LlmError("config", "GOOGLE_GENERATIVE_AI_API_KEY is not set");
  return key;
}

function classify(status: number, body: string): LlmError {
  if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(body))
    return new LlmError("quota", `provider quota exhausted (${status})`);
  return new LlmError("unavailable", `provider error ${status}: ${body.slice(0, 300)}`);
}

async function post(
  url: string,
  body: unknown,
  signal?: AbortSignal,
  headers: Record<string, string> = {},
): Promise<Response> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  }).catch((e) => {
    throw new LlmError("unavailable", `network error: ${(e as Error).message}`);
  });
  if (!res.ok) throw classify(res.status, await res.text().catch(() => ""));
  return res;
}

/**
 * Retry with exponential backoff. Free-tier limits are per-minute, so the waits
 * start long enough to outlast the window rather than burning attempts inside it.
 * A config error (missing key, dead model id) fails identically every time, so it
 * is rethrown immediately.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  attempts = 5,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof LlmError && err.kind === "config") throw err;
      if (attempt >= attempts) throw err;
      const wait = 15_000 * 2 ** (attempt - 1);
      console.warn(
        `\n  ${label}: ${(err as Error).message} — retry ${attempt}/${attempts - 1} in ${wait / 1000}s`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// ─────────────────────────────── embeddings ───────────────────────────────

export async function embed(
  texts: string[],
  kind: EmbedKind = "document",
  signal?: AbortSignal,
): Promise<number[][]> {
  if (!texts.length) return [];
  return provider() === "ollama"
    ? embedOllama(texts, signal)
    : embedGoogle(texts, kind, signal);
}

/** One vector per input, in order — a provider that drops any is an error, not a gap. */
function checkCount(got: number, want: number): void {
  if (got !== want) throw new LlmError("unavailable", `expected ${want} embeddings, got ${got}`);
}

async function embedGoogle(
  texts: string[],
  kind: EmbedKind,
  signal?: AbortSignal,
): Promise<number[][]> {
  const model = embedModel();
  const res = await post(
    `${GOOGLE_BASE}/models/${model}:batchEmbedContents`,
    {
      requests: texts.map((text) => ({
        model: `models/${model}`,
        content: { parts: [{ text }] },
        taskType: kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
        outputDimensionality: EMBED_DIMS,
      })),
    },
    signal,
    { "x-goog-api-key": googleKey() },
  );
  const json = (await res.json()) as { embeddings?: { values: number[] }[] };
  if (!json.embeddings?.length) throw new LlmError("unavailable", "no embeddings returned");
  checkCount(json.embeddings.length, texts.length);
  return json.embeddings.map((e) => e.values);
}

async function embedOllama(texts: string[], signal?: AbortSignal): Promise<number[][]> {
  const res = await post(
    `${ollamaBase()}/api/embed`,
    { model: embedModel(), input: texts },
    signal,
  );
  const json = (await res.json()) as { embeddings?: number[][] };
  if (!json.embeddings?.length) throw new LlmError("unavailable", "no embeddings returned");
  checkCount(json.embeddings.length, texts.length);
  return json.embeddings;
}

// ─────────────────────────────── generation ───────────────────────────────

export async function generateStream(
  system: string,
  messages: Message[],
  signal?: AbortSignal,
): Promise<ReadableStream<string>> {
  return provider() === "ollama"
    ? generateOllama(system, messages, signal)
    : generateGoogle(system, messages, signal);
}

/** Turn a byte stream into a string stream by feeding each decoded line to `pick`. */
function lineStream(
  body: ReadableStream<Uint8Array>,
  pick: (line: string) => string | null,
): ReadableStream<string> {
  // Acquired on first pull, not at call time: a stream that is never consumed
  // would otherwise hold the body lock open and leak the socket.
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const decoder = new TextDecoder();
  let buffer = "";

  return new ReadableStream<string>({
    async pull(controller) {
      reader ??= body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          const last = buffer.trim() && pick(buffer.trim());
          if (last) controller.enqueue(last);
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        let emitted = false;
        for (const line of lines) {
          const text = line.trim() && pick(line.trim());
          if (text) {
            controller.enqueue(text);
            emitted = true;
          }
        }
        if (emitted) return;
      }
    },
    cancel(reason) {
      void reader?.cancel(reason);
    },
  });
}

type GeminiPart = { text?: string; thought?: boolean };
type GeminiChunk = { candidates?: { content?: { parts?: GeminiPart[] } }[] };

async function generateGoogle(
  system: string,
  messages: Message[],
  signal?: AbortSignal,
): Promise<ReadableStream<string>> {
  const res = await post(
    `${GOOGLE_BASE}/models/${chatModel()}:streamGenerateContent?alt=sse`,
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      generationConfig: {
        temperature: 0,
        // Reasoning tokens are charged against this budget, so a value sized for
        // the visible answer alone truncates it mid-sentence. Measured: ~340
        // thinking tokens on a trivial prompt at the default level.
        maxOutputTokens: 2048,
        // Citing supplied context needs no deliberation, and the default level
        // roughly triples both latency and token spend for identical answers.
        // GOOGLE_THINKING_LEVEL="" opts out for a model that rejects the field.
        ...(thinkingLevel() ? { thinkingConfig: { thinkingLevel: thinkingLevel() } } : {}),
      },
    },
    signal,
    { "x-goog-api-key": googleKey() },
  );
  if (!res.body) throw new LlmError("unavailable", "empty response body");

  return lineStream(res.body, (line) => {
    if (!line.startsWith("data:")) return null;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return null;
    try {
      const parsed = JSON.parse(payload) as GeminiChunk;
      // Gemini 3 can interleave reasoning parts; those are not the answer.
      return (
        parsed.candidates?.[0]?.content?.parts
          ?.filter((p) => !p.thought)
          .map((p) => p.text ?? "")
          .join("") || null
      );
    } catch {
      return null;
    }
  });
}

async function generateOllama(
  system: string,
  messages: Message[],
  signal?: AbortSignal,
): Promise<ReadableStream<string>> {
  const res = await post(
    `${ollamaBase()}/api/chat`,
    {
      model: chatModel(),
      stream: true,
      options: { temperature: 0 },
      messages: [{ role: "system", content: system }, ...messages],
    },
    signal,
  );
  if (!res.body) throw new LlmError("unavailable", "empty response body");

  return lineStream(res.body, (line) => {
    try {
      return (JSON.parse(line) as { message?: { content?: string } }).message?.content || null;
    } catch {
      return null;
    }
  });
}

/** Convenience for the eval runner and the canned-answer script. */
export async function generateText(system: string, messages: Message[]): Promise<string> {
  const stream = await generateStream(system, messages);
  let out = "";
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += value;
  }
  return out;
}
