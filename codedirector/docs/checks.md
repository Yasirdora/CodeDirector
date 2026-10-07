# Required checks by changed area

A lock's `verifyCommand` is free text. Nothing says which checks a part of
the repo needs, so a lock can change shared code and run only the tests of
one app. The tests of the other app break, and nobody sees it.

`.codedirector/checks.yaml` fixes that. It names the checks of your repo and
says which areas of the repo need which. Code Director then uses it in four
places (see below). The file is optional: without it, nothing here applies and
everything works as before.

Code Director never reads what a command does. The commands in the file are
plain text, whatever your toolchain is.

## The file

```yaml
schemaVersion: 1
checks:
  # Short form: the command is both what a drafted lock runs and what a
  # verifyCommand must contain.
  unit: npm test
  # Long form: `run` is what a drafted lock runs; `match` is the text a
  # verifyCommand must contain to count as running this check
  # (default: the same as `run`).
  app:
    run: make test-app OUT=/tmp/app-build
    match: make test-app
areas:
  - paths: [src/core/**, src/shared/**]
    need: [unit, app]
  - paths: [web/**]
    need: [unit]
```

- `schemaVersion` must be `1`. An unknown key anywhere in the file is an
  error, so a typo like `area:` cannot switch the rules off quietly.
- A check name is lower case letters, digits and `-` (`^[a-z0-9][a-z0-9-]*$`).
  `run` and `match` must not be empty.
- Every area has a non-empty `paths` and a non-empty `need`. Every name in
  `need` must be in `checks`.
- `paths` are relative to the repo root and use the same globs as a lock's
  budget and deny list. A plain path is a directory: `web` means everything
  under `web/`.
- `turns` (a string) is accepted and checked, but required checks do not
  use it.

## The matching rule

A file **needs** every check named by every area whose `paths` match it. A
file in no area needs nothing.

A verifyCommand **runs** a check when the check's `match` text is inside the
verifyCommand. Both are read with each run of spaces, tabs and newlines
turned into one space, and trimmed. That is all: it is a substring test. A
longer word that contains the text counts, so choose a `match` that is
specific.

## The four behaviours

1. **Draft.** `cdir lock new` (and the MCP tool `lock_draft`) fills the
   verifyCommand when you give none: the `run` commands of the checks that the
   budget's files need, in the order of `checks`, joined with ` && `. The
   timeout is estimated as for any command you give. A verifyCommand you give is
   never changed. Budget entries with `*` or `?` are skipped. If nothing is
   needed, the verifyCommand stays unset.
2. **Activation.** `cdir lock check` and `cdir lock activate` (and `lock_check`
   in MCP) refuse a lock whose verifyCommand does not run a check its budget
   files need. The message names the checks, the files that need them, and a
   verifyCommand that would run them. Budget entries with `*` or `?` are not
   judged here: the same blind spot as the language check, and the run covers
   it. An invalid rules file is a refusal too.
3. **Run.** After `cdir run` (or `run_locked`), each file that changed is
   matched against the areas. For each needed check the verifyCommand does not
   run, there is one violation:
   `CHECKS: verifyCommand does not run "app" (make test-app), which src/core/a.ts needs (+2 more)`.
   The run fails and the lock is `failed`, even if every check that did run was
   green. `--allow-expand` accepts scope growth only: it does not drop a CHECKS
   violation. The verifyCommand judged is the lock's, as it was run. An invalid
   rules file is one violation, `CHECKS: .codedirector/checks.yaml is invalid:
   <reason>`: the run cannot be shown to have run what the repo requires.
4. **Report.** `cdir report`, `cdir verify` and the MCP report judge the same
   way, over the current tree, over the live run, and over `--attempt N`, with
   the same wording. A lock that a later lock has closed is shown as it was
   recorded, and today's rules are not applied to it.

## Ask it

```
cdir checks                    # validate the file; list checks and areas
cdir checks src/core/a.ts web  # the checks these paths need, and the command
cdir checks web --json
```

With no paths it exits 1 and gives the reason when the file is invalid, and
exits 0 with "no rules file" when there is none. With paths it prints each
needed check and, last, the joined `run` command. Paths are relative to
`--root`. Put `--json` and other flags after the paths.

## Example

With the file above, a lock for `src/core/a.ts` and `web/ui.ts` is drafted
with

```
npm test && make test-app OUT=/tmp/app-build
```

If someone edits the lock to `verifyCommand: npm test`, `cdir lock check` says:

```
verifyCommand does not run the check(s) the budget needs: app (src/core/a.ts) — a verifyCommand that runs them: npm test && make test-app OUT=/tmp/app-build
```

If the lock is activated anyway (with the check missing from a glob budget, for
example) and the run changes `src/core/a.ts`, the run fails with

```
CHECKS: verifyCommand does not run "app" (make test-app), which src/core/a.ts needs
```

## What it does not do

- It does not read what a command does. A `match` that appears in a comment or
  an `echo` counts as run.
- The file is read at the time a lock is checked, a run is judged, or a report
  is built. Code Director's own state under `.codedirector/` is not part of a
  run's changes, so a run that edits this file is not caught by it.
