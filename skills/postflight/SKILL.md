---
name: postflight
description: Complete doc sync, the change ledger, index correction, and hash stamping at wrap-up. Use after a phase/feature/fix is complete, before review or merge; also responds to the Stop reminder "run postflight".
---

# Post-work Doc Wrap-up (postflight)

## Steps

1. **Get the reconciliation checklist (report-driven)**: `node "${CLAUDE_PLUGIN_ROOT}/scripts/doc-preflight.mjs" --cwd .` — use `driftCandidates` + `docDrift` as this round's reconciliation checklist (the scope matches the stamp's scope). If `mapIssues` is non-empty, fix the mapping first (elements are `{code, message}`, dispatch by code; `baseline-corrupt` is naturally fixed by the step-7 stamp).
2. **Get the affected anchors (report-driven)**: each `driftCandidates` entry already carries its own `docs` (the anchors this file hits, merged and deduplicated) and `kind` (modified/new/removed); reading it directly gives the "file → affected anchors" list, with no need to manually re-derive it against map.json patterns; `docDrift` files are themselves the docs where the anchors live — verify each one's changes are legitimate.
3. **Reconcile anchor by anchor, update docs, complete mapping corrections**: update the doc wherever the recorded behavior and code reality disagree (explicitly call out to the user, in the body, any update to a contract-level anchor); if a newly added source file this round isn't covered by any pattern → after confirming with the user, **finish editing map.json in this step** (any map.json correction must happen before step 4 — editing it later produces misaligned new declaration stubs); for deleted source files, confirm their doc sections have been handled. At the same time, count into the four classes (formatting/docLag/codeViolation/other) for step 7's `--verdict` (the count only covers driftCandidates; verifying docDrift files doesn't add to it separately). After finishing the map.json edit, re-run the machine check once (not stamp) to refresh the candidate list — newly covered files become first-time-onboarding candidates (kind:new), counted into the verdict's other.
4. **Two-phase draft handling**: (a) clean up `.claude/.cache/doc-companion-*.declarations.md.merged` files left over from the previous round; (b) list `.claude/.cache/doc-companion-*.declarations.md` (collect across sessions together), read the contents (each entry contains an `[id: <sid>#<n>]` reconciliation marker); entries where `<!-- pending -->` was never replaced are recorded as "triggered but no declaration left" — a declaration must be written on the spot, or a reason given; (c) once read, **rename** each draft to `<original name>.merged` (do not delete it — an active session's later stub will land back in the recreated original-name file, to be cleaned up next round).
5. **Write the ledger** `<ledgerDir>/YYYY-MM-DD-<slug>.md` (ledgerDir reads from config, defaults to `.docc/LEDGER`). **Re-glob `doc-companion-*.declarations.md` once more right before writing** — fold in any drafts produced after step 4. Five-field template (append a sixth section when there are declarations, grouped by file, citing the id):

```markdown
# <date> <one-line title>

## Changes
(file/module-level enumeration)

## Rationale
(why the change was made; link to the plan/issue/review conclusion)

## Behavior before vs after
- Before: (concrete behavior; empty phrases like "optimized" / "fixed" are forbidden)
- After: (concrete behavior)

## Affected callers/dependents
(codegraph callers/impact output; when unavailable, use a grep reference scan and label it "degraded output"; if there are truly no affected parties, state "None" explicitly)
<!-- verified-by: codegraph_impact -->

## Docs updated this round
(the list of anchors actually updated in step 3; if no doc was updated, state why)

## Gate declaration reconciliation
- <file>:
  - [id: <sid>#<n>](<timestamp>): <declaration content, or "triggered but no declaration left: the declaration written now / the reason">
```

   `verified-by` is one of three: `codegraph_impact`/`grep-fallback`/`unverified` (state the reason).
6. **Index correction**: append one line to `<ledgerDir>/INDEX.md` (date | slug | one-liner) — when stamping, the script uses a `ledger-not-indexed` soft warning to check whether this round's new ledger entry was indexed.
7. **Stamp**: `node "${CLAUDE_PLUGIN_ROOT}/scripts/doc-preflight.mjs" --cwd . --stamp --verdict '{"src/a.ts":"docLag",...}'` (per-file form — recommended, maps each candidate to its classification; or use aggregate form `{"formatting":N,...}` — also accepted). The verdict comes from step 3; the stamp gate verifies set equality with candidates — a mismatch gets a `verdict-file-mismatch` soft warning.
   - `stamped: true` → commit the docs, the ledger, and `.docc/` together;
   - `stamped: false` with `stampBlocked` non-empty → handle per the message: fix the mapping first for mapping defects; for "reconciliation testimony missing/count mismatch", complete step 3's four-class counts and re-stamp with a matching `--verdict`; only use `--force` for genuine exception-registration cases (e.g. a codeViolation the user has ruled to leave in place for now), and note it in the ledger.
   - Handle `warnings` (by code: `ledger-verified-by-missing`/`ledger-not-indexed`/`verdict-count-mismatch`, etc.).

## Degraded path

Without node: replace step 7 with manually rebuilding `.docc/hashes.json` (`git hash-object --no-filters -- <file>` for each mapped file, two groups sources/docs, keys sorted), and append a line with the four-class verdict counts under the ledger's "Docs updated this round" section (in place of --verdict landing in history). **Note**: since v0.6.0 the engine's hashing convention is self-computed CRLF→LF normalization; manual `git hash-object` is equivalent to the engine for LF files, and files containing CRLF will show a difference in the degraded-path result (the degraded path accepts this difference).

## Discipline

- None of the ledger's five fields may be skipped; "Affected callers/dependents" may say "None" but must never be left blank, and it must carry a verified-by marker.
- "Triggered but no declaration left" entries must have a declaration written on the spot, or a reason given — they must not be recorded as-is and left at that.
- Stamping must happen **after** the doc reconciliation; `--force` is only for exceptions the user has ruled on, never a shortcut around the gate.
- Any edit to map.json happens in step 3 (before draft handling) — this is the precondition for the reconciliation not being misaligned.
