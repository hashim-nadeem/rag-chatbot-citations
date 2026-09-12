# Corpus provenance

Both documents are works of the United States federal government prepared by the
Internal Revenue Service. Under **17 U.S.C. § 105** works of the U.S. government
are not subject to copyright in the United States and are in the **public
domain**. They are redistributed here unmodified.

| File | Title | Edition | Pages | Retrieved | Source URL |
|---|---|---|---|---|---|
| `p15.pdf` | Publication 15 (Circular E), Employer's Tax Guide | For use in 2026 | 59 | 2026-09-08 | https://www.irs.gov/pub/irs-pdf/p15.pdf |
| `p15b.pdf` | Publication 15-B, Employer's Tax Guide to Fringe Benefits | For use in 2026 | 36 | 2026-09-08 | https://www.irs.gov/pub/irs-pdf/p15b.pdf |

## Why this corpus

- **Public domain**, so it can be published with the demo without a licensing question.
- **95 pages** — non-trivial, but small enough to embed in a single run.
- **Dense with checkable facts**: dollar thresholds, tax rates, deposit deadlines,
  penalty schedules, exclusion limits. Every eval answer is a specific string that
  either appears or does not.
- **Edition-specific numbers.** The 2026 figures (a $184,500 social security wage
  base, a $3,400 health FSA limit, a $340 monthly parking exclusion) are exactly
  the kind of value a general-purpose model states confidently and gets wrong.
  Retrieval has to do real work here, which is the point.
- **A plausible business use case.** "What does our payroll obligation actually
  say?" is a question a real client has about their own documents.

## Not tax advice

The demo answers questions *about the text of these documents*. It is not tax
advice, and the app footer says so.
