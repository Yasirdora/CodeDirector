# IL-0035 Change Report

Code Director verdict: verified. 6/7 files; 644/900 changed lines. No violations.

The change field was repaired before activation and sealing. The anchor-proposed budget was discarded: the anchors matched only “check” inside “Checkpoint…” names. The approved budget is the author's manual assessment of the measured blocking paths.

## Measured behavior

Before (1cfb66e): a 4-second locked command held ping/tools-list responses for 4.17s; a 65-second verification held them for 65.04s. The client timed out at 60.004s; zero progress; a record still persisted.

After, full gate on this machine: the 65-second verification completed in 66.241s through a client configured with a 60-second timeout and resetTimeoutOnProgress. Ping: 2.1ms. Tools/list: 4.8ms. Fourteen token-scoped liveness notifications; no fabricated percentage.

The full npm test && npm run eval command exited 0 under the declared verification gate. npm test: 286/286. Tests cover baseline and command offload, standalone report liveness, canonical aliases/linked worktrees, busy refusals, client cancellation and timeout recovery, worker failures/startup flags, non-Git roots and malformed Git metadata, and clean input EOF. Existing probe/seal/baseline tests are untouched. The initial sandboxed run failed because its existing launcher test could not use pgrep/ps; the final permitted run passed.

## Audit and limits

Final recheck: no remaining actionable findings. Audit fixes preserve read-only tools without Git, reject broken Git metadata, handle close rejection, and strengthen regression coverage. Message-before-exit ordering is guaranteed by Node (https://nodejs.org/api/worker_threads.html#event-message).

The custom preservation KEEP remains human-judged/Unchecked; its regression tests passed. Acceptance criteria remain human-judged. A never-ending locked command keeps its guard and delays graceful exit indefinitely; verification probe timeouts remain intact. Other tools still execute on the parent thread. No coordination between separate servers/CLI processes or abrupt-death recovery is promised. Progress extends only client timeouts configured to reset on progress.

No commit or push. No eDraft or help-book changes in this lock.
