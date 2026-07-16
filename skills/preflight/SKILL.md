---
name: preflight
description: Reconcile documentation against the actual source code for drift and zero it out before starting work. Use before starting a phase/feature/fix, or when the user asks to "check doc drift / reconcile docs". Prerequisite: the project already has .docc/map.json (otherwise run /docc:init first).
---

# Pre-work Drift Reconciliation (preflight)

## Steps

1. **Machine check**: `node "${CLAUDE_PLUGIN_ROOT}/scripts/doc-preflight.mjs" --cwd .`
   Elements of `mapIssues`/`warnings` in the report are `{ code, message }` — dispatch handling by `code`, `message` is for humans to read.
   Read the five fields of the JSON report:
   - `mapIssues`: problems with the index itself (bad pattern / doc missing or outside the repo / a file inside .docc registered / dangling anchor / anchor ambiguity — needs a longer unique prefix / corrupt hash baseline — needs verification then re-stamping) → **fix the mapping and index first**;
   - `driftCandidates`: structured candidates `{file, kind, docs}` — `kind` is `modified` (baseline has a record and it mismatches) / `new` (no record, first-time onboarding) / `removed` (baseline has a record but it wasn't onboarded this round: deleted/renamed/moved out of the mapping); `docs` are the anchors this file hits (merged and deduplicated, elements `{file, anchor?, critical?, note?}`) → proceed to step 2;
   - `docDrift`: a doc that was directly modified (baseline record mismatches) → proceed to step 2;
   - `warnings`: soft warnings (a pattern only hits excluded files, hashing failed, the ledger is missing verified-by, a stamp lacked --verdict, etc.) → record and handle, non-blocking;
   - all empty and `ok: true` → no drift, start work directly.
2. **Semantic reconciliation** (candidates only, not the full set): for each candidate file, read the candidate's own `docs` (anchors) and `kind` (modified/new/removed, which decides the reconciliation direction: modified/removed check "doc claim vs. code reality", new checks "does the new code need to be folded into an existing anchor or documented"), and dispatch the plugin's built-in **`docc:drift-checker`** agent to verify "what the doc records vs. what the code actually does" — hand it the report's `driftCandidates` array **verbatim** along with the repo root path, and collect back the per-candidate verdict blocks plus the trailing tally map (per-file form: `{"src/a.ts":"docLag",...}` — directly pass to postflight `--verdict` argument; this agent is read-only and never modifies any file). When that agent isn't available in the environment, check each item in this session following the four classes below. Produce a drift list, counting each item into one of four classes (the `--verdict` argument for the postflight stamp depends on this classification):
   - **formatting**: no substantive content change (pure formatting/comments/whitespace) → no doc change needed;
   - **docLag** (the doc is lagging, the code is the new truth) → update the doc anchor's content;
   - **codeViolation** (the code violates the contract, the doc is the contract) → do not change the doc, escalate the decision to the user;
   - **other**: anything outside the above (e.g. handling an orphaned doc section for an already-deleted file).
3. **Zeroing out**: `driftCandidates` relative to the baseline will **not** disappear before stamping (the baseline is only updated when postflight stamps) — the zeroing criteria are: (a) `mapIssues` is empty (handle the `baseline-corrupt` class per its guidance: verify then let postflight re-stamp to fix it); (b) every candidate has exactly one verdict entry (set equality; the stamp gate cross-checks with `verdict-file-mismatch`). **Do not stamp here** — stamping belongs to postflight.
4. Report to the user: the candidate count, the four-class verdict counts, and the list of how each was handled, then start work. Structural-fingerprint re-evaluation criterion: among the most recent 20 `stamped:true` history lines with a non-empty verdict, if Σformatting/Σ(sum of the four classes) ≥ 30% and Σformatting ≥ 5 → formatting false positives have genuinely occurred, reopen the structural-fingerprint evaluation; below the threshold, keep the byte hash (see the README's `config.history` section for details).

## Degraded path

- Script fails or no node: for each entry in map.json, manually run `git hash-object --no-filters -- <file>` and compare against the recorded value in `.docc/hashes.json` to get candidates (a new file with no baseline record = first-time-onboarding candidate; a file with a baseline record that has since been deleted also counts); verify anchors with Grep to pull all lines starting with the anchor, and manually confirm "the prefix is followed by end-of-line or whitespace" with exactly one match (boundary and ambiguity rules are the same as the script's). **Note**: since v0.6.0 the engine's hashing convention is self-computed CRLF→LF normalization (see README); `git hash-object` is equivalent to the engine for LF files, but for files containing CRLF the manual degraded-path result will differ from the engine's (the degraded path accepts this difference).
- codegraph/subagents unavailable: do the semantic reconciliation by checking each item directly in this session instead (slower, but the same list results).
