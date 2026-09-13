---
name: codedirector-apple
description: Apple-platform rulebook for Code Director. Use in any Swift, SwiftUI, or Apple-platform repository alongside the base codedirector skill — draft the Vibe Check with the apple profile, apply the Apple decision rules below, and verify with swift test or xcodebuild.
---

# Code Director — Apple projects

Apple-platform addendum to the base `codedirector` skill. The workflow
(intake, draft, mirror, approval, work inside the lock, Change Report) is
unchanged — follow the base skill; this file only adds the Apple defaults
and decision rules.

## Drafting

Draft with the apple profile: `cdir lock new "<exact words>" --profile apple`
(MCP: `lock_draft` with `profile: "apple"`). The profile denies dependency
lockfiles and vendor dirs (Pods, Carthage, Package.resolved, Gemfile.lock),
signing assets (*.p8, *.mobileprovision, *.cer), and DerivedData, and keeps
`no-new-dependency`. When the repo generates its Xcode project — `project.yml`
(XcodeGen) or `Project.swift` (Tuist) — it also denies `*.xcodeproj/**` and
`*.xcworkspace/**`: a generated project is never hand-edited. Explicit
`--deny` / `--keep` flags add to these defaults; `--verify-command` overrides.

## Decision rules

- SwiftUI by default for new UI; UIKit only when the API genuinely requires it.
- SwiftData for new persistence on iOS 17+ targets.
- `@Observable` over `ObservableObject`.
- Swift 6 concurrency: start single-threaded; `@MainActor` for UI.
- SF Symbols for iconography.
- Respect Dynamic Type and the 44x44pt minimum tap target. For UI work, add
  `custom:XCTest performAccessibilityAudit passes` as a keep clause — audit it
  before reporting done.

## Verification ladder

- SPM package at the root: `swift test` (the profile sets this as
  verifyCommand when `Package.swift` exists).
- Xcode schemes: `xcodebuild test -scheme <name> -resultBundlePath <path>` —
  name the scheme explicitly; never guess one.
- `swiftlint --strict` when a SwiftLint config exists.
- These suites run for minutes: the profile sets `verifyTimeoutMs: 900000`
  (15 min) alongside the verifyCommand. Override per run with
  `cdir run --test-timeout <ms>` / `cdir verify --test-timeout <ms>`.

## Never

- Hand-edit `project.pbxproj` in a generated project (XcodeGen/Tuist).
- Commit signing assets (certificates, provisioning profiles, .p8 keys).
- Add a package without updating the Vibe Check — `no-new-dependency` will
  flag the lockfile change; a new dependency is a scope change and needs the
  user's approval first.
