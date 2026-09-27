# Spec 06 — MCP parity for KEEP clauses and verifyCommand (daily-pain gap)

Status: approved 2026-09-27 · first in the approved order.

## Problem

The flagship agent path cannot declare a single promise. `lock_draft` accepts
`utterance` / `goal` / `profile` only (`src/mcp/server.ts:166-176`), and there
is no amendment operation in the tool list (8 tools: `repo_map`,
`blast_radius`, `lock_draft`, `lock_check`, `lock_activate`, `run_locked`,
`report`, `undo`). An MCP-drafted TypeScript lock activates with `keep: []`
and no `verifyCommand`, so its reports reduce to the typecheck rung plus scope
classification. The CLI has `--keep` / `--verify-command`; the MCP surface
does not, and `run_locked` cannot add a check either.

## Reproduction

1. In a TS repo with a test suite, call `lock_draft` over MCP (or via
   `eval/mcp-drive.ts`), then read the written YAML: `keep: []`, no
   `verifyCommand`.
2. `lock_check` → `ok: true` (nothing to fail); `lock_activate` succeeds;
   `run_locked` a trivial change; `report` shows no `api-unchanged`, no
   `tests-pass` — the promise layer is empty by construction, and no tool can
   fill it.

## Required behavior

- Agents can declare, on a **draft only**: `keep[]` (all five kinds),
  `verifyCommand` (+ `verifyCovers`), `accept[]`,
  `budget.{files,maxFiles,maxLines}`, `deny[]`.
- A sealed/active lock can never be amended by a tool; the existing
  re-approval ceremony (`lock_check` + `lock_activate`) stays the only path.
- Every CLI `lock new` capability has an MCP equivalent (or a documented
  exclusion). MCP may be a superset (e.g. `accept`, `maxFiles`, `maxLines`).
- Skills/integrations instruct the agent to *propose* keeps where they exist
  (e.g. `tests-pass` when the repo has runnable tests; `api-unchanged` for
  exported symbols the change touches) and to show them to the human like the
  budget.

## Design sketch

- Extend `lock_draft` input schema with typed optional fields mapping onto
  `DraftOptions` (which already carries `keep`, `verifyCommand`, `deny`,
  `budgetFiles`): `keep: {kind, symbols?|glob?|command?|text?}[]`,
  `verifyCommand`, `verifyCovers`, `accept`, `maxFiles`, `maxLines`.
- Extend `DraftOptions` + `draftLock` for `accept`, `maxFiles`, `maxLines`,
  `verifyCovers` (currently hard-coded `accept: []`, `maxFiles =
  files.length`, `maxLines: 400` at `src/lock/draft.ts:392-398`), and extend
  `mergeDraftOptions` so profile defaults and explicit args compose.
- Add `lock_amend {lockId, ...same fields}`: patches a `draft`, re-runs
  `checkLock`, returns the updated proposal + errors/warnings. Refuses
  anything not `draft`.
- Return the drafted clause list in the tool result so the agent mirrors it
  to the user (same shape as today's anchors/budget output).
- Docs: skill MCP mapping, integrations READMEs, tool descriptions, README
  tool count (8 → 9).

## Tests / acceptance

- MCP test: draft with all five keep kinds + verifyCommand → YAML round-trips;
  `lock_check` runs the coverage gate (TS budget + `swift test` → refusal
  fires); `run_locked` → report shows measured `tests-pass` evidence.
- Amend test: patch a draft (budget/keep/verifyCommand) and see the YAML
  change; amend an active lock → refused.
- Invalid keep shape → error-level result naming the shape.
- Parity test: a table asserting every CLI `lock new` option has an MCP
  counterpart or an allowlisted exclusion.
- Eval: extend the `14-mcp-deny-violation` pattern with a keeps/verifyCommand
  case.
- Done = reproduction 1 produces a lock with `keep` populated and a report
  with at least one measured/proven promise, driven entirely through MCP.

## Open decisions

- Should `lock_draft` auto-propose keeps (detect the test runner; propose
  `tests-pass`) or only carry what the agent passes? Conservative default:
  carry only, and let the skill tell the agent what to propose — consistent
  with the existing "propose budget from anchors, human corrects" philosophy.
