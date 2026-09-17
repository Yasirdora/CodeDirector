# Human Interface Guidelines — what Code Director enforces, and what it refuses to fake

This is the Apple-platform interface rulebook. It exists to close one specific
gap: today the apple profile knows versions, dependencies and verification —
but asked "is this screen HIG-correct?", the honest answer was *nobody checks*.
This doc splits that question into the half a machine can answer and the half
it must never pretend to.

**The rule above all rules: label every claim.** Any statement about what
Apple prefers is either sourced (a link to developer.apple.com/documentation
or the HIG) or explicitly marked *"no official guidance — this is my
judgment."* A hallucinated API or an invented Apple decree is worse than no
answer, because it ships.

## The mechanical half — machine-checkable, enforce it

These have numbers or APIs behind them. Check them, fail on them, name the
violation in the Change Report.

- **Tap targets.** 44×44 pt minimum on iOS; 28×28 pt is the WCAG-adjacent
  floor, never the target. WCAG 2.2's own minimum is 24×24 px — below that is
  a bug, not a style.
- **Contrast.** Text and meaningful glyphs must meet contrast minimums; the
  audit measures it, so measure.
- **Dynamic Type.** Text must scale. If a layout clips at accessibility sizes,
  that's a defect — see the audit categories below.
- **Safe area.** Content under a notch, home indicator or toolbar is a bug.
- **Labels and traits.** Interactive elements need accessibility labels;
  custom controls need the right traits (button, header, selected). An
  unlabeled icon button is invisible to VoiceOver.
- **Version floors.** Never recommend an API newer than the target's minimum
  deployment. Check the project's deployment target *before* recommending —
  not after the user reports a build error.

### The one API that does the measuring

`performAccessibilityAudit` (XCTest, Xcode 15 / iOS 17+) runs Apple's own
audit on the **visible screen** and reports issues by category:
`.dynamicType`, `.contrast`, `.elementDetection`, `.hitRegion`,
`.sufficientElementDescription`, `.textClipped`, `.trait`.

Known limits, stated so nobody overclaims:

- It audits the visible screen only — each screen/state needs its own pass.
- It catches roughly 20–40% of WCAG-class issues. A clean audit is evidence,
  not proof.
- It does not judge whether the UI is *good* — see below.

For UI work, add `custom:XCTest performAccessibilityAudit passes` as a keep
clause and audit before reporting done (already in the apple skill's decision
rules; this doc is why it says that).

### Probe before you recommend

Before recommending any API — especially one you're "sure" exists — compile a
minimal probe against the project's actual Xcode:

```sh
xcrun swiftc -typecheck -sdk $(xcrun --show-sdk-path) probe.swift
```

An API that doesn't exist fails right there, in seconds, instead of inside
the user's build. Recommendation without a probe is a guess wearing a lab
coat.

## The judgment half — human-only, say so

Hierarchy, taste, motion, spacing rhythm, whether a screen *feels right* —
these are the user's call. The tool's job here is narrow and honest:

- Offer 2–3 concrete directions with a one-line trade-off each; recommend one;
  say why in terms of the user's own app.
- Never present a taste decision as an Apple requirement. If Apple has no
  stated preference, say exactly that.
- Never ship "looks fine to me" as verification. The mechanical half is
  verifiable; the judgment half is *presented for approval*.

## Liquid glass (26/27 era) — lessons from the eDraft trenches

These were learned by breaking a real app, not read from docs. Each is marked
accordingly.

- **Use the native control.** `NSSegmentedControl` / `.pickerStyle(segmented)`
  get the platform's glass treatment for free on 26+. A custom-painted
  segmented control on a glass surface is the worst of both worlds.
  *(Observed in eDraft; consistent with Apple's "prefer system controls on
  glass" guidance.)*
- **`.ultraThinMaterial`** for overlay surfaces intended to sit on glass.
  *(Judgment call, worked in eDraft.)*
- **Never paint `selectedSegmentBezelColor`** — or any selection chrome the
  system owns. Painting it kills the system glass effect; the eDraft custom
  overlay capsules made things strictly worse and were removed.
- **Let the platform upgrade you.** Controls sitting on glass surfaces inherit
  the new appearance on 26/27 without code changes. Work done to "match" the
  new look by hand usually fights the system.
- **Version awareness.** 26 is the liquid-glass era; 27.0 is released. A
  target deploying to 26.0 runs correctly on 27 by construction — but "works"
  and "looks native" are different questions, and only the audit plus a human
  looking at the screen answers the second.

## The honesty contract, restated

Every interface recommendation takes this shape:

```
Recommended:  X
Why:          1–2 reasons tied to this app
Apple's approach: <link> — or "no official guidance, this is my judgment"
Alternative:  Y, and when Y would be better
```

If a claim about Apple carries no source and no judgment label, it is a
defect — in the doc, in the chat, or in the code — and should be called out
as one.
