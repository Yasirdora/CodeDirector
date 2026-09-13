# Apple Pack — Extension-Point Map for Code Director (`cdir`)

Analysis of where Apple-platform behavior (iOS/macOS/SwiftUI) would plug in
**without forking the engine**. All line references are against `codedirector/`
on `main` (commit `1e264e1`).

---

## 1. Keep clauses and verification

**What exists today.** Five clause kinds, all defined in
`src/lock/types.ts:20-33` (`KeepClauseKind`): `output-unchanged`,
`api-unchanged`, `no-new-dependency`, `tests-pass`, `custom`. Payloads per kind
are documented at `src/lock/types.ts:36-56`. Execution lives in the
verification ladder, `src/verify/verify.ts`:

- Rung 3 `verifyCommand` (`src/verify/verify.ts:337-353`) runs **any shell
  string** via `runShellProbe` and measures exit code. This is the natural
  home for `xcodebuild test` / `swiftlint` / `swift test`.
- `tests-pass` (`src/verify/verify.ts:286-335`) is hardwired to `node --test`
  — useless for XCTest, but `verifyCommand` fully substitutes.
- Rung 2 typecheck (`src/verify/verify.ts:209-271`) is hardwired to
  `tsc --noEmit` gated on `tsconfig.json`; on a Swift repo it degrades
  honestly to Unchecked ("no tsconfig.json — typecheck rung skipped",
  line 225-227). Not breaking, just absent.

**Can a keep clause express "xcodebuild test passes"?** Yes — as the
lock-level `verifyCommand` (schema field, `src/lock/types.ts:88-93`), not as a
`tests-pass` clause. "swiftlint clean" likewise:
`verifyCommand: "swiftlint --strict"`. Compound checks including xcresult
parsing compose inside the shell string, e.g.
`xcodebuild test -scheme App -destination 'platform=iOS Simulator,name=iPhone 16' -resultBundlePath .codedirector/result.xcresult && xcrun xcresulttool get test-results summary --path .codedirector/result.xcresult`.
No engine change needed for any of this.

**What's actually missing for Apple use:**

1. **Timeouts.** `verifyCommand` gets `testTimeoutMs ?? 60_000`
   (`src/verify/verify.ts:53, 340`). A clean-room `xcodebuild test` routinely
   takes 5–15 minutes. `VerifyOptions.testTimeoutMs` exists in the API but is
   not exposed on the `cdir verify` / `cdir run` CLI (`src/cli.ts:440-490`)
   and has no lock-level field. Result: Apple `verifyCommand`s time out as
   Unchecked. Smallest fix: one CLI flag (e.g. `--test-timeout`) or a
   lock-level `verifyTimeoutMs`, plumbed into `VerifyOptions`.
2. **Simulator destination handling / build caching.** Not missing from the
   engine — the destination is just part of the command string, and
   `-derivedDataPath` is free to use. An Apple *profile* should ship a
   pre-baked command with a fixed derived-data path so repeat verify runs are
   incremental.
