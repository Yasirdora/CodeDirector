# Roadmap

What is being considered for the next releases, and the evidence for each
item. An item here is a candidate, not a promise. Each one is written so it
can become a GitHub issue as it stands.

## 0.4.6 candidates

### A run can hide a file from the fence by adding it to `.gitignore`

**Found:** 2026-09-24 — a run's three-line `.gitignore` change wasn't
counted ("16 changed" for 17 files). Reproduced on
main (02a6ee0) the same day.

**What happens:**

- `.gitignore` is never judged. `isToolPath` (`src/run/tree.ts:161`) treats it
  as cdir's own file, because cdir writes its ignore block there, so a run's
  edits to it are not in the changed files, the budget or the line count —
  even when the lock's `deny` names `.gitignore`.
- So a run can hide what it creates. Reproduced: a lock budgeting `src/a.ts`
  and denying `.gitignore`; a run that edits `src/a.ts`, creates `notes.txt`
  and appends `notes.txt` to `.gitignore`. Verdict: VERIFIED, "1 changed".
  The same run without the `.gitignore` line: OUT-OF-BUDGET: notes.txt.

**Why it matters:** the fence promises that nothing outside the budget changes
unseen. This is the same class as the 0.4.5 seal hole (IL-0015): an agent can
be marked verified for work outside its scope.

**Wanted:**

- Judge `.gitignore` like any other file, except cdir's own
  `# BEGIN cdir … # END cdir` block: compare it with that block removed on
  both sides.
- Classify files the run's own ignore rules hide: compare
  `git ls-files --others --ignored --exclude-standard` before and after the
  run (or evaluate paths against the baseline's copy of `.gitignore`), so a
  file hidden by a rule the run added is still judged.

**Test:**

- A run appending a line to `.gitignore` under a lock that doesn't budget it:
  OUT-OF-BUDGET: .gitignore — and DENY when the lock denies it.
- A run that creates `notes.txt` and ignores it: OUT-OF-BUDGET: notes.txt, as
  without the ignore line.
- cdir writing its own block on a repo's first run: no finding.

### Feature 8: `no-new-dependency` can't tell a version bump from a dependency

**Found in:** IL-0010, the 0.4.5 bump. The clause was left out of that lock's
`keep`, "for a mechanical reason, not an editorial one".

**What happens:** a release bump is not a new dependency, but the clause
cannot say so, so a lock that bumps the version has to give the promise up.

- `package.json` is compared by its dependency maps only
  (`dependencyFingerprint` in `src/run/deps.ts`), so its own `version` field
  is safe. IL-0010's note says "hashes package.json", which is broader than
  what the code does.
- Every other manifest in `DEPENDENCY_MANIFESTS` is hashed whole, including
  `package-lock.json`, `Package.resolved` and `Podfile.lock`. `npm version`
  rewrites the lockfile's own `version` fields (top level and `packages[""]`),
  so the hash changes and the clause reports a dependency that doesn't exist.

**Wanted:** judge lockfiles by what they resolve, not by their bytes. For
`package-lock.json`, that means the `packages` entries other than the root
package's own `version`. A bump then keeps the promise, and a real new or
changed dependency still breaks it.

**Test:** a lock with `no-new-dependency` whose run only runs `npm version
patch` holds. A run that adds a dependency is still violated.

### Untracked directories are never expanded into their files

**Status: landed (IL-0016)** for the verdict, the line count and the
checkpoint. `git status` now lists untracked files one by one
(`--untracked-files=all`), and a file already deleted when the baseline is
captured gets a fingerprint of its own, so neither a pre-existing untracked
folder nor a pre-existing deletion reads as the run's change (eDraft IL-0045's
three PNGs were the deletion case). The tolerated OUT-OF-BUDGET that
`test/run.test.ts` pinned is gone. Still open, both in undo:

- The `undo --force` preview lists pre-existing untracked files as "will be
  LOST" and then leaves them in place.
- `undo --force` brings back a tracked file that was already deleted before
  the checkpoint (`git reset --hard`), undoing someone else's deletion.

The evidence below is kept as the record.

