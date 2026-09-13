# Apple Pack: Machine-Checkable Rules & Quality Gates for iOS/macOS/iPadOS (Swift/SwiftUI)

**Research date:** September 2026 · **Purpose:** input for Code Director's "Apple pack" — scope-contract proof commands that an automated agent can run and machine-verify (exit code / parseable output) with zero human judgment.

**Verification legend:** ✅ = verified against a current (2024–2026) source linked in this report · 🟡 = recollection/older source, may have drifted · Each section states what was verified vs. recalled.

---

## Summary Table

| # | Rule / gate | Tool + command | Automatable? | Confidence |
|---|---|---|---|---|
| 1 | App builds for a given scheme/destination | `xcodebuild build -scheme S -destination 'platform=iOS Simulator,name=iPhone 16'` | ✅ Fully — exit code 0/non-zero (sysexits) | High ✅ |
| 2 | Unit/UI tests pass | `xcodebuild test -scheme S -destination … -resultBundlePath r.xcresult` + `xcrun xcresulttool get --format json` | ✅ Fully — JSON machine-readable | High ✅ |
| 3 | SPM package builds/tests | `swift build` / `swift test` (`-Xswiftc -warnings-as-errors` for first-party) | ✅ Fully | High ✅ |
| 4 | Coverage threshold | `xcrun xccov view --json r.xcresult` → jq compare | ✅ Fully | High ✅ |
| 5 | Lint (style/convention) | `swiftlint lint --strict --reporter json` | ✅ Fully — JSON, exit non-zero on error-severity | High ✅ |
| 6 | Format (idempotent formatting) | `swift format lint --recursive --strict Sources/` (toolchain-bundled) or `swiftformat --lint .` | ✅ Fully | High ✅ |
| 7 | Data-race safety (strict concurrency) | `SWIFT_STRICT_CONCURRENCY=complete` build setting / `-swift-version 6`; warnings-as-errors gate | ✅ Fully — compiler-enforced | High ✅ |
| 8 | Dead code (unused declarations) | `periphery scan --format json --strict` | ✅ Yes, but needs config tuning; false positives possible | Medium-High ✅ |
| 9 | Unused image/asset resources | `fengniao --list-only` (or `--xcode-warnings` for non-zero exit) | ⚠️ Partially — string-matching heuristics, false positives | Medium ✅ |
| 10 | Deployment-target / API availability violations | Compile with `IPHONEOS_DEPLOYMENT_TARGET=16.0`; compiler errors on unavailable API are automatic | ✅ Fully — it's a compile error, zero extra tooling | High ✅ |
| 11 | Deprecation policy (no deprecated API) | `SWIFT_TREAT_WARNINGS_AS_ERRORS=YES` or `-Werror DeprecatedDeclaration` (Swift 6.1+ diagnostic groups) | ✅ Fully, but Swift 6.2+/Xcode 26 needed for SPM per-group control | High ✅ |
| 12 | Private API usage in binary | `nm -u` / `otool -ov` / `strings` on built binary, grep against a private-symbol blocklist | ⚠️ Partially — works for static symbol refs; runtime-constructed selectors evade it; needs curated blocklist | Medium ✅ |
| 13 | App Store Review Guidelines | Mixed: binary/plist/entitlement checks automatable; content/UX/business-model rules human-only | ⚠️ ~20–30% automatable | Medium ✅ |
| 14 | Accessibility (labels, contrast, Dynamic Type, hit regions, clipped text, traits) | XCTest `try app.performAccessibilityAudit()` (Xcode 15+/iOS 17+) run via `xcodebuild test` | ✅ Fully for the 7–10 audit categories; only visible screen per audit | High ✅ |
| 15 | HIG 44×44 pt tap targets | `.hitRegion` audit type in `performAccessibilityAudit` (HIG minimum for iOS/iPadOS is 44×44 pt default, 28×28 absolute min) | ✅ Yes via audit; static frame analysis also possible but noisier | High ✅ |
| 16 | HIG judgment items (layout hierarchy, brand voice, motion taste, icon metaphor) | — | ❌ Human-only | High ✅ |
| 17 | Performance regression gates | XCTest `measure(metrics:options:)` with `XCTCPUMetric`, `XCTMemoryMetric`, `XCTOSSignpostMetric`, `XCTApplicationLaunchMetric` + baselines | ⚠️ Yes but fragile on CI — baselines are per-machine/per-device; simulators lack most metrics | Medium ✅ |
| 18 | Safe area / Dynamic Type support | `.dynamicType` + `.textClipped` audit types; snapshot tests at AX5 content size | ✅ Mostly (audit covers it) | High ✅ |
| 19 | os_signpost instrumentation exists & is measured | `XCTOSSignpostMetric(subsystem:category:name:)` in perf test; `xcrun xctrace` for Instruments CLI | ✅ As a CI perf check; signpost presence itself needs a lint rule | Medium ✅ |

