# IL-0038 — provenance note

## The RED (fail-first)

The RED step staged **the excerpt pin only** — `test/verify.test.ts`, "verify: a
failing verifyCommand's item carries the command's own output, not the exit
code alone". Through the fence: `node /tmp/il0038-red2.mjs`, record
`.codedirector/runs/IL-0038-20260930-062644-818-16hi1-31d5.json` — the run's own
command exited 0, `test/verify.test.ts` the only changed file (in budget), and
the chain came back red with exactly one violation:

    VERIFY verify-command: verifyCommand failed (exit 1): npm test && npm run eval

with the item reading, verbatim, `verifyCommand failed (exit 1): npm test && npm
run eval` and artifact `sh -c "npm test && npm run eval" → exit 1` — the defect
itself, on the record.

The exact failing assertion, captured by running the already-built test file
(no rebuild, no repo write):

    AssertionError [ERR_ASSERTION]: the item must carry the command's own output; item: verifyCommand failed (exit 3): … 

The stub's marker is built at run time (`"il0038-" + (6 * 7)`) and the pin
asserts it is **not** in the command's own text first — so the command string the
item already quotes can never satisfy the pin by accident.

An earlier RED attempt (record `…062220-526-16hi2-7090.json`) was red because the
marker appeared in the command text; it was corrected before the implementation,
so the recorded RED is the corrected pin.

## The restore pins are regression pins — green before the fix, never called reds

`test/run.test.ts`, "run: a probe hands back the tree it took". Both assertions
pass on the **pre-fix** tree: measured 2026-09-30, before any implementation was
applied, by driving the then-current built `runIsolated` in a scratch repo —

* a tracked file dirty vs HEAD, rewritten by the probe, came back byte-identical
  to its pre-probe content (`bf57b4ca…`);
* a file that was clean came back at HEAD.

They are stated as regression pins, not reds. They exist because this lock's
first draft claimed the restore reverts uncommitted work to HEAD; that claim was
measured and did not hold (`src/run/tree.ts:249-261` writes the snapshot's own
bytes back for files dirty at snapshot; only files clean at snapshot take the
`git checkout HEAD --` path at `:266-303`, where HEAD and the snapshot agree).
The pins hold the measured behaviour in place.

## The boundedness assertions

The excerpt pin gained its "bounded" half (tail kept, head dropped, item under
700 chars) with the implementation, because the sealed accept names a **bounded**
excerpt. They add no import — so the recorded RED, which predates them, remains
valid: pre-fix they are either vacuous (nothing is quoted) or red for the same
reason as the recorded RED.

## The 3×-probe vs 3×-direct comparison

Interleaved, so time drift hits both arms equally. The lock's verifyCommand,
exactly as written, `verifyTimeoutMs` 3600000 through.

| # | direct (`sh -c "npm test && npm run eval"`) | probe (the ladder) |
|---|---|---|
| 1 | exit 0, 135 s | exit 0, 145 s |
| 2 | exit 0, 136 s | exit 0, 147 s |
| 3 | exit 0, 151 s | **exit 1, 125 s** |

The discrepancy was **not eliminated — it is now named**, from the failing
probe run's own report (`/tmp/il0038-compare/probe-3.log`):

    verifyCommand failed (exit 1): npm test && npm run eval — output: … code:
    'ERR_ASSERTION', · actual: false, · expected: true, · operator: '==', …
    artifact: sh -c "npm test && npm run eval" → exit 1 · stdout sha256 00ade8af…
    · stderr sha256 e3b0c442… (empty)

Exit-code-only reporting said `exit 1` and nothing else.

A separate hunt captured the full output of one failing in-probe run
(`/tmp/il0038-compare/hunt-1-fail.log`). The tests that failed there —

    ✖ MCP: 65s verification stays responsive… (AssertionError: 5s cadence with 500ms scheduling tolerance)
    ✖ MCP: baseline probe and locked command are off-thread… (timed out waiting for fixture state)
    ✖ probe: a timeout stops the command and everything it started (the background process ran)
    ✖ probe: a command that finishes on its own may leave a daemon running (left alone, as a build daemon would be)
    ✖ swift: a one-file index exits promptly (cdir index took 4190ms)

— are wall-clock/liveness assertions, none of them this lock's pins. They fail
under load (that run took 300 s against the arm's usual ~135 s; another lane was
building Xcode derived data on this machine throughout). That is **out of scope
for IL-0038** and is reported here, not fixed: this lock makes such a failure
readable, it does not make the suite timing-robust.

## Limit of the fix, stated

The excerpt is bounded by design and keeps the **tail** (8 lines / 400 chars),
where runners put their summaries. For `node:test` output the failing test's
*name* sits above the assertion dump, so the excerpt can show the assertion
without naming the test — as in the 065651 run above. The full-output **hashes**
travel with every failing item, so a re-run can be compared byte for byte; the
whole stream is deliberately not retained.