3. **xcresult parsing.** Also not missing — compose `xcresulttool` into the
   command (exit code is the measured signal). A nicer report ("which XCTest
   failed") would want a parser, but that's polish, not an unlock.
4. **`no-new-dependency` is npm-only.** `DEPENDENCY_MANIFESTS`
   (`src/lock/types.ts:130-135`) = package.json + npm/yarn/pnpm lockfiles.
   `Podfile.lock` / `Package.resolved` / `Cartfile.resolved` are invisible to
   that clause. Two workarounds exist today: put them on the `deny` list
   (strictly stronger), or make `DEPENDENCY_MANIFESTS` extensible.

## 2. Lock drafting — the profile hook

`draftLock` (`src/lock/draft.ts:142`) already accepts a fully pre-filled
draft through `DraftOptions` (`src/lock/draft.ts:22-37`): `keep`, `deny`,
`budgetFiles`, `verifyCommand`. The CLI wires flags straight through
(`src/cli.ts:224-242`: `--keep`, `--deny`, `--budget-files`,
`--verify-command`). Draft-time deny suggestions come from
`DEPENDENCY_MANIFESTS` presence + unrelated test globs
(`src/lock/draft.ts:166-185`).

**Minimal clean change for `--profile apple`:** a profile is nothing but a
preset bundle of existing `DraftOptions` values. One lookup table + one flag:

```
profiles/apple = {
  deny: ["Podfile.lock", "Package.resolved", "Pods/", "Carthage/",
         "*.xcodeproj/project.pbxproj",  // only when XcodeGen/Tuist regenerates it
         "*.p8", "*.mobileprovision", "*.cer", "Gemfile.lock"],
  verifyCommand: "xcodebuild test -scheme <SCHEME> -destination 'platform=iOS Simulator,name=iPhone 16'",
  budget: { maxLines: 400 }              // defaults already fine
}
```

`cdir lock new "..." --profile apple` → resolve profile → merge into
`DraftOptions` before calling `draftLock`. Estimated diff: ~40 lines in
`src/lock/draft.ts` / `src/cli.ts` plus a profiles module. The
`*Tests/` test-glob machinery (`compressTestPaths`, `src/lock/draft.ts:61-89`)
only understands `*.test.*` / `*.spec.*` / `__tests__` — Swift `XCTest` files
won't be suggested, but that only weakens auto-suggestions, it doesn't block.

## 3. Repo index / blast radius — the one real engine gap

- The walker only collects `.ts/.tsx/.js/.jsx/.mjs/.cjs`
  (`INDEXABLE_EXTENSIONS`, `src/core/walk.ts:19-26`). **Swift files are never
  even seen.**
- The parser maps extensions to three grammars (`LangKey`,
  `src/core/parser.ts:24-38`) with WASM grammars from
  `tree-sitter-typescript` / `tree-sitter-javascript`
  (`src/core/parser.ts:40-44`).
- Consequence: on an Apple repo, `repo_map` is empty, `blast_radius` finds no
  Swift symbols, `lock_draft` finds no anchors (it abstains with an empty
  budget — honest, but useless), and `api-unchanged` clauses can't resolve.

**The gap for "blast radius of a Swift symbol"** is exactly one grammar +
one extraction pass: add `"swift"` to `LangKey`, add `.swift` to
`INDEXABLE_EXTENSIONS`, load the `tree-sitter-swift` WASM grammar, and write
Swift `kindForNode` / import (`import Foo`) / call-site extraction mirroring
`extractTopLevel` / `extractImport` / `collectCalls`
(`src/core/parser.ts:99-154, 287-351`). Everything downstream — graph
(`src/core/graph.ts`), PageRank, repo map, blast radius, signature hashing for
`api-unchanged` — is language-agnostic by construction. Bump `PARSER_VERSION`
(`src/core/parser.ts:22`) and indexes re-parse.

**Xcode project files.** `project.pbxproj` (old-style plist) is *not*
indexable and shouldn't be: it's not a symbol-bearing source file. The right
treatment is scope-level (deny/budget globs), which already works. Walking
into `.xcodeproj` bundles is harmless — the walker descends (it's a
directory) but finds no indexable extensions inside.

## 4. Skill / rulebook composition

`skills/codedirector/SKILL.md` is a self-contained directory-based skill.
Directory-based agent skill integrations install skills by
copying a **directory** into the agent's skills location;
plugin bundles combine skill + MCP + hook. There is no
skill inheritance or ordering mechanism in any integration guide — each skill
is independent, loaded by directory name.

**Recommendation: a second skill, not a merged one.**
`skills/codedirector-apple/SKILL.md` with frontmatter
`description:` scoped to Apple triggers ("Use when the repo contains
.xcodeproj/Package.swift/SwiftUI..."), whose body says: follow the
`codedirector` workflow unchanged, with these Apple deltas — profile deny
list, `verifyCommand` templates, XCTest/swiftlint mapping to clause kinds,
"never edit `project.pbxproj` by hand when XcodeGen is in use". Merging into
the base skill would tax every non-Apple user with tokens — the README's own
cost accounting (README.md "What it costs") argues against it.

## 5. Hook fence — directory-bundle check

`decidePreToolUse` (`src/hook/index.ts:70-122`) is **language-blind**: it
extracts a target path (`targetFileOf`, line 48-54), normalizes to a
root-relative forward-slash path, and runs deny-then-budget `matchPath`.

Glob semantics (`src/lock/glob.ts:43-50`): a pattern **without** glob chars
matches the exact path *or any path beneath it* (`p === pat ||
p.startsWith(pat + "/")`). A pattern with glob chars compiles to regex
(`globToRegExp`, line 11-36). Both handle `.xcodeproj` bundles correctly:

- `deny: ["App.xcodeproj"]` → matches `App.xcodeproj/project.pbxproj` via the
  prefix rule. ✓
- `deny: ["*.xcodeproj/**"]` → `^[^/]*\.xcodeproj/.*$` matches
  `App.xcodeproj/project.pbxproj`. ✓ (Note: `*.xcodeproj` alone would *not*
  match `ios/App.xcodeproj/...` since `*` doesn't cross `/`; the profile
  should ship `**/*.xcodeproj/**` or the doc-comment idiom from glob.ts:7 —
  plain prefixes like `"Pods"` already match any `Pods/...` at root only.
  For nested safety use `**` patterns.)
- Budget `files: ["App.xcodeproj/project.pbxproj"]` matches the file agents
  pass as `file_path` even though they treat the bundle as a file. ✓

No language-specific assumptions anywhere in the hook: `EDIT_TOOL_RE`
(line 45) matches tool *names*, paths are POSIX-normalized. One genuine
limit, already documented (`src/hook/index.ts` header, README.md `cdir hook`
section): the hook can't see inside shell commands, so an agent running
`xcodebuild` / `pod install` via Bash bypasses the fence — `cdir run`'s
after-the-fact classifier (`src/run/classify.ts`) remains the hard floor,
and it uses the same `matchPath`, so bundle semantics hold there too.

## 6. Per-project config

**There is no config-file concept today.** `.codedirector/` contains only
state: `locks/` (`src/lock/store.ts:14-16`), `seals/`, `baselines/`, `runs/`,
`ckpt-blobs/`, `index.json`. A grep for `config`/`profile` across `src/`
finds only `git config user.name` and tsconfig. An "apple" flag therefore has
two options: (a) profiles ship **inside the package** as static presets
selected by `--profile` (simplest, matches the "interactive-free v1"
philosophy of draft.ts), or (b) introduce `.codedirector/config.json` — a
new concept the project has deliberately not built. Option (a) is the
minimal, philosophy-consistent choice; the profile's *effect* lands in the
lock YAML itself, which is the existing per-project record.

---

## (b) The three smallest concrete changes, ordered by value

1. **`--profile apple` preset for `lock new` (no engine change; ~40 lines).**
   A profiles table mapping to existing `DraftOptions` fields: Apple deny
   list (`Pods/`, `Carthage/`, `Podfile.lock`, `Package.resolved`, signing
   files, `**/*.xcodeproj/project.pbxproj` under XcodeGen), a templated
   `verifyCommand` (`xcodebuild test …` with fixed derived-data path), and
   budget defaults. Highest value per line: deny + verifyCommand are 90% of
   the Apple pack and need zero verification-engine work.
2. **Plumb a verify timeout through (`--test-timeout` CLI flag or lock field;
   ~20 lines).** `VerifyOptions.testTimeoutMs` already exists
   (`src/verify/verify.ts:53`); it's just unreachable from the CLI. Without
   it every `xcodebuild test` verifyCommand dies at 60 s as Unchecked — this
   single gap makes change #1's verifyCommand unusable in practice.
3. **`no-new-dependency` manifest extensibility (~15 lines) — or skip it.**
   Extend `DEPENDENCY_MANIFESTS` (`src/lock/types.ts:130-135`) to include
   `Podfile.lock`, `Package.resolved`, `Cartfile.resolved` when present.
   Honest alternative: do nothing — the profile's deny list already forbids
   touching them, which is stronger than diffing. List it third precisely
   because the workaround is adequate.

## (c) What genuinely requires engine-level changes

Almost nothing — and exactly one thing that matters:

- **Swift in the structural index** (walker extension + `LangKey` +
  tree-sitter-swift WASM + extraction rules in `src/core/parser.ts`). This is
  the only change touching engine internals, and it's additive, not
  architectural: everything past `FileIndex` is language-agnostic. Without
  it, `repo_map` / `blast_radius` / anchor-based drafting / `api-unchanged`
  are simply absent on Apple repos — the pack degrades to "fence + verify +
  report", which is still most of the product's value.
- Everything else is data, not code: deny/budget globs (including
  `.xcodeproj` directory bundles — prefix matching handles them), arbitrary
  shell `verifyCommand` (xcresult parsing composes inside the command), the
  hook fence (language-blind), and the skill layer (compose a second skill by
  reference). The tsc typecheck rung being TS-only is not a defect for Apple
  — it degrades to a named Unchecked, which is the system's designed honesty
  behavior.

Notably consistent with the project's stated philosophy (README.md "Where we
deliberately stop", "The next layer gets picked by evidence"): the Apple pack
is ~95% profile data + a skill document; the only engine work (Swift grammar)
should land only after the profile proves useful in the field.
