import type { Stats } from "@/lib/stats";

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
const ms = (v: number | null) => (v === null ? "—" : `~${Math.round(v)} ms`);
const num = (v: number | null) => (v === null ? "—" : v.toLocaleString("en-US"));

function Figure({ value, label, title }: { value: string; label: string; title: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5" title={title}>
      <span className="font-mono text-[15px] leading-none font-medium tabular-nums">{value}</span>
      <span className="text-[11px] tracking-[0.08em] text-[var(--text-muted)] uppercase">{label}</span>
    </div>
  );
}

/** §9.3 — three mono figures directly under the header. Real values, or an em dash. */
export function StatBar({ stats }: { stats: Stats }) {
  return (
    <div
      role="status"
      aria-label="Index and evaluation statistics"
      className="grid grid-cols-2 gap-x-6 gap-y-3 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-3 sm:flex sm:items-center sm:gap-8"
    >
      <Figure
        value={pct(stats.answerAccuracy)}
        label="eval"
        title={
          stats.evalDate
            ? `Answer accuracy on evals/questions.jsonl, measured ${stats.evalDate}`
            : "Run npm run eval to publish a score"
        }
      />
      <Figure value={num(stats.chunks)} label="chunks" title="Embedded chunks in data/vectors.json" />
      <Figure
        value={ms(stats.meanLatencyMs)}
        label="latency"
        title="Mean retrieve + generate time per answered question in the eval run. Excludes query embedding, which is cached across runs."
      />
      {stats.answerAccuracy === null && (
        <p className="col-span-2 text-[12px] text-[var(--text-muted)] sm:ml-auto sm:max-w-[18rem] sm:text-right">
          Scores appear once <code className="font-mono">npm run eval</code> has been run.
        </p>
      )}
    </div>
  );
}