---

## 1. Build & Test

### xcodebuild (Xcode projects/workspaces)

Verified ✅ against the `xcodebuild(1)` man page mirror and GitHub runner-image issues (2025).

Canonical proof commands:

```bash
# Build
xcodebuild build \
  -workspace App.xcworkspace -scheme App \
  -destination 'platform=iOS Simulator,name=iPhone 16,OS=latest' \
  -derivedDataPath .build/dd

# Test with machine-readable result bundle
xcodebuild test \
  -workspace App.xcworkspace -scheme App \
  -destination 'platform=iOS Simulator,name=iPhone 16,OS=latest' \
  -resultBundlePath .build/Test.xcresult \
  -enableCodeCoverage YES
```

**Exit codes (verified ✅):** `xcodebuild` uses `sysexits(3)`: `EX_OK` (0) on success, `EX_USAGE` (64) malformed options, `EX_NOINPUT` (66) missing inputs, `EX_SOFTWARE` (70) build/test failure. An agent can rely on `== 0 / != 0`; finer granularity is unreliable.

**Machine-readable output (verified ✅):**
- `xcrun xcresulttool get --path Test.xcresult --format json` — full result bundle as JSON; schema documented via `xcrun xcresulttool formatDescription get`. (Note: Xcode 16+ also supports `xcresulttool get test-results …` subcommands; the legacy `--format json` form is the documented one in WWDC19 materials — 🟡 newer subcommand names may shift per Xcode version.)
- `xcrun xccov view --json Test.xcresult` — coverage as JSON, easy to gate with `jq`.
- `-enumerate-tests -test-enumeration-format json` — list tests without running them (useful for scope-contract "proof commands must reference existing tests").
- Gotcha (verified ✅, 2025 runner-images issue): on GitHub `macos-15` runners, `xcrun` utilities like `xcresulttool` break if Command Line Tools (not Xcode) is the selected developer dir. Fix: `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`.

**Formatters:** `xcpretty` is effectively unmaintained (🟡 last meaningful activity years ago; fastlane now defaults elsewhere). **xcbeautify** is the current standard (verified ✅): `brew install xcbeautify`, static Swift binary, JUnit report support, and a `--renderer github-actions` mode that emits inline PR annotations. Use `set -o pipefail && xcodebuild … | xcbeautify` so the exit code survives the pipe.

### SwiftPM (`swift build` / `swift test`)

