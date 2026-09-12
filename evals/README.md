# Eval suite

`questions.jsonl` — 30 questions: **25 answerable, 5 deliberately not**. The
unanswerable five are plausible (things the corpus *sounds* like it should cover),
because that is what makes them a hallucination test rather than a gimme.

Every `expectedSourceIds` value is a real chunk id from `data/vectors.json`, and every
`expectedContains` string is a verbatim fact from the corpus. Nothing here is invented.

```bash
npm run sweep   # retrieval only — deterministic, no generation calls
npm run eval    # full run: writes RESULTS.md and results.json
```

`RESULTS.md` and `results.json` are **generated** and are not committed until a clean
run produces them. The runner will not publish a contaminated score: if any question
fails on a provider error it is excluded from the metrics, `RESULTS.md` is stamped
`INCOMPLETE`, `results.json` (which the app's stat bar reads) is withheld, and the
process exits non-zero.