**Found in:** eDraft IL-0028, 2026-09-17.

**What happens:** a folder that was already untracked before a run reads as a
new change after it, a false scope violation.

- The project had an untracked `.githooks/` (the human's commit hook, last
  modified 37 minutes before the run).
- The run copied nine in-budget files and never touched the folder.
- The Change Report still listed `.githooks/` as OUT-OF-BUDGET and counted
  10 of 9 files. Verdict: FAILED, with every other check and the verify
  command passing.

**Cause:** `git status --porcelain` reports an untracked directory as a single
`?? dir/` line unless it is run with `-uall`.

- The checkpoint (`writeCheckpointBlobs` in `src/checkpoint/index.ts`) calls
  `readFileSync("dir/")`, which throws EISDIR. The error is caught as
  "vanished", so none of the folder's files are snapshotted.
- The baseline records no per-file hash for the folder either
  (`workTreeHashes` had `screenshot.png`, an untracked file, but nothing under
  `.githooks/`).
- After the run, the same `?? dir/` line has nothing to compare against and is
  classified as a change.

**Also:**

- **Half of this landed in IL-0014:** a run that creates a file in a new
  folder now counts its real lines (the numstat/untracked side). What remains
  here is the classification half — the collapsed `?? dir/` entry is still
  judged as a path and still reads OUT-OF-BUDGET — plus the checkpoint,
  undo-preview and EISDIR symptoms. A test in `test/run.test.ts` ("a new file
  in a new folder counts its real lines") pins a tolerated OUT-OF-BUDGET that
  this item's fix must remove.
- **Misleading preview:** `undo --force` listed the folder (and
  `screenshot.png`) as "will be LOST", then left both byte-identical
  (`deletedUntracked: []`).
- **Can't undo changes there:** a run that really did edit a file inside such
  a folder would have no checkpoint bytes to restore it from. This is read
  from the code, not reproduced.
- **A lock can't create a file in a new folder.** Reproduced by IL-0011, the
  lock that wrote this roadmap. Its budget named `docs/ROADMAP.md`, but
  `docs/` did not exist, so the new file arrived as `?? docs/`. It was judged
  as "docs/" against the budget (OUT-OF-BUDGET) and counted as 3 lines of
  127, with the verify command passing. A budget may name a file its run
  will create (IL-0008), but not when the file's folder is new too.

**Wanted:**

- List untracked paths file by file (`git status --porcelain -uall`, or
  `git ls-files --others --exclude-standard`) in the checkpoint, the baseline
  and the post-run tree.
- Snapshot, hash and classify each file.
- The undo preview names only what undo will actually remove or overwrite.
- EISDIR is never swallowed as "vanished".

**Test:**

- **Setup:** a repo with a committed file and an untracked `tools/hook.sh`,
  and a lock that budgets the committed file.
- **Run:** a command that edits only the committed file.
- **Expect:** no OUT-OF-BUDGET, and 1 of N files changed.
- **Then:** `undo --force` restores the committed file, and `tools/hook.sh`
  still exists, unchanged and not listed as lost.
- **And:** a lock whose budget names `notes/new.md`, in a folder that does
  not exist yet, runs a command that creates it. Expect no OUT-OF-BUDGET,
  1 file changed, and the file's real line count.

### Undo rolls approval seals back by accident, and says nothing

**Found in:** eDraft IL-0028, 2026-09-17, during the same undo.

**What happens:** undoing a failed run also removed the approval seal of the
lock that ran it, and nothing said so.

- IL-0028 was activated, and so sealed, but not yet committed. Its run failed.
- `undo --force` reported only the work files it discarded.
- Afterwards `.codedirector/seals.json` no longer had IL-0028's entry. The
  lock's next run would have been refused as "active but has no approval
  seal" until the human re-approved it.

**Cause:** undo is `git reset --hard` to the checkpoint's HEAD, plus a restore
of checkpoint blobs that excludes `.codedirector/`. So which seals survive
depends on repo convention, not on any decision:

- A repo that commits `seals.json` (eDraft does, lock by lock) gets it rolled
  back to its last commit. That drops the seal of every lock approved since,
  not just the one being undone.
- A repo that ignores `.codedirector/` keeps every seal.

**Not obviously a bug in one direction.** Rolling the seal back with the work
has its own logic: the undone run was carried out under that approval, and
asking for it again before a retry is defensible. Keeping the seal also has
logic, because the approved scope did not change.

**Wanted:** make the behaviour deliberate and loud, whichever way it goes.

- Decide what undo does to approval seals, independent of whether the repo
  commits `.codedirector/`.
- Scope that decision to the lock being undone, not every lock approved since
  the last commit.
- Name it in the undo preview and result, for example "IL-0028's approval seal
  is removed; re-approve with `lock check` + `lock activate` before running it
  again", or "kept".

**Test:** in a repo that commits `seals.json` and in one that ignores
`.codedirector/`, activate two locks without committing, fail a run of one,
and undo. The same documented outcome holds in both repos, the other lock's
seal is untouched, and the undo output states what happened to the seal.

### The changed-line count is wrong in a project rooted in a subfolder

**Status: landed (IL-0014).** The numstat loop now skips `.codedirector/` as
the classifier does, `snapshotWorkTree` lists tracked files with
`--full-name` so a subfolder baseline hashes its own files, and an untracked
folder entry is expanded and counted file by file. The evidence below is kept
as the record. Known leftover: `listHidden` (tree.ts) and two `ls-files`
calls in `checkpoint/index.ts` share the old mis-framed call and were left
out of IL-0014's scope — they matter only if hidden-flag files are used in a
subfolder-rooted project.

**Found in:** IL-0012, 2026-09-17, on this roadmap. The Change Report counted
12 lines. Git counts 9 added and none removed, on a tracked file.

**What happens:**

- **The extra 3:** they are `.codedirector/seals.json` (+2/−1), the approval
  seal that `lock activate` wrote before the run started. The classifier
  leaves `.codedirector/` out of the changed files, but the line counter
  counts it.
- **IL-0011's "3 lines of 127":** the same 3 seal lines. The new 127-line file
  counted 0, because its untracked folder can't be read as a file (see the
  untracked-directory entry).
