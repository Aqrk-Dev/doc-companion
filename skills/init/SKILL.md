---
name: init
description: Onboard the current project onto doc-companion — scan the repo structure and existing docs, conversationally generate .docc/map.json (code↔doc anchor mapping), and establish the hash baseline. Use when the user says "onboard doc-companion / initialize the doc mapping".
---

# doc-companion Onboarding Init

## Steps

1. **Survey**: read the repo's directory structure (one level deep) and existing docs (README, manuals/contracts/design docs under docs/), and identify which docs "record code behavior" along with their section structure.
2. **Conversational confirmation**:
   - Fast path for small repositories: instead of asking item by item, propose one complete draft map.json (patterns, anchors, critical flags, config) and ask for a single confirmation; fall back to item-by-item questions only if the user requests changes.
   - Otherwise (large repos), ask the user item by item, one question at a time:
     - Which docs are the source of behavioral truth? (default candidates: the README status section, contract/appendix-type docs under docs/)
     - Which sections are "contract-frozen" (changes must declare impact) → mark these anchors `critical: true`
     - Are there generated artifacts to exclude (directory prefixes or glob patterns go into `config.exclude`; `.understand-anything/`, `.claude/`, `.docc/` are excluded by default)
3. **Generate `.docc/map.json`**, structured as:

```json
{
  "version": 1,
  "config": {
    "ledgerDir": ".docc/LEDGER",
    "exclude": ["ent/", "**/*_pb.go"],
    "history": true,
    "historyLimit": 500
  },
  "entries": [
    {
      "pattern": "src/api/**",
      "docs": [
        { "file": "docs/appendix.md", "anchor": "### 2.6", "note": "API contract", "critical": true },
        { "file": "README.md", "anchor": "## Status" }
      ]
    }
  ]
}
```

Rules:
- `pattern` prefers directory-level globs (new files are auto-covered); glob only supports `**`/`*`/`?`, not `!`/`{a,b}`/`[abc]`.
- `config.exclude` members: those containing `*`/`?` match the full path as a glob, otherwise match as a directory prefix.
- `anchor` is a heading-line prefix in the target doc; a match requires the prefix to be followed by end-of-line or whitespace; the same anchor matching ≥2 times reports "anchor ambiguity".
- `config.history` defaults to true: every stamp appends the drift count and reconciliation verdict to `.docc/history.jsonl`; committing it alongside the repo is recommended.
- `config.historyLimit`: the history rotation cap (defaults to 500, 0 = unlimited); `version` must be 1 (the engine ignores other versions with zero disruption).
- **Do not register files inside `.docc/`** (reported as a mapIssue); `.docc/map.json`/`hashes.json`/`history.jsonl` are guarded by the contract gate's built-in self-guard — no self-guard entry needed.
4. **Append to the project's .gitignore**: `.claude/.cache/` (the session-state and declaration-draft directory).
5. **Establish the hash baseline**: `node "${CLAUDE_PLUGIN_ROOT}/scripts/doc-preflight.mjs" --cwd . --stamp --verdict '{}'`, confirm `stamped: true`; commit the entire `.docc/` directory to the project repo. When the first stamp has a non-zero candidate count, `--verdict '{}'` will get a `verdict-count-mismatch` soft warning — this is expected and can be cleared by passing `'{"other":<candidate count>}'` instead.
6. **Output wiring suggestions** (for the user to paste into the project's AGENTS.md/CLAUDE.md): the first task at the start of a phase/iteration = `/docc:preflight`, the wrap-up task = `/docc:postflight` (run before code review, so the ledger is available for the review to reference).

## Notes

- When the report's `mapIssues` is non-empty, fix the mapping first before finishing; `warnings` are soft warnings — handle them and continue.
- Upgrading from 0.2.x: delete the old `docs/DOC-MAP*.json`/`docs/DOC-MAP.history.jsonl` (if the ledger needs to be kept, manually move `docs/LEDGER/` → `.docc/LEDGER/`), then re-run this procedure.
- On machines without node: skip the step-5 script and instead manually build `.docc/hashes.json` by running `git hash-object --no-filters -- <file>` on each mapped file (two groups, sources/docs, keys sorted; a new file with no record is a first-time-onboarding candidate). **Note**: since v0.6.0 the engine's hashing convention is self-computed CRLF→LF normalization, `git hash-object` is equivalent to the engine for LF files, but for files containing CRLF the manual degraded-path result will differ from the engine's (the degraded path accepts this difference).