Verified ✅: zero-config, exit-code-driven, works on macOS and Linux runners. `swift test --enable-code-coverage` + `xcrun llvm-cov` for coverage. Parallel: `swift test --parallel`. Filter: `swift test --filter <regex>`. Caveat (verified ✅, SwiftPM issue #10192, June 2026): with the `swiftbuild` engine (default as of Swift 6.4), `-Xswiftc -warnings-as-errors` conflicts with the `-suppress-warnings` passed to dependency targets — a known regression; the `native` build system strips it correctly. Pin behavior in CI.

### Xcode Cloud considerations

Verified ✅ (Apple WWDC21 docs + SO reports, still accurate per 2025 answers):
- Only three hook scripts run: `ci_scripts/ci_post_clone.sh`, `ci_pre_xcodebuild.sh`, `ci_post_xcodebuild.sh`. Any auxiliary tooling must be self-contained inside `ci_scripts/`.
- **Test environments don't get the source clone** — only the build environment does; test runners see just `ci_scripts/`. Any Code Director proof step that needs source must run pre-xcodebuild or inside the build action.
- Run Script build phases must be *inlined* (no external script files) unless delegated from the three hooks.
- Swift macro packages need `defaults write com.apple.dt.Xcode IDESkipMacroFingerprintValidation -bool YES` in `ci_pre_xcodebuild.sh` (verified ✅ via a Feb 2025 SO answer).
- Practical verdict: Xcode Cloud is automatable but constraining; for an agent-driven scope contract, GitHub Actions/self-hosted macOS runners with raw `xcodebuild` give far more control. 

*Verdict (build & test): the most reliable machine gate in the entire Apple ecosystem — exit codes + xcresult JSON are first-class and documented.*

Sources: https://keith.github.io/xcode-man-pages/xcodebuild.1.html · https://github.com/actions/runner-images/issues/12892 · https://devstreaming-cdn.apple.com/videos/wwdc/2019/413kpguqjv5fqp9/413/413_testing_in_xcode.pdf · https://github.com/cpisciotta/xcbeautify · https://docs.fastlane.tools/best-practices/xcodebuild-formatters/ · https://github.com/swiftlang/swift-package-manager/issues/10192 · https://developer.apple.com/videos/play/wwdc2021/10269/

---

## 2. Lint / Format / Strict Concurrency

### SwiftLint — the de-facto linter ✅
- Install: `brew install swiftlint` (one command; also Mint, CocoaPods, pkg). Verified ✅ (present on Bitrise/GitHub images, e.g. 0.58.2 on Xcode 16.2 stacks).
- Gate command: `swiftlint lint --strict --reporter json > swiftlint.json` — `--strict` upgrades warnings to errors → non-zero exit. Config via `.swiftlint.yml` (200+ rules, opt-in rules, custom regex rules, per-path excludes).
- Apple-style mapping: rules like `force_cast`, `force_try`, `implicitly_unwrapped_optional`, `unused_optional_binding`, `private_over_fileprivate`, `attributes` (attribute placement, matching Google/Apple style guides) are all mechanical.
- Verdict: *fully scriptable, deterministic, CI-standard. The single highest-value lint gate.*

### swift-format vs SwiftFormat ✅
- **swift-format** (Apple/Swift project): bundled **in the Xcode toolchain** since Xcode 16 (verified ✅ via troz.net, Nov 2024 — run as `swift format` with the toolchain swift; also `brew install swift-format`). Gate: `swift format lint --recursive --strict Sources/`. Config via `.swift-format` JSON. Caveat: no officially blessed Swift style guide exists yet; the default style is "one possibility" (verified ✅ from the project's own README note).
- **SwiftFormat** (Nick Lockwood): most popular formatter by install base (verified ✅ via Homebrew install stats comparison), `brew install swiftformat`, gate with `swiftformat --lint .`. Fast (token-based, not SourceKit).
- Verdict: *both are one-command installable and exit-code scriptable; pick one per repo and gate with `--lint`.*

### Swift 6 strict concurrency ✅
- Build setting `SWIFT_STRICT_CONCURRENCY` = `minimal | targeted | complete` (verified ✅). In **Swift 6 language mode, complete checking is always on and warnings become errors** (verified ✅, Apple build-settings reference quoted on SO).
- SPM: `.enableExperimentalFeature("StrictConcurrency")` (tools ≤5.9) / `.enableUpcomingFeature("StrictConcurrency")` (tools 6.0) in `swiftSettings` (verified ✅, useyourloaf).
- Real-world scale: firefox-ios hit 4,000+ warnings flipping it on (verified ✅, mozilla-mobile issue, July 2025) — so for a scope contract, gate on "no *new* concurrency warnings" (diff-based) rather than zero.
- Xcode 26 / Swift 6.2 nuance (verified ✅, Swift Forums Oct 2025): some GCD-based isolation violations still compile with only a warning in Swift 6 mode and crash at runtime — the compiler gate is strong but not airtight around legacy GCD.
- Verdict: *compiler-enforced, zero extra tooling, exit-code reliable — the strongest "safety" machine check available.*

Sources: https://github.com/realm/SwiftLint · https://troz.net/post/2024/swift_format/ · https://nshipster.com/swift-format/ · https://github.com/mozilla-mobile/firefox-ios/issues/27871 · https://stackoverflow.com/questions/78997004 · https://useyourloaf.com/blog/strict-concurrency-checking-in-swift-packages/ · https://forums.swift.org/t/unexpected-behavior-with-swift-strict-concurrency-complete-in-xcode-26-swift-6/82672

---

## 3. Dead Code & Project Hygiene

### Periphery (unused Swift declarations) ✅
- Install: `brew install periphery`. Gate: `periphery scan --format json --strict` (strict → non-zero exit on any result). Verified ✅ against the current README (Aug 2026 crawl).
- How it works: builds the project, reads the **index store**, builds a reference graph, finds unreferenced declarations (types, funcs, properties, imports).
- CI pattern: reuse an existing build — `periphery scan --skip-build --index-store-path "$DD/Index.noindex/DataStore"` (Xcode) or default `.build/debug/index/store` (SwiftPM, right after `swift test`).
- Known false-positive classes (verified ✅ from README troubleshooting): `#if DEBUG` branches (only compiled config is indexed), platform-specific packages (must build with xcodebuild first), Obj-C mixed code, publicly-consumed framework API (use `--retain-public`).
- Verdict: *reliable as a gate once per-project config is tuned; expect an initial allowlist/baseline. JSON output makes diff-based gating easy.*

### Unused assets — FengNiao ⚠️
- Install: `brew install onevcat/tap/fengniao` or build from source. Gate: `fengniao --list-only --exclude Pods Carthage` (add `--xcode-warnings` for non-zero exit on findings). Verified ✅ against current README/help output.
- Method is regex string-matching of resource names against source files → false positives when names are constructed at runtime (`"icon_\(name)"`). SwiftUI/asset-catalog generated symbols (`Image(.iconFoo)`) reduce but don't eliminate this.
- Verdict: *good hygiene signal, but treat as report-only or baseline-diffed gate, never a hard fail without an allowlist.*

### xcodeproj vs generated projects (XcodeGen/Tuist) ✅
- Mechanically checkable hygiene rules: (a) if `project.yml`/`Project.swift` exists, `*.xcodeproj` should be gitignored and CI regenerates (`xcodegen` / `tuist generate`) — checkable with a two-line shell script; (b) for hand-maintained `.xcodeproj`, detect merge-conflict corruption or stale file references by running `xcodebuild -list` (non-zero exit if the project file is broken) — verified ✅ as a standard CI smoke step.
- Verdict: *fully automatable as structural checks; Tuist/XcodeGen make the project file itself a build artifact, which is the agent-friendliest setup.*

Sources: https://github.com/peripheryapp/periphery · https://github.com/onevcat/FengNiao · https://www.avanderlee.com/optimization/unused-images-clean-up/ · https://nowham.dev/posts/swift-periphery-cleanup/

---

## 4. API Availability & Deployment Targets

**The compiler is the check.** Verified ✅ (Hacking with Swift / NSHipster): since Swift 2, every API use is validated against `IPHONEOS_DEPLOYMENT_TARGET` (or SPM `platforms:`) at compile time. Unguarded use of an API newer than the deployment target is a **hard compile error**; `if #available` / `@available` are the only escape hatches. If it compiles, availability is satisfied — zero additional tooling needed.

Machine gates an agent can run:

```bash
# Prove the app respects iOS 16 floor — compile against it:
xcodebuild build -scheme App -destination 'generic/platform=iOS' IPHONEOS_DEPLOYMENT_TARGET=16.0

# Prove no deprecated APIs are used (two levels):
#  a) blunt: all warnings are errors
xcodebuild build -scheme App SWIFT_TREAT_WARNINGS_AS_ERRORS=YES
#  b) surgical (Swift 6.1+ diagnostic groups, Xcode 16.3+; SPM needs tools 6.2 / Xcode 26):
xcodebuild build -scheme App OTHER_SWIFT_FLAGS='-warnings-as-errors -Wwarning DeprecatedDeclaration'
#     …or the inverse: only deprecations are errors:
#     OTHER_SWIFT_FLAGS='-Werror DeprecatedDeclaration'
```

Verified ✅ (useyourloaf, Sep 2025; zenn Swift Advent Dec 2025): Swift 6.1 added `-Werror/-Wwarning <DiagnosticGroup>`; Swift 6.2 (Xcode 26) exposed `treatAllWarnings(as:)` / `treatWarning(_:as:)` in `Package.swift`. Known landmine (verified ✅, Swift Forums Sep 2025): Xcode injects `-suppress-warnings` into SPM dependencies, which conflicts with globally-passed `-warnings-as-errors` — still broken in Xcode 26 RC per reporters; set the flag in project/xcconfig, not CLI, to avoid it.

- `@available` annotation *presence* on your own API surfaces: checkable with a SwiftLint custom rule or SourceKit query — automatable but custom.
- Verdict: *availability = perfectly machine-checked by construction; deprecation policy = fully automatable with the right flag level.*

Sources: https://www.hackingwithswift.com/new-syntax-swift-2-availability-checking · https://nshipster.com/available/ · https://useyourloaf.com/blog/treating-warnings-as-errors-in-swift-packages/ · https://zenn.dev/treastrain/articles/4a5ad6e2ac8d62?locale=en · https://forums.swift.org/t/warnings-as-errors-in-sub-packages/70810

---

## 5. App Store / Private API

**What Apple itself does (verified ✅):** automated static analysis of the submitted binary — scanning for private selectors/symbols. Rejection messages (ITMS-90338, guideline 2.5.1) name the offending symbol; Apple explicitly advises developers to self-check with `strings`, `otool -ov`, and `nm` (verified ✅ from Apple rejection text quoted in multiple threads).

**Reproducible pre-submission scan:**

```bash
# 1. Linked libraries (IOKit, private frameworks)
otool -L Payload/App.app/App

# 2. Undefined symbols — grep against a private-symbol blocklist
nm -u Payload/App.app/App | grep -E '_UIImageWithName|_CMTimebaseCreateWithMasterClock|…'

# 3. Objective-C classes/ivars/selectors
otool -ov Payload/App.app/App | grep -E 'UIProgressHUD|_phase'

# 4. Selector strings
strings - Payload/App.app/App | grep -E '^setOrientation:$'
```

Limitations (all verified ✅ from sources):
- **Blocklist problem:** there is no official public list of private symbols; you must curate one (or use a commercial scanner, e.g. PTKD-class tools). False positives happen — Apple's own scanner once flagged public `CMTimebaseCreateWithSourceClock` as private `…MasterClock` (Bitmovin thread, 2023).
- **Evasion:** runtime-constructed selectors (`dlopen`/`dlsym`, `objc_getClass`, `NSSelectorFromString`) defeat static scans — academic work (iRiS, Georgia Tech) needed dynamic instrumentation to catch these.
- **Selector collision:** selectors are class-independent in the binary, so your own innocently-named method can match a private selector.

**Which App Store Review Guidelines are automatable:**
- ✅ Automatable: 2.5.1 private-API symbol scan (above); plist/entitlement validation (required usage-description keys `NSCameraUsageDescription` etc. — pure plist grep); deprecated-framework presence (UIWebView references via `nm`/`otool`); minimum SDK/build tooling version; app icon/asset completeness (`actool` errors at build time); bitcode/arch slices (`lipo -info`).
- ⚠️ Semi-automatable: third-party SDK inventory (scan binary for known SDK signatures — commercial tools do this); required-API declarations (privacy manifests `PrivacyInfo.xcprivacy` — schema-validatable).
- ❌ Human-only: content appropriateness (4.x), business model / IAP fairness (3.x), "app completeness" and demo-account review, design "minimum functionality" (4.2), misleading marketing claims.
- Verdict: *~20–30% of review risk is mechanically pre-checkable; the private-API scan is worth shipping with a curated blocklist, clearly labeled as heuristic.*

Sources: https://stackoverflow.com/questions/2842357 · https://forum.ionicframework.com/t/ios-application-rejected-with-reason-non-public-apis/46717 · https://ptkd.com/journal/app-store-rejection-2-5-1-software-requirements · https://community.bitmovin.com/t/apple-review-rejection-for-private-api-use/2115 · https://saltaformaggio.ece.gatech.edu/publications/deng2015iris.pdf

---

## 6. Accessibility

**The headline: yes, there is a first-party audit API** — verified ✅ across Apple WWDC23, Appium docs, and multiple 2024–2026 guides.

```swift
// In a UI test target (Xcode 15+, iOS 17+):
func testAccessibility() throws {
    let app = XCUIApplication()
    app.launch()
    try app.performAccessibilityAudit()                       // all categories
    try app.performAccessibilityAudit(for: [.contrast, .dynamicType])  // scoped
    try app.performAccessibilityAudit(for: .all) { issue in   // suppression closure
        issue.element?.label == "decorativeImage"             // true = ignore
    }
}
```

Audit categories (`XCUIAccessibilityAuditType`, verified ✅): `.dynamicType`, `.contrast`, `.elementDetection`, `.hitRegion`, `.sufficientElementDescription`, `.textClipped`, `.trait` (+ more added over releases). The test **fails automatically** on findings → inherits all of §1's CI machinery (`xcodebuild test` + xcresult JSON). Also reachable from Appium via `mobile: performAccessibilityAudit` (verified ✅, Appium XCUITest driver docs, May 2026).

Limitations (verified ✅): audits only what's **visible on screen** — a thorough gate must navigate each screen and audit per-screen; does not replace manual VoiceOver passes; industry consensus is automated a11y catches ~20–40% of WCAG-class issues. Requires a UI-testing bundle and simulator/device time (slow).

The old GUI Accessibility Inspector remains manual-only; the XCTest API is its automatable sibling (pre-Xcode-15 third-party options: A11yUITests, AccessibilitySnapshot — still useful for snapshot-based label checks).

- Verdict: *the single biggest win for the Apple pack — a first-party, machine-verifiable accessibility gate that maps directly to HIG requirements.*

Sources: https://developer.apple.com/videos/play/wwdc2023/10036/ · https://appium.github.io/appium-xcuitest-driver/11.3/reference/execute-methods/ · https://www.polpiella.dev/xcode-15-automated-accessibility-audits/ · https://agenticdevelopercookbook.com/appendix/research/developer-tools/apple/ui-verification · https://www.createwithswift.com/testing-your-apps-accessibility-ui-tests/

---

## 7. HIG — mechanically checkable vs judgment-only

**Mechanically checkable (verified ✅):**

| HIG rule | Mechanism |
|---|---|
| Tap targets ≥ 44×44 pt (iOS/iPadOS default; 28×28 absolute minimum per current HIG table) | `.hitRegion` in `performAccessibilityAudit` |
| Dynamic Type support / text scaling | `.dynamicType` audit; snapshot tests at UIContentSizeCategory AX sizes |
| Sufficient color contrast | `.contrast` audit |
| Text not clipped/truncated (incl. at large type) | `.textClipped` audit |
| Safe-area respect | partially — audit catches overlap symptoms; deterministic check = snapshot tests on multiple device simulators + diffing (🟡 tooling: swift-snapshot-testing) |
| Meaningful labels on controls | `.sufficientElementDescription` audit |
| Correct accessibility traits | `.trait` audit |

Note the HIG numbers changed: Apple's current accessibility HIG page (verified ✅) lists iOS/iPadOS **default 44×44 pt, minimum 28×28 pt** — the old "44 or bust" is now a default, not a floor. WCAG 2.2 AA separately requires only 24×24 (SC 2.5.8). A scope contract should pick the 44pt default as the gate since the audit API enforces it.

**Judgment-only (not machine-checkable):** visual hierarchy and layout aesthetics, icon/metaphor appropriateness, brand voice, motion/animation tastefulness, navigation-model fit, haptics appropriateness, dark-mode aesthetic quality (contrast is checkable; palette taste is not), writing quality of labels (presence is checkable; clarity is not).

- Verdict: *roughly the "geometry + exposure" half of HIG is machine-checkable via the audit API and snapshot tests; the "taste" half never will be.*

Sources: https://developer.apple.com/design/human-interface-guidelines/accessibility · https://docs.deque.com/devtools-mobile/2025.7.2/en/ios-touch-target-size/ · https://testparty.ai/blog/wcag-target-size-guide · https://www.smashingmagazine.com/2023/04/accessible-tap-target-sizes-rage-taps-clicks/

---

## 8. Performance / Energy

**XCTest performance metrics as CI gates (verified ✅):**

```swift
func testLaunch() {
    measure(metrics: [XCTApplicationLaunchMetric()]) { XCUIApplication().launch() }
}
func testScroll() throws {
    let app = XCUIApplication(); app.launch()
    let options = XCTMeasureOptions()
    options.invocationOptions = [.manuallyStop]
    measure(metrics: [XCTOSSignpostMetric.scrollDecelerationMetric], options: options) {
        app.collectionViews.firstMatch.swipeUp(velocity: .fast)
        stopMeasuring()
    }
}
```

Available metrics (verified ✅): `XCTClockMetric`, `XCTCPUMetric`, `XCTMemoryMetric`, `XCTStorageMetric`, `XCTOSSignpostMetric` (incl. UIKit-provided `scrollDecelerationMetric`, `scrollDraggingMetric`, `navigationTransitionMetric`), `XCTApplicationLaunchMetric`; custom metrics via the `XCTMetric` protocol. Baselines: Xcode records per-test baseline averages + allowed stddev; the test **fails** on regression → CI-gateable.

**The hard caveats (all verified ✅, testableapple.com deep-dive):**
1. Baselines are **per machine AND per device model** — a baseline recorded on an M4 Mac mini is invalid on an M1 runner.
2. **Simulators support almost no metrics** — only (useless) Duration. Frame rate, hitches, hitch-time-ratio need a **physical device**. Memory/CPU metrics are likewise device-oriented.
3. High run-to-run variance → flaky gates; `measure` does 5 iterations + 1 warmup, not configurable.
4. Practical CI patterns: self-hosted runner with an attached device, or parse metric values from logs/xcresult and compare against your own JSON baseline (worked example in the source), or Firebase Test Lab for device farms.

**os_signpost:** instrument with `os_signpost(.begin/.end, log:name:)` (and `.animationBegin` for animation hitches, WWDC20), then assert via `XCTOSSignpostMetric(subsystem:category:name:)`. Instruments CLI exists as `xcrun xctrace record/export` (🟡 recollection: usable headless but finicky; treat as optional deep-dive tooling, not a gate). **Energy**: MetricKit `XCTMetric`-adjacent energy diagnostics exist via `XCTCPUMetric` etc., but true energy/thermal measurement is device-only and Organizer/MetricKit-driven — not a CI gate (🟡).

- Verdict: *mechanically gateable only with dedicated hardware pinned in CI; on generic hosted runners, limit perf gates to launch-time + clock metrics with wide tolerances.*

Sources: https://developer.apple.com/videos/play/wwdc2020/10077/ · https://testableapple.com/xctmetric/ · https://github.com/SoaurabhK/XCMetrics · https://www.chimehq.com/blog/xctest-performance · https://stackoverflow.com/questions/70867323

---

## Design recommendations for the Code Director "Apple pack"

1. **Tier-1 proof commands (hard gates, zero ambiguity):** `xcodebuild build`, `xcodebuild test` + xcresult JSON assertion, `swift build/test` for SPM, `swiftlint --strict`, `swift format lint --strict`, strict-concurrency compile, deployment-target compile. All exit-code + JSON verifiable.
2. **Tier-2 (hard gates with config):** Periphery (needs `.periphery.yml` + baseline), `-Werror DeprecatedDeclaration` policy, privacy-manifest schema check, plist usage-key check.
3. **Tier-3 (report/baseline-diff, not hard fail):** FengNiao unused assets, private-API blocklist scan (heuristic), perf metrics on shared runners.
4. **Tier-4 (needs device/simulator time but first-party):** `performAccessibilityAudit` per-screen suite — this covers most of the HIG mechanical half and should be the pack's flagship UI gate.
5. **Explicitly out of scope (human judgment):** HIG aesthetics, most App Store Review content/business guidelines, VoiceOver interaction quality, energy profiling.

*Report compiled September 2026. Items marked ✅ were verified against the linked 2024–2026 sources during research; items marked 🟡 are stated from older sources or recollection and should be re-verified against the then-current Xcode before being hard-wired into a contract.*