- **At the git root, counts were exact:** eDraft's lock root is its git root,
  and the same day IL-0029 counted 10 of 10 and IL-0030 1,877 of 1,877.

**Cause (from the source):**

- `changedLineCount` (`src/run/classify.ts`) sums
  `git diff --numstat <baseline HEAD>` over the whole repository. It skips a
  file only when the baseline's `workTreeHashes` shows it unchanged since
  capture, and has no `.codedirector/` filter of its own.
- `snapshotWorkTree` (`src/run/tree.ts`) lists tracked files with
  `git ls-files`. In a subfolder that prints paths relative to the subfolder,
  which are then read as relative to the git root, so almost none resolve.
  IL-0012's baseline hashed 3 files: `.gitignore`, `LICENSE` and `README.md`,
  names that exist at both levels, hashed from the wrong copies.
- With no baseline hash for `seals.json`, the seal written before the run is
  counted as the run's change.
- At the git root, the snapshot hashes every tracked file (465 in eDraft),
  `seals.json` included, so the earlier write is recognised and skipped.
- The same hashes are consulted when classifying files
  (`src/run/classify.ts:145`). Whether that misjudges pre-existing changes in
  a subfolder project was not checked.

**Why it matters:** `maxLines` is a tripwire, and the ruler errs in both
directions. Lines it adds can trip a legitimate run. Lines it drops (a new file
in a new folder counted as 0) pass under the ceiling unmeasured.

**Wanted:**

- Count only what the run changed, leaving `.codedirector/` out of the line
  count as the classifier already does.
- Resolve `git ls-files` paths in one frame (`--full-name`, or run from the git
  root), so a subfolder project's baseline hashes its own files.
- Count a new file inside a new folder by its lines.

**Test:**

- **Subfolder root:** activate a lock (which writes `seals.json`), then run a
  command that adds 9 lines to a tracked file. The report counts 9.
- **Git root:** the same. The report counts 9.
- **New folder:** a run that creates a 127-line file in a new folder counts
  127.
