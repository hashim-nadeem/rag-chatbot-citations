export type Chunk = {
  id: string; // "p15-p14-c3"
  text: string; // chunk body, prefixed with its section path
  source: string; // file name, e.g. "p15.pdf"
  section: string; // nearest heading path, e.g. "Grading > Appeals"
  page: number | null; // for PDFs
  index: number; // ordinal within the document
};

export type EmbeddedChunk = Chunk & { vector: number[] };

export type VectorStore = {
  model: string;
  dims: number;
  createdAt: string;
  chunks: EmbeddedChunk[];
};

export type Retrieved = { chunk: Chunk; score: number };

/** What the UI needs to render a citation chip and its drawer. */
export type Citation = {
  n: number; // marker number, 1-based, matches [n] in the answer
  id: string;
  source: string;
  section: string;
  page: number | null;
  text: string;
  score: number;
};

export type ChatRequest = {
  message: string;
};

/** Sent as the first line of the stream, before any answer tokens. */
export type ChatMeta = {
  citations: Citation[];
  refused: boolean;
  cached: boolean;
};

export type CannedAnswer = {
  question: string;
  answer: string;
  citations: Citation[];
};

export const REFUSAL = "I couldn't find that in the documents.";
