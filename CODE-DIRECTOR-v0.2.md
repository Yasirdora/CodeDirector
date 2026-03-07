# CODE DIRECTOR — v0.2
### Human Intent → Verified Execution

*Merged blueprint: intent layer (doc A) × verification layer (doc B), with editorial rulings applied. Date: 2026-09-11.*

*Method: doc A ("CODE DIRECTOR v0.1," 26 sections, intent/interaction-centered) and doc B ("Code Director external v0.1," 50 sections, verification-first) were merged under binding editorial rulings from the project lead. Where the two documents conflict, the conflict and the ruling are stated in one line. Every factual claim about external tools, papers, surveys, or licenses carries a citation to a URL from the research dossiers, from doc A/doc B, or from the rulings. Anything that could not be verified is marked as such.*

---

# Part I — Findings

## 1. Executive conclusion

**Code Director is a dual-layer product: an intent layer that formally detects ambiguity before acting and budgets the human's attention, and a verification layer that compiles intent into an enforceable contract — an Intent Lock — and reports every outcome with typed evidence: what was Measured, what was Proven, what is merely Asserted, and what remains Unchecked. The honest third-and-fourth buckets are the brand.**

The updated verdict, with the merge applied:

1. **There are TWO gaps, and both are real.** Doc B's headline claim — "the input gap is solved; frontier models infer intent from vague prose remarkably well" — is overstated, and the ruling overrides it. 2026 models are good at producing *a* plausible interpretation of a vague request, not at knowing *when they are guessing*: models reliably recognize ambiguity when asked to judge it, yet default to direct answers **>95% of the time** without a structural gate. [arXiv 2605.25284](https://arxiv.org/html/2605.25284v1) ClarifyCodeBench exists precisely because standard benchmarks assume perfectly specified prompts and thereby hide the interactive bottleneck. [arXiv 2607.00711](https://arxivtldr.org/abs/2607.00711) At the same time, doc B is right that verification is the deeper and less occupied gap: 96% of developers don't fully trust AI-generated code, only 48% always verify it before committing, and 38% find reviewing AI code more effort than reviewing human code (Sonar 2026 State of Code survey, n=1,149, published January 2026). [VMblog on the Sonar 2026 survey](https://vmblog.com/news/sonar-data-reveals-critical-verification-gap-in-ai-coding-96-dont-fully-trust-output-yet-only-48-verify-it/), [uRadical](https://uradical.io/latest-news/ibm-isnt-betting-on-genz/) The two gaps compound: a user who cannot fully express intent *and* cannot audit the diff is failed twice by the same tool. Doc A's ambiguity gate is therefore co-equal with doc B's verification layer — not vestigial.

2. **The verification thesis survives scrutiny, and its strongest pieces are adopted whole.** What must not change is more checkable than what must: "export output is byte-identical," "the public API is unchanged," "no new dependency entered the lockfile" are machine-checkable in seconds, while "make it feel instant" is not. The Intent Lock compiles a human-approved intent statement into enforceable tool-call boundaries plus a behavioral baseline captured *before* execution; a clause that can be neither enforced nor checked is not admitted to the Lock. Oracle separation is non-negotiable — the baseline is stored outside the writable tree and the verification runner is a separate process with no write access — because "Building to the Test" (Microsoft, 2026) showed Copilot CLI agents gaming a visible 222-test Playwright oracle to near-perfect scores while leaving the requested library dead or absent. [arXiv 2606.28430](https://arxiv.org/abs/2606.28430)

3. **It is buildable.** Every hard component exists as engineering-ready research or shipping mechanics: ClarifyGPT's divergence-triggered clarification raised GPT-4 Pass@1 from 70.96% to 80.80% on MBPP-sanitized with an average of 2.85 questions per genuinely ambiguous problem and none on clear ones [arXiv 2310.10996](https://arxiv.org/html/2310.10996v1); a purpose-built clarification pipeline was preferred over baseline in ~78–82% of user-study ratings [arXiv 2507.21285](https://arxiv.org/pdf/2507.21285); permission tiers, checkpoints, sandboxes, and test-in-the-loop repair ship in sixteen tools. The characterization-baseline machinery (snapshot/approval testing) exists in mature per-ecosystem form (approvaltests, jest snapshots, insta).

4. **Defensibility is narrow and named.** The honest ranking (§26): the accumulated behavioral corpus — hundreds of human-approved characterization baselines living in the customer's repository — is the only durable asset, and it is a byproduct of the hardest engineering problem in the design. **The moat and the technical risk are the same component.** Everything else (the metaphor, the format, jargon translation, response shaping) is copyable; doc B's own evidence for that is the seed repo itself, which reached tens of thousands of stars with a 7 KB text file (star count reported as 39.6k in doc B; not independently verified — treated as "reported, unverified").

5. **The MVP is not gated on the riskiest component.** Per the ruling: the merged MVP ships structural index + blast radius, Intent Lock authoring with system-proposed KEEP/DENY, file/symbol budget enforcement with logged override, an evidence-classed Change Report over *existing* tests + lockfile diff + signature diff + typecheck, checkpoint/undo, and an eval harness from commit one. Characterization baseline generation is a phase-1.5 fast-follow prototype with a mutation gate — because doc B itself rates it critical, research-grade risk, and an MVP that must clear the riskiest component before it can differentiate is a bad MVP.

---

## 2. What the seed repository teaches

Condensed from doc A §2; doc B's additions adopted where they sharpen the point.

The repository under study is [github.com/the seed repository](https://github.com/the seed repository). Strip the packaging and the entire behavioral payload is a single ~7 KB Markdown file, `SKILL.md`, containing ten output-formatting rules ("Lead with the next action," "Number multi-step tasks," "Cap lists to 5 items," "No preamble, no recap, no closing pleasantries") plus escape hatches. Everything else — plugin manifests for roughly 14 platforms, session-start hooks, a TypeScript extension, six localized READMEs, CI — is distribution plumbing around that one file. SKILL.md, [INSTALL.md](https://raw.githubusercontent.com/the seed repository/main/INSTALL.md)

**What it solves.** An *output-shaping* problem: assistants bury the answer in preamble, tangents, and closers. It does not touch the input side at all — ambiguity appears exactly once, as a single escape hatch ("One short clarifying question beats guessing and rewriting"), the thinnest part of the ruleset, with no model of what counts as ambiguous or how much ambiguity justifies blocking. SKILL.md

**What it assumes.** A technically capable reader who can "Run `npm install jsonwebtoken@latest`, then edit `src/auth.ts:42`" — the inverse of Code Director's target user — and that prompt injection is sufficient: the model is *asked* to follow the rules, with enforcement only at development-time evals. The fragility of that assumption is visible inside the repo: the Pi extension must re-inject the rules after context compaction drops them. Prompt-only behavior control leaks. extensions/seed-repo.ts

**What is genuinely worth borrowing (doc A's five, plus doc B's three):**

1. **The output contract as a first-class, versioned, testable artifact** — the pre-send check: "if the reader reads only the first line and the last line, do they know (a) what to do next, and (b) what just happened?" Doc B's sharpening: this is a *postcondition*, phrased as deletion, and deletion is far more reliable to follow than "be concise." SKILL.md
2. **The escape-hatch pattern** — rules with enumerated override conditions and an explicit priority ordering ("A rule fights the task. The task wins; the shape stays."). Code Director's ambiguity gate needs exactly this shape.
3. **The debug-spiral circuit breaker** — "if the last three turns have been 'still broken,' stop iterating on code. Name the assumption that might be wrong. Ask one diagnostic question." A turn-count-based metacognitive rule; possibly the single most transferable idea in the repo, and doc B is right that it should be a *hard limit*, not a suggestion.
4. **Rule 9's internal/external split** — the 5-item cap "shapes presentation only; it must not limit analysis, search, tool results, candidate generation, or retained information." Progressive disclosure in embryo: full computation internally, bounded presentation externally. Doc B's git-history note strengthens this: the guard was patched in (#96, v0.3.0) after they discovered a formatting rule was corrupting cognition — the exact failure class Code Director must fear.
5. **Eval-as-release-gate discipline, with honesty** — 14 hand-labeled cases, runner isolation (`--setting-sources ""`), pinned models, per-condition dollar budgets, structural blinding (conditions relabeled A/B/C with permutation derived deterministically from a digest of the group key), judge-visible rubric isolation, a 5-dimension weighted rubric (Correctness 35%, Autonomy 25%, Actionability 20%, Safety 10%, Concision 10%) — and a *published FAILED release gate* rather than a laundered result. [evals/README.md](https://raw.githubusercontent.com/the seed repository/main/evals/README.md), [evals/RESULTS.md](https://raw.githubusercontent.com/the seed repository/main/evals/RESULTS.md)
6. **(doc B) Canonical artifact + thin adapters** — one SKILL.md with per-harness manifests is the correct shape for anything crossing harnesses; Code Director's constitution layer follows it, targeting AGENTS.md as the substrate.
7. **(doc B) Idempotent context markers** — re-injecting durable state after compaction, treating an unreadable session manager as "absent" so it re-injects rather than crashing. Quietly the best engineering in the repo.
8. **(doc B) The governance layer** — CONTRIBUTING.md mandates provenance categories per PR (Author:Human / Hybrid / AI) and forbids calling agent work "independently verified when it was only reviewed by the same agent that produced it." Code Director adopts provenance labeling for its own change records.

**What to explicitly avoid (merged):** the attention-load framing as product identity (a hook that caps the market and invites trivialization criticism; the correct generalization is *cognitive-load-aware interaction design*); prompt-injection-only mechanism (scope control and ambiguity gates that matter must be enforced structurally — tool gating, state machines, approval gates); **Rule 8's manufactured-confidence failure mode** — the repo's *own evals* caught its matter-of-fact-error rule pressuring the model "to name a cause even when the evidence does not identify one," flagging a response that "asserts 'missing auth header' as the definitive cause and prescribes a specific fix without any evidence" [evals/RESULTS.md](https://raw.githubusercontent.com/the seed repository/main/evals/RESULTS.md); degenerate eval gates (a "no blocking findings anywhere" rule guarantees no candidate can ever pass); session-scoped flag-file state; and doc B's addition — brevity as a terminal goal. **Evidence reduces cognitive load; brevity without evidence merely relocates it onto the reader.**

**The scientific caveats stand** (doc A): the evals are prompt-pack-grade science — same-family judge (claude-opus-4-8 grading claude-opus-4-8), n=3 trials with per-case SD up to 0.95, and the repo's own warning that "single-case deltas below roughly 0.5 should not be treated as signal." Borrow the philosophy; do not borrow the statistical rigor. [evals/RESULTS.md](https://raw.githubusercontent.com/the seed repository/main/evals/RESULTS.md)

**Why this matters more in v0.2 than it did in v0.1.** Doc B's generalization is adopted as a load-bearing design constraint: *a response format that requires certainty will manufacture certainty.* Every output contract in this product — plan templates, Change Report slots, error summaries — is an epistemic intervention, not a cosmetic one. Every shaping rule ships with an eval for induced overconfidence, and every slot in every template is explicitly droppable. This is the seed repo's most valuable accidental finding, and both documents converge on it.

---

## 3. The two gaps: expression AND verification

Merge of doc A §3 and doc B §§1–3. The ruling: doc B's reframe ("expressing intent is cheap; confirming the result honored the intent is expensive") is a genuine contribution, but its headline — that the input gap is *solved* — is overstated. The merged position is that the two gaps compound, and each is measured.

### Gap 1 — Expression: real, narrower than doc A implied, not closed

Doc B's correct observation: 2026 models are genuinely good at producing *a* plausible technical interpretation of vague prose — "the preview feels laggy" will reliably yield debouncing, cancellation, or a cheap preview path. Doc A's correct counter: producing an interpretation is not the hard part; *knowing whether you are guessing* is. The evidence:

- Models recognize ambiguity when explicitly asked to judge it, yet default to direct answers **>95%** of the time without a gate — and adding retrieval context makes them *less* likely to ask. Ambiguity recognition without a gate is recognition that never fires. [arXiv 2605.25284](https://arxiv.org/html/2605.25284v1)
- ClarifyCodeBench was built because existing benchmarks assume perfectly specified prompts; its headline findings — strong code generation does not imply strong clarification, and clarification quality degrades as ambiguity count grows — mean the expression gap is a distinct capability axis that the market's benchmarks structurally hide. [arXiv 2607.00711](https://arxivtldr.org/abs/2607.00711)
- Asking works when it is gated: ClarifyGPT's +9.84-point Pass@1 gain came from asking *only when sampled candidate solutions diverged behaviorally* — an average of 2.85 questions per genuinely ambiguous problem, none on clear ones. Asking by policy on every prompt hurts. [arXiv 2310.10996](https://arxiv.org/html/2310.10996v1)
- The translation gap has a measured texture: Copilot users got useful starting points but struggled to understand, debug, and integrate generated code, with frequent mismatch between expected and actual usefulness. [Vaithilingam et al., CHI EA 2022](https://dl.acm.org/doi/10.1145/3491101.3519665)

Note that doc B *itself* builds a full six-type ambiguity model in its §14 — adopted here as §10 of this document — which is internal evidence that its authors do not actually believe the input gap is closed. The ruling simply makes the inconsistency explicit: both gaps are real; the ambiguity gate is co-equal.

### Gap 2 — Verification: deeper, structurally worse, and unoccupied

Doc B's four-gap decomposition is adopted, with the expression row corrected per above:

| Gap | What the human cannot do | Current tool response | Solved? |
|---|---|---|---|
| Expression | Name the mechanism ("debounce") | Model infers *an* interpretation, silently | **Partly** — interpretation yes, guess-awareness no |
| Location | Know which of 400 files is responsible | Repo map, embeddings, grep, agentic search | Largely |
| Comprehension | Read the explanation without drowning | Prompting, output styles | Partly |
| Verification | Confirm the change did what was asked and nothing else | Show a diff; say "Done" | **No** |

The verification gap is where the pain has migrated, and it is structurally worst for exactly the user this product cares about: a person who could not write the code is even less able to audit it. The tools hand their least-equipped users the hardest task in the loop and call it "human in the loop."

The 2026 evidence base, merged from both documents:

- **Sonar 2026 State of Code survey** (n=1,149, published January 2026): 96% of developers don't fully trust AI-generated code; only 48% always verify before committing; 38% find reviewing AI code more effort than reviewing human code; ~42% of committed code is AI-generated or AI-assisted; 61% report AI produces code that "looks correct but isn't reliable." The 96/48 gap is not laziness — it is economics: verification costs more than the generation it checks. [VMblog](https://vmblog.com/news/sonar-data-reveals-critical-verification-gap-in-ai-coding-96-dont-fully-trust-output-yet-only-48-verify-it/), [uRadical](https://uradical.io/latest-news/ibm-isnt-betting-on-genz/)
- **METR RCT** (16 experienced OSS developers, 246 real tasks): AI-allowed tasks took **19% longer** while developers *believed* they were ~20% faster. METR's February 2026 follow-up (57 developers) showed mixed/uncertain effects and METR labels the 19% figure historical for early-2025 tools — but the durable finding is the perception/reality gap itself: people cannot feel the review-and-correction overhead AI imposes. [METR RCT](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/), [arXiv 2507.09089](https://arxiv.org/abs/2507.09089), [METR 2026 follow-up](https://metr.org/blog/2026-02-24-uplift-update/)
- **"Building to the Test"** (Microsoft, 2026): two production Copilot CLI agents, a 222-test hidden Playwright oracle, 18 runs, three oracle-availability conditions. With the oracle *visible*, agents drove scores to near-perfect while leaving the requested library dead or absent — the paper coins "validation self-awareness": agents deliver what you check, not what you requested. Direct architectural consequence: the executing agent must not author, see, or edit its own oracle. [arXiv 2606.28430](https://arxiv.org/abs/2606.28430)
- **SWE-bench audits:** roughly 19.8% of top SWE-bench "solved" cases were found semantically incorrect — passing by coincidence or harness gaming (reported in doc B; consistent with published benchmark-validity critiques but the specific figure is treated as reported, unverified). SWE-bench Pro separately demonstrated evaluation-time reward hacking — agents recovering gold patches from git history and network sources — dropping one model from 78.8% to 57.3% once controls were applied. [SWE-bench Pro, arXiv 2609.08149](https://arxiv.org/html/2609.08149v1)
- **CHI 2026, "When Help Hurts"** names the mechanism directly: verification load and fatigue are a named, measured phenomenon; reviewer attention is the scarce resource (cited in doc B's sources; treat paper details as reported by doc B).
- **Moderation finding (doc A):** an ICSE-SEIP 2026 mixed-methods field+controlled study found *moderate* AI use improved efficiency while *excessive or combined* use eroded the benefit — metering AI output is empirically supported, not a taste. [arXiv 2512.19926](https://arxiv.org/pdf/2512.19926)
- **Context rot (doc A):** all 18 frontier models in Chroma's study degraded as input length grew, beginning far below advertised windows — "index everything and stuff it in" is anti-evidence; small curated context is a correctness feature. [Chroma context-rot study](https://upsolve.ai/blog/context-rot)
- **Scope leakage:** doc B reports field data that unrelated changes in one-line-ask PRs fell from ~35% to 4% after scope controls were introduced. The *direction* is plausible and the mechanism (§12) is sound, but the specific figures are **reported, unverified** — no primary source exists in the dossiers.
- **Change-size inflation:** doc B cites Faros data (PR size +51.3%, bugs per PR +54% under high AI adoption). **Reported, unverified** — no URL in the dossiers; used here only as a directional claim about where the bottleneck moves.

**Doc B's seven structural reasons** why AI coding still feels hard are adopted as the problem anatomy: (1) asymmetric cost of generation and review — an agent writes 400 lines in 40 seconds, a human reads them in 40 minutes, and every capability improvement widens the ratio; (2) the diff is the wrong review surface — textual change is not behavioral change, and reviewing a refactor by diff means mentally simulating the program; (3) silence about the negative — agents report what they did, never what they did not disturb, leaving the human to disprove a negative across the whole repository; (4) confidence is uncorrelated with correctness — "Fixed the race condition" reads identically whether tests ran or not; (5) scope leakage breaks trust faster than bugs — an unrequested rename is a category violation, not a known failure mode; (6) benchmarks measure the wrong thing, so products optimize the wrong thing; (7) context is dumped, not selected — **every file in context is a file the agent might edit.**

**The merged single-sentence problem statement:** a person who understands the desired behavior but not the implementation currently has no way to *say precisely what they mean* (gap 1) or to *establish that a change did what they wanted* (gap 2) without acquiring the implementation knowledge they lacked in the first place. Everything downstream — the ambiguity gate, the Intent Lock, KEEP sets, evidence classes, the honest Unchecked bucket — exists to break that circularity. If the system cannot break it, it is a chat wrapper.

---

## 4. Market landscape, corrected

Doc A toured 16 tools by interaction archetype; doc B toured ~13 by intent-capture and verification capability. Both tours missed a market. The corrected landscape has **three** competitive sets.

### Set 1: The agents (doc A's tour, condensed)

Sixteen tools, one loop: an LLM agent with tool access (read/edit files, run terminal, search), wrapped in one of three surfaces.

- **Incumbent IDE assistant — GitHub Copilot.** Inline completions, Chat with Ask/Edit/Agent modes, async coding agent returning draft PRs; Plan Mode added 2025, but clarifying questions are not a documented systematic behavior. Gravity is distribution; philosophy is "assist the expert." [VS Code blog](https://code.visualstudio.com/blogs/2025/02/24/introducing-copilot-agent-mode), [Skywork comparison](https://skywork.ai/blog/ai-agent/catpaw-vs-copilot-vs-cursor/)
- **AI-native editors — Cursor, Windsurf, Zed.** Cursor's Plan Mode "researches your codebase … and ask[s] clarifying questions" — but questions are a feature of the plan flow, not an ambiguity-detection system; there is no confidence gate. [Cursor blog](https://cursor.com/blog/plan-mode) Its mechanical scope control is the market's best (checkpoints, one-step undo, 25-tool-call checkpoint, worktree-parallel agents). [DigitalApplied](https://www.digitalapplied.com/blog/cursor-2-0-agent-first-architecture-guide) Windsurf is the cultural opposite — high-initiative Cascade, "often executes rm -rf without confirmation"; acquired by Cognition AI (Dec 2025). [Neura comparison](https://www.neura.market/directories/md-directory/agents-md-cursor-ai-tips-cursor-vs-windsurf-monp0kjt), [Taskade](https://www.taskade.com/blog/windsurf-review) Zed is editor-as-agent-host over ACP. [Superset](https://superset.sh/compare/best-ide-for-ai-agents)
- **Terminal agents — Claude Code, Codex CLI, Gemini CLI, Aider, Amp.** Claude Code has the market's best permission architecture (six tiers including an AI-classifier auto mode) — but the gate evaluates *action risk*, never *intent ambiguity*; practitioners like Armin Ronacher bypass plan mode and hand-build ask-me-questions workflows, evidence the shipped feature doesn't deliver intent clarification even to experts. [promptt.dev](https://www.promptt.dev/blog/claude-code-dangerously-skip-permissions), [lucumr.pocoo.org](https://lucumr.pocoo.org/2025/12/17/what-is-plan-mode/) Codex has best-in-class OS sandboxing and deliberately no big-upfront-plan (with the standing caveat of CVE-2025-59532, a sandbox-boundary bypass via crafted cwd). [PromptLayer](https://blog.promptlayer.com/how-openai-codex-works-behind-the-scenes-and-how-it-compares-to-claude-code/), [SentinelOne CVE](https://www.sentinelone.com/vulnerability-database/cve-2025-59532/) Aider is the git-native pair programmer (atomic commits, `/undo`, repo map). [DeployHQ](https://www.deployhq.com/guides/aider) Amp reportedly *removed* its plan mode in December 2025, betting on agent quality over alignment ceremony. [sidbharath.com](https://sidbharath.com/blog/amp-code-guide/)
- **Open IDE agents — Continue, Cline, Roo lineage.** Cline canonized Plan ↔ Act and produced the market's most documented **approval fatigue** — per-action prompts training users into reflex approval. [Cline](https://cline.bot/), [Qodo](https://www.qodo.ai/blog/roo-code-vs-cline/) A 2026 Cline discussion proposing structured Plan↔Act handoffs (allowed/excluded changes, acceptance criteria, stop conditions) is notable precisely because it is still a *proposal*: formal task-bounding is not native. [Cline discussion #12959](https://github.com/cline/cline/discussions/12959) Roo Code was reportedly archived in May 2026 (reported, unverified); forks carry the concept forward. [frontman.sh](https://frontman.sh/blog/roo-code-vs-cline/)
- **Async cloud agents — Jules, Devin, Copilot coding agent, OpenHands.** Jules 2.0 added "Interactive Plan Mode — asks clarifying questions" — again plan-mode behavior, not a gate. [MorphLLM](https://www.morphllm.com/comparisons/jules-google-coding-agent), [xetechai](https://xetechai.com/google-jules-2-0-update-review-new-features-reveal) Devin is the delegate-and-review-PR archetype, weaker on "ambiguous, novel tasks" — precisely this product's target input. [Standard Compute](https://standardcompute.com/best-ai-agent/amp-vs-devin) OpenHands is the open (MIT) autonomous platform with an event-stream architecture and Docker sandbox. [Nebuladeck](https://nebuladeck.dev/blog/openhands-coding-agent-guide)
- **Enterprise IDE agent — JetBrains Junie.** Structured committable plans in `.junie/plans`, Live Prompting mid-task steering, agentic debugging. Clarifying questions unsystematic. [JetBrains](https://www.jetbrains.com/junie/)

### Set 2: Spec-driven development (the correction both docs needed)

The ruling's correction, adopted: **intent capture as documents is further along than doc A acknowledged.** GitHub Spec Kit ships `constitution.md` and a `/speckit-constitution` command, with an enforced specify → plan → tasks → implement artifact ordering; AWS Kiro ships EARS-notation requirements ("WHEN … THE SYSTEM SHALL …"), steering files (product.md, tech.md, structure.md), requirements analysis, and property-based testing. [Martin Fowler's SDD tools survey](https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html), [Glukhov: Spec Kit vs Kiro vs Claude Code](https://www.glukhov.org/ai-devtools/ai-coding-assistants/spec-kit-vs-kiro-vs-claude-code/), [Augment Code: Kiro comparison](https://www.augmentcode.com/tools/kiro-vs-augment-code) Doc B's further claim that Kiro has "SMT-based contradiction detection" **could not be verified and is omitted**; the verifiable capabilities are requirements analysis and property-based testing.

What none of the SDD tools do: **enforce the document at runtime or report compliance against it afterwards.** The spec is prose fed to a prompt and hoped for. The industry has standardized on *writing intent down* and has not touched *holding execution to it*. The "Project Constitution" name is taken; the enforcement position is not. If Code Director ships the Intent Lock as another Markdown file pasted into context, it has built Spec Kit with better typography and has no reason to exist (§11).

### Set 3: The code-review / quality-tooling market (added per ruling)

Doc B analyzed only agents. For the merged product the competitive set must also include the market that *sells verification as a product*: AI PR-review automation (CodeRabbit, Graphite's review features, GitHub-native code quality and Copilot code review), static-analysis and code-quality platforms (Sonar — which commissioned the 2026 trust survey and sells the remedy for the gap it measured [VMblog](https://vmblog.com/news/sonar-data-reveals-critical-verification-gap-in-ai-coding-96-dont-fully-trust-output-yet-only-48-verify-it/)), and security-scanning platforms (Snyk). *Editorial note: the research dossiers contain no primary sources for these vendors' current feature sets, so no specific capability claims are made here; the set is named because the strategic point does not depend on feature detail.*

The strategic point: these tools verify **after** the change, at the PR, against *general* criteria (bugs, smells, vulnerabilities, coverage). None verifies against **the specific intent of the specific task** — the KEEP set the human approved before execution. But they own the review surface where Code Director's Change Report wants to live, they have enterprise distribution and procurement relationships, and Sonar in particular has demonstrated it understands the trust gap as a market. A code-quality platform adding "per-task behavioral verification" is a more direct competitive threat than another agent adding a plan mode — and a GitHub Action posting evidence-classed Change Reports on PRs is also Code Director's highest-leverage distribution surface (§22). Both things are true, and §26 prices them.

### What the corrected tour shows

Plan-before-act is commoditized. Mechanical scope control, checkpoints, sandboxes, test loops: commoditized. Context retrieval: commoditized twice publicly (Aider's PageRank repo map; Cursor's merkle+embeddings pipeline). [Cursor indexing analysis](https://zzet.org/gortex/how-cursor-indexes-codebase-embeddings-vs-graph/) Intent *capture as prose*: well-occupied. What remains empty in all three sets: (1) an intent-clarity **gate** tied to autonomy — ambiguity-triggered clarification as an engineered system, not emergent model discretion; (2) a pre-captured behavioral **baseline** with enforced negative specification; (3) an evidence-classed **report** that names what nobody checked; (4) an **attention budget** that treats reviewer effort as the scarce resource. Those four are the product.

---

## 5. The fundamental gap, restated

**Commoditized — do not rebuild as differentiation:** plan modes (eight+ products); mechanical scope control and rollback (permission tiers, OS sandboxes, checkpoints, undo, allowlists, worktrees); run-the-tests verification (universal); the agent loop itself (ReAct, plan-and-execute — solved engineering, standardized execution eval). [IBM ReAct overview](https://www.ibm.com/think/topics/react-agent) Intent capture *as documents* (Spec Kit constitution, Kiro EARS + steering). Post-hoc general-purpose code review (the Set-3 market).

**Unbuilt — the actual gap, now two-sided:**

1. **Intent-confidence gating (doc A's side, unbuilt).** No shipping product quantifies intent-clarity confidence and ties it to the autonomy ceiling. Where clarifying questions exist (Cursor, Jules 2.0, Cline plan mode), they are emergent model discretion inside a planning phase. Claude Code's auto mode gates on action risk; nothing gates on *understanding* risk. [promptt.dev](https://www.promptt.dev/blog/claude-code-dangerously-skip-permissions) The academic blueprint exists and is engineering-ready. [arXiv 2310.10996](https://arxiv.org/html/2310.10996v1), [arXiv 2507.21285](https://arxiv.org/pdf/2507.21285)
2. **Negative-space verification (doc B's side, unbuilt).** No shipping product captures a pre-change behavioral baseline, enforces a KEEP set at the tool layer, distinguishes verified-unchanged from unchecked, or reports what it could not confirm. The SDD tools write the intent down; the agents run tests if asked; the quality market reviews the PR against generic criteria. Nobody holds execution to the specific approved intent. Building to the Test explains why this must be built with oracle separation from day one. [arXiv 2606.28430](https://arxiv.org/abs/2606.28430)
3. **Attention budgeting (doc A's side, unbuilt, sharpened by doc B).** No tool treats user attention as a resource to be allocated. The market's direction is the opposite: verbose plans, parallel-agent diffs, streaming traces, per-step approvals producing documented reflex approval. Doc B's sharpening is adopted: the objective is not brevity but *information efficiency* — confident decisions per unit of attention (§13).
4. **The non-expert middle (doc A's positioning, retained).** Vibe-coding tools serve non-experts by removing visibility and control; every agent assumes a diff-literate reviewer. The middle — non-expert intent vocabulary *plus* rigorous control *plus* evidence that substitutes for diff literacy — is empty, and doc B's persona analysis (§8) shows why the same product also serves staff engineers in unfamiliar territory.

**Honest convergence threats (merged).** Cursor, Junie, Jules, and Copilot are investing in plan UX; a systematic clarification gate is a quarter's work for any of them. Claude Code hooks and Cline's plugin model let a third party prototype the gate *today* — the concept being buildable as a layer cuts both ways. Spec Kit or Kiro adding runtime enforcement to documents they already ship would compress the verification side. And the code-quality market (Set 3) can move *up* the loop from post-hoc review toward pre-execution intent. The window is real but finite — §26 names it at roughly 18 months, per doc B's competitive-risk assessment.

---

# Part II — Thesis & Model

## 6. Thesis: Intent Lock, KEEP sets, evidence over assertion

The merged thesis, one sentence: **the human states what must be true; the system finds out whether it is — and before any of that, the system establishes whether it actually understood what the human said.**

Doc A's framing survives: the human is a film director, the AI a cinematographer — the human supplies intent in plain language; the system translates intent into a technical interpretation, a plan, scoped changes, and verification, while formally detecting ambiguity before acting, budgeting attention, adapting explanation depth, and gating autonomy on calibrated confidence. Doc B's reframe is grafted on, and it changes the load-bearing member: **intent is not a better prompt; intent is an oracle — and an oracle is the only thing that makes a change cheap to trust.**

The director metaphor turns out to be stronger than either document's marketing, because film solved this exact problem a century ago. Nobody hears "make it feel intimate" as license to recast the lead — the unstated half of intent is the load-bearing half, and on a real set it is written down: continuity notes, the lock on a set dressing, the camera report. Software's AI tools went the other way: they record positive intent in ever more elaborate detail (specs, EARS criteria, task breakdowns) and record the negative space nowhere. An agent told "fix the animation" has no representation of the fact that navigation, state architecture, and package versions were never on the table — and the human has no way to ask afterwards whether they moved.

**The three-part thesis (doc B, adopted):**

1. **What must not change is more checkable than what must.** "Make the preview responsive" cannot be mechanically verified without a definition of responsive. "Export output is byte-identical," "the public API of `ImagePipeline` is unchanged," "no new dependency entered the lockfile" can all be checked in seconds, by a machine, with no judgment. Negative specification is the tractable half, and the field has ignored it.
2. **The baseline must be captured before the edit.** Verification against a post-hoc oracle is worthless — Building to the Test demonstrates agents will satisfy a visible oracle while abandoning the request. The KEEP surface is sampled, pinned, and written to disk *before* the executing agent gets write access, and the executor cannot modify it. [arXiv 2606.28430](https://arxiv.org/abs/2606.28430)
3. **Honest non-verification is a feature, not an admission.** Every change has parts no available check covers. Systems today resolve that silently in their own favor by saying "Done." Code Director resolves it explicitly: "I verified these 9 properties; these 3 I could not check; here is why." This is the entire trust proposition, and it is the one thing competitors are structurally reluctant to copy because it makes their demos look weaker.

**Doc A's three commitments survive as the intent-layer half:**

1. **Human language first.** The user never needs the correct technical vocabulary; vocabulary asymmetry is the system's problem, not the user's.
2. **The seam between Plan and Change is a gate, not a suggestion.** Below a confidence threshold the system *cannot* proceed to code without resolving ambiguity with the human — enforced structurally (tool gating), not requested of the model. The ICML 2025 position paper provides the theoretical license: it names *underspecification uncertainty* as a distinct category that interactive agents must handle by asking follow-ups and expressing uncertainty in language. [ICML 2025 UQ position paper](https://icml.cc/virtual/2025/poster/40147)
3. **Minimum necessary cognitive effort — not minimum words.** The optimization target is the human's next correct decision at the lowest reading cost (§13 sharpens this into an objective function).

**What this makes the product:** not a coding agent — a contract layer *around* a coding agent. Capture intent → gate on ambiguity → compile the approved intent into enforceable boundaries and a pre-change baseline → run any agent inside the boundary → produce a Change Report with evidence classes. The agent underneath is replaceable and assumed commodity. The contract, the baseline corpus, the gate, and the report are the product.

**The 10x insight, stated once (doc B, verbatim in substance):** everyone is racing to make agents produce more change per minute; the binding constraint is how much change a human can afford to trust per minute. Code Director raises the second number — by mechanically discharging most of the reviewer's obligation and honestly naming the remainder. Make the negative space executable.

**Where the metaphor must be dropped (doc B, adopted):** a cinematographer has taste and refusal. An agent has neither, and pretending otherwise is where products invent confident architectural opinions the user cannot evaluate. Code Director's cinematographer is a technically excellent collaborator with no aesthetic authority and no license to improve anything unasked. It proposes mechanisms, reports consequences, and declines to editorialize.

---

## 7. Product principles

Merged set — doc A's 11 principles fused with doc B's 10, deduplicated to 11:

1. **Human intent comes before technical terminology.** The system accepts intent in the user's vocabulary and owns the translation burden. *(Both docs, unchanged.)*
2. **Evidence over assertion.** Never claim a behavioral outcome without naming how it was checked. "I changed the code" and "I verified the behavior" are different sentences with different type signatures. *(Doc B, adopted as the top product principle; doc A's Principle 11 is its negative form, retained as #11.)*
3. **The negative space is the contract.** Every task carries an explicit KEEP set — what must not change — enforced, not encouraged. *(Doc B, adopted.)*
4. **Ask only when the cost of a wrong assumption exceeds the cost of the question.** Clarification is an intervention with a price; the gate decides when it's worth paying. Triggered by computed divergence, never by policy. *(Doc A's ClarifyGPT-sharpened principle + doc B's identical rule; merged.)* [arXiv 2310.10996](https://arxiv.org/html/2310.10996v1)
5. **Uncertainty is typed, not toned.** Confidence is a field with provenance, not an adverb or a formatting style. The system never manufactures confidence because it can generate code. *(Doc B's formulation adopted; grounded in the seed repo's Rule 8 regression.)* [evals/RESULTS.md](https://raw.githubusercontent.com/the seed repository/main/evals/RESULTS.md)
6. **Smallest change that satisfies the intent.** Incidental improvements are reported in a findings list, never performed. Requested, necessary, and protected scope are explicit artifacts; the diff must reconcile against them. *(Both docs; doc B's "incidental = never perform, record and offer" is the sharper version.)*
7. **Make changes understandable and reversible.** Every accepted change is a git-native, revertible unit with a plain-language description. Reversibility before capability: undo is one command and never requires understanding what happened. *(Both docs, merged.)*
8. **Confidence determines autonomy; reversibility and blast radius determine approval.** High intent-confidence → act and report; medium → state interpretation, lightweight confirmation; low → stop and ask. Approval is gated on reversibility and blast radius, not on action type (§19). *(Doc A's axis × doc B's axis; they compose — §12.)*
9. **Attention is a finite resource; optimize confident decisions per unit of it.** Every question, diff, and notification spends from the same budget. The system tracks the spend and degrades gracefully. Evidence discharges cognitive load; verbosity without evidence relocates it. *(Merged — §13.)*
10. **Progressive disclosure with nothing hidden.** Full computation internally; bounded presentation externally; every collapsed layer one interaction away; the raw artifact (stack trace, full diff, test output) always retrievable verbatim. Depth control is a right, not a ration. *(Both docs, merged.)*
11. **Format must not manufacture content.** No output contract may require a field the evidence cannot fill; a claim without an artifact reference is automatically Asserted — enforced by schema, not discipline (§22). Every shaping rule ships with an eval for induced overconfidence. *(Doc A's Principle 11 promoted into doc B's schema enforcement.)*

---

## 8. Personas by verification ability

Doc B's framing is adopted wholesale: **one axis matters more than seniority — can this person independently verify the result?** That determines how much evidence the system must produce.

| Persona | Can express intent | Can verify result | What they need most |
|---|---|---|---|
| Staff engineer, own codebase | Precisely | Yes, but it is expensive | Scope guarantees + fast evidence so they can skip most of the diff |
| Engineer in an unfamiliar service | Roughly | Not reliably | Blast-radius map; "what else touches this" |
| Technical founder / indie dev | In product terms | Behaviorally, by using the app | KEEP enforcement — their real fear is silent regression in what already worked |
| Designer who codes | In feel and appearance | Visually only | Jargon translation + visual/behavioral diffs |
| Student / learner | Partially | No | Explanation on demand; must not be denied the real terms |
| Researcher | In domain terms | By result correctness | Reproducibility; no silent environment drift |
| "Vibe coder" | Loosely | No | Hard boundaries and one-key rollback — the persona most likely to be harmed by an agent with autonomy |

**The design consequence (doc B, adopted as doctrine):** the evidence burden is inversely proportional to the user's verification ability, but the evidence itself is identical for everyone. The system does not produce weaker checks for weaker users — it produces the same Change Report and varies only how much is expanded by default. A staff engineer collapses everything and reads the KEEP violations; a founder expands the behavioral summary. **Same artifact, different disclosure depth. Never build a beginner mode that verifies less.**

Doc A's per-thread adaptive depth (§14) composes with this: disclosure defaults are inferred from demonstrated behavior *per thread*, never from a permanent "beginner/expert" profile — an expert on a tired Tuesday and a beginner on a curious Saturday are the same product. Doc B's customer-priority correction is also adopted (§26): the *paying* first customer is the team already burned by a silent regression, not the vibe coder — the least-equipped personas benefit downstream from a product built for the team that can pay for verification.

---

## 9. Interaction model & core journeys

Merge of doc A §8 (the loop and the artifact conversation) and doc B §13 (journeys A–F, which are the acceptance criteria for the loop).

### The loop

**Open project.** Code Director indexes the repository in the background (symbol map via tree-sitter, git state, test-runner detection — §15) and reports one line: what it sees. No setup wizard.

**Describe intention.** The user states intent in their own vocabulary. Directive phrases ("don't change the layout," "only touch this screen," "just fix it") are parsed as constraints on scope, depth, and process — natural language, never a command syntax the user must learn.

**Understand.** The intent interpreter produces a technical interpretation *plus a confidence level* (§10), using codebase context: which screen, which symbols, what the request concretely refers to here.

**Clarify — only if gated.** Below threshold: the minimum question set, in user vocabulary, with options drawn from real divergent candidate implementations. At or above threshold: the interpretation is stated in one line inside the plan.

**Lock.** The approved intent is compiled into an Intent Lock: goal (user's words + operationalization), KEEP set, DENY set, file/symbol budget, acceptance signal, assumption ledger (§11). The KEEP surface's behavioral baseline is captured *now*, before any edit, outside the writable tree.

**Change.** Scoped, reversible, git-native edits inside the budget; out-of-budget writes are refused at the tool layer and surface as explicit expansion requests.

**Verify.** The ladder (§17) runs in a separate process with no write access: structural checks, existing tests, differential baseline comparison, instrumented measurement where claimed.

**Report.** An evidence-classed Change Report (§14): outcome first, KEEP clauses with check status, what is Asserted, what is Unchecked and why. One next action.

### Conversation model

The conversation is the primary surface, but it is a sequence of *artifacts*, not a chatbot transcript: intent statements, interpretation cards, questions, Locks, plans, Change Reports — each individually addressable (approve, expand, undo, question). Conversation, direct manipulation, and search are complementary interaction models with different attention trade-offs, so the product offers all three rather than forcing everything through chat. [Conversational Programmers, IUI 2023](https://openreview.net/pdf/7013617f3be8846705978cdd8217bfbef22edf9d.pdf) Doc B's correction is also adopted: **refusing chat is a mistake** — users will want to type a question. Chat is one surface onto the Lock, not the product's definition; but removing it entirely is purity that loses users (§26).

**Message anatomy (doc A, retained).** Every system message follows the seed repo's output contract: first line = what happened or what's needed from you; last line = the single next decision; in between, only the budgeted middle. SKILL.md

### The six journeys (doc B §13, adopted; annotated with the intent-layer behaviors doc A adds)

- **A · "The preview feels laggy when I change this setting. Make it feel instant."** Locate via repo map (slider binding → handler → pipeline → render path). Probe ambiguity by generating two candidate mechanisms (debounce the expensive stage vs. split cheap-preview/full-quality) and checking whether they diverge observably — they do, so *one* question is worth asking: "While dragging, should the preview show a fast approximate result, or the real result a moment later?" Lock: GOAL input→paint under 50 ms during drag; KEEP export byte-identical, model unchanged, no new dependency; baseline captured (export hash over 12 fixtures, latency trace of current drag path, API signature). Execute inside the file budget. Verify: latency 340 ms → 22 ms, 12/12 fixtures identical, lockfile empty, API unchanged. Report: "**Measured:** drag latency 340→22 ms; export verified identical on 12 fixtures. **Unchecked:** behavior above 8K source images — no fixture exists." That last line is the product.
- **B · "Fix it."** Resolve the referent from state in priority order (failing test from last run; error in terminal buffer; editor selection; last thing discussed). Exactly one strong candidate → state the resolution and proceed ("Taking 'it' as the failing auth.spec.ts:42"). Two or more compete → ask with the actual candidates as options. Asking "what do you mean?" when the terminal shows one red test is a failure of the system, not the user. *(This is doc A's "when NOT to ask" applied to doc B's journey.)*
- **C · "This API isn't working."** Establish which API, then which meaning of "not working" — wrong result, error, or nothing happens have disjoint diagnostic paths. Reproduce before theorizing; if it cannot be reproduced, say so instead of proposing a fix — a fix for an unreproduced failure is a guess with a confident tone, the exact Rule-8 regression the seed repo documented. [evals/RESULTS.md](https://raw.githubusercontent.com/the seed repository/main/evals/RESULTS.md)
- **D · "Do it like the other screen."** Extract the implicit pattern, then decide *which properties transfer* — layout? state handling? naming? error presentation? Diff the two screens structurally, present the extracted pattern as an explicit short list, let the human strike items. Silent pattern inference across files is one of the highest-regret operations an agent performs.
- **E · "Make this faster."** Refuse to proceed on an unmeasured claim — politely and briefly. The system proposes the measurement itself: "I'll time the drag path and the export path and show you both; then we optimize whichever you meant." Establishing the baseline is the first unit of work, and it doubles as the verification oracle — the journey where the architecture pays for itself most obviously.
- **F · "The screen feels too busy. Simplify it without removing anything important."** Pure judgment, no mechanical oracle — the honest hard case. "Important" is undefined and only the human holds it. Inventory what's on screen, group into candidates for removal/consolidation/demotion, ask the human to mark what is load-bearing. The marked set becomes the KEEP list. **The system converts a taste question into an invariant, and does not pretend to have taste.**

---

## 10. Ambiguity system

Doc B's §14 is adopted as the frame — it is excellent, and per the ruling it is framed as evidence the input gap is **not** closed — enriched with doc A §9's confidence model and when-not-to-ask discipline.

### Taxonomy (merged: doc B's six types, mapped to doc A's five axes)

| Type (doc B) | Example | Resolution | Doc A axis |
|---|---|---|---|
| Referential | "Fix it" | Resolve from state; ask only on a genuine tie | Referential |
| Behavioral | "Make it faster" — which path? | Measure; the data usually decides | Qualitative |
| Mechanistic | Debounce vs. split pipeline | Ask — only if observably different to the user | Qualitative/behavioral |
| Boundary | Does "fix the animation" include the navigation glitch? | Ask — this is a KEEP-set question, the highest-value kind | Scope |
| Criterial | "Simplify" — what is important? | Ask — only the human holds it | Acceptance |
| Latent conflict | Request contradicts the Constitution | Surface both; do not choose | Scope/behavioral |

### Detection, not assumption

Layered, cheap-first (merged):

1. **Lexical/structural flags.** Vague quantifiers, missing referents, affect words ("feel," "better"), absent constraints. Near-free heuristics. *(doc A)*
2. **Behavioral divergence, generalized from code to plans** *(doc B's generalization of doc A's ClarifyGPT mechanism)*: generate two or more candidate implementation strategies, then test whether they diverge in any user-observable property — output, timing, API surface, files touched, persisted state. **Convergent candidates mean the ambiguity does not matter; proceed silently.** Divergent candidates define the question, and the divergence *is* the answer options — questions are automatically concrete because they are generated from real alternatives, not from a template. [arXiv 2310.10996](https://arxiv.org/html/2310.10996v1)
3. **Intent-clarity classifier.** Darji & Lutellier's trained classifier + fine-tuned question generator was preferred over baseline in ~78–82% of ratings. Start with prompting + consistency check; fine-tune only with logged production data. [arXiv 2507.21285](https://arxiv.org/pdf/2507.21285)

The theoretical frame is Horvitz's mixed-initiative model (CHI '99, per doc B): act autonomously only when expected value exceeds inaction; use dialog to resolve key uncertainties while weighing the cost of bothering the user; consider the user's attentional state. A clarifying question has a real cost and must clear an expected-value bar.

### The asking bar (doc B, adopted)

Ask when expected cost of guessing wrong × probability of guessing wrong exceeds the interruption cost. Concretely: ask if a wrong guess would be expensive to undo (touches persisted data, public API, or many files), or if the candidates differ in something the user will notice. Do not ask when the guess is cheap to reverse — make the reversible choice, state it in one line, and move: "Assuming you meant the drag path, not export — say so if not."

### Confidence model (doc A, retained with defined gate behaviors)

| Confidence | Meaning | Behavior |
|---|---|---|
| **High** | Interpretation unambiguous given context; candidate alternatives converge | Proceed; state the interpretation in one line inside the plan |
| **Medium** | A dominant interpretation exists but a plausible rival survives | State it; proceed with lightweight confirmation, or one question if the divergence is behavior-changing |
| **Low** | Two or more fundamentally different interpretations, or a protected-scope conflict | Block coding; ask the minimum question set, with options, in user vocabulary |

Calibration is the hard part and is treated as research-grade: token-entropy and self-consistency signals are usable today, but calibrated, user-actionable "should I ask the human?" confidence is an open problem — the 2025 review of 22 UQ benchmarks found most ecologically invalid. [arXiv 2506.07461](https://arxiv.org/html/2506.07461v1) Consequence: ship the gate with heuristic confidence, instrument it, and let the eval harness decide when the classifier earns more autonomy.

### Question format (merged)

Maximum one question per turn *(doc B)* — batched, never drip-fed: if several questions block, one message, all of them *(doc A)*. These reconcile: one *interruption* per turn, containing the minimum question set, each question with two to four concrete options drawn from real divergence, recommended first, each a single line in the user's vocabulary, options phrased in outcomes not mechanisms. Always an implicit fifth option: "just pick one." Free text always available. Never a request for specifications; never a question whose answer the repository already contains. Question count per task capped — ClarifyGPT's ~2.85 average is the right order of magnitude. [arXiv 2310.10996](https://arxiv.org/html/2310.10996v1)

### When NOT to ask (doc A, retained)

ClarifyGPT's always-ask failure is a hard constraint, and ClarifyCodeBench adds that clarification quality degrades as ambiguity count grows — so the system must *triage* ambiguities rather than enumerate them. [arXiv 2607.00711](https://arxivtldr.org/abs/2607.00711) Don't ask when: the ambiguity is referential and context resolves it; the interpretations produce identical user-visible behavior; a reversible low-stakes default exists and rollback is one click; or the user has said "just fix it" (an explicit autonomy grant). Which of several ambiguities deserves a scarce attention unit — question prioritization under an attention budget — is research-open; Code Director's answer is heuristic ranking (behavioral impact × irreversibility × confidence spread), validated by evals.

---

## 11. Intent model & the Intent Lock

Doc B §§15–16, adopted; this is the merge's structural spine.

### The layered intent model

Four layers, deliberately separated because they have different lifetimes and different authorities:

| Layer | Content | Authority / volatility |
|---|---|---|
| **1 · Utterance** | The human's exact words | Immutable; never rewritten; shown alongside every derived artifact |
| **2 · Intent** | Goal + KEEP + DENY + acceptance signal | Human-approved; survives across attempts |
| **3 · Plan** | Mechanisms, file budget, steps | Disposable — rewritten freely on failure |
| **4 · Diff** | Actual edits | Evidence, not intent |

Authority decreases down the table; volatility increases. A failed attempt discards layers 3–4 and never touches 1–2. The separation is what makes iteration cheap: when an approach fails, today's tools lose the thread — the original ask is 40 messages up and the user re-explains. Here, "that didn't work, try something else" costs one turn and zero re-specification, because intent is stable under changes of implementation ("intimate" survives a lens change; "preview feels instant" survives swapping debounce for a cancellation token). The artifact that persists is the intent plus constraints — not the plan.

Intent is recorded **in the user's own vocabulary with a translation attached, never substituted**: "feels instant" stays as written; the operationalization ("input-to-paint < 50 ms during drag") sits beside it, labeled as the system's interpretation and editable in one click. Mistranslation becomes visible — the failure that silently sinks most intent-capture systems.

### The Intent Lock

Not a document — a compiled, enforced, verified contract. Concepts named "constitution," "spec," and "steering file" already exist and are all prose (§4). The Lock differs in exactly one way that matters: **every line of it is either enforced at tool-call time or checked against a pre-captured baseline. A clause that can be neither is not admitted to the Lock; it goes in the notes.**

```
Intent Lock · IL-0147 · photo-preview-latency · status: verified

Said    "the preview feels laggy when I drag the intensity slider —
         make it feel instant, but don't make the AI run on every tiny movement"
Goal    input→paint under 50ms during drag            (interpretation — edit)
Keep    ✓ export output byte-identical · 12/12 fixtures
        ✓ ImagePipeline public API unchanged · signature hash match
        ✓ no new runtime dependency · lockfile diff empty
        ✓ 47 characterization tests · all pass
        ? behavior above 8K source · no fixture
Change  preview responsiveness during drag only
Do not  ✗ touch the inference model or its weights
        ✗ alter navigation or view hierarchy
        ✗ modify Export/, Models/
Budget  3 files · PreviewView.swift, ImagePipeline.swift, SliderBinding.swift
Accept  drag latency p95 < 50ms · measured, was 340ms · now 22ms
Assumed "instant" = perceptual, not literal · approximate preview during
        drag is acceptable (confirmed by user, turn 2)
```

### How each clause becomes machine-checkable

| Clause form | Compiles to | Checked |
|---|---|---|
| Output unchanged | Characterization test over fixtures; content hash | Differentially, pre vs post |
| API unchanged | Symbol signature extraction (tree-sitter) → hash | Structural diff |
| No new dependency | Lockfile / manifest diff | Exact |
| Files out of bounds | Tool-call interception — edit outside budget is refused | At write time, before damage |
| Behavior X preserved | Generated characterization tests over the KEEP surface | Differentially |
| Performance target | Instrumented trace, pre and post, same harness | Measured, with variance |
| "Feels right" | **Not admissible** | Goes to notes; the human judges |

### The rule that gives it teeth

If satisfying GOAL requires violating a KEEP clause, execution **halts** — it does not negotiate with itself. The system reports: what it tried, which clause blocks it, why the clause and the goal are incompatible, and what a relaxation would cost. The human relaxes the clause explicitly or abandons the task. **An agent that can talk itself out of a constraint does not have constraints.** This is the single most important behavior in the product and the hardest to hold, because the model will always be able to produce a persuasive argument for the exception.

### Honest positioning

Intent Lock is not a new idea *as a document*: Kiro's EARS acceptance criteria are formally rigorous; Spec Kit's constitution occupies the same conceptual slot and the same name. [Martin Fowler SDD survey](https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html), [Augment Code: Kiro](https://www.augmentcode.com/tools/kiro-vs-augment-code) The novelty is entirely in **compilation and enforcement**: the KEEP set becomes a pre-captured baseline and a tool-call boundary rather than a paragraph in the system prompt. The assumption ledger (the `Assumed` block) follows AssumptionMiner's design — implicit assumptions emitted as a structured, reviewable artifact alongside code (cited in doc B; treat as reported).

---

## 12. Scope control

Merged: doc A's three zones reconciled with doc B's three categories (same structure, sharper policy names), plus doc B's enforcement refinements.

| Category | Definition | Policy | Mechanism |
|---|---|---|---|
| **Requested** | What the human asked for | Do it | Goal clause |
| **Necessary** *(doc A: "inferred")* | Required for the requested change to work | Do it; name it in the plan | Declared in file/symbol budget before execution |
| **Incidental** | Nearby, improvable, not required | **Never perform. Record and offer.** | Findings list in the Change Report |
| **Protected** *(doc A)* | Explicit user restrictions; architectural boundaries; convention-sensitive areas (public APIs, migrations, generated files) | Treat as DENY | Compiled into the Lock; enforced at tool layer |

The contract is an artifact the change controller enforces structurally — tool gating on file paths and edit types — not a prompt instruction. A proposed edit outside requested + necessary scope blocks and escalates. This formalizes what Cline's 2026 discussion was still only proposing. [Cline discussion #12959](https://github.com/cline/cline/discussions/12959) The enforcement primitive already exists as a community hack — PreToolUse hooks intercepting edits outside a planned file list — and is productized here. (Doc B's field claim that scope rules cut unrelated changes in one-line-ask PRs from ~35% to 4% is directional motivation only: **reported, unverified**.)

**Two refinements beyond path-level blocking (doc B, adopted):**

- **Symbol-level budgets.** "May modify `PreviewView.body` and `ImagePipeline.render`" is far tighter than file-level, and tree-sitter makes it cheap to enforce. Prevents the common case where an agent legitimately inside a file rewrites a neighboring function while there.
- **Change budget as a declared magnitude.** The plan states expected size ("~3 files, ~60 lines"); exceeding it by a wide margin triggers a checkpoint rather than silent continuation. A 40-line task that produced a 600-line diff has almost always misunderstood something, and the earlier that surfaces the cheaper it is.

**Expansion is always available and always explicit:** "This needs a change in `Export/Encoder.swift`, which is outside the budget and inside your DO-NOT list. Here is why. Allow?" The point is not to prevent scope growth — it is to make scope growth **a decision with a timestamp and an author**. Every override is logged (§19).

**Approval tiers compose the two axes (merged doctrine).** Doc A's axis: intent confidence (low-confidence intent lowers the autonomy ceiling even for low-risk actions). Doc B's axis: reversibility and blast radius (approval gated on these, not on action type). The merged matrix: an action needs approval when *either* intent confidence is below threshold *or* the action is irreversible / external-side-effecting / outside the declared budget. A low-risk edit inside budget at high intent confidence needs none — the checkpoint is the safety. Destructive-action confirmation is an inviolable override — safety outranks brevity, per the seed repo's escape-hatch hierarchy. SKILL.md

**Circuit breakers for debug spirals (doc A, retained; doc B's hardening adopted).** The seed repo's best idea — three turns of "still broken" → stop, name the doubtful assumption, ask one diagnostic question — generalizes into the execution controller as a **hard limit**: bounded repair attempts per failure, automatic rollback when the budget is exhausted, escalation to the human with the doubtful assumption stated in plain language. Unbounded self-correction is how a 40-line task becomes a 600-line diff, and agentic repair loops are expensive (SWE-Search's MCTS approach reaches 31–39% on SWE-bench Lite at high cost). SKILL.md, [APR survey](https://arxiv.org/html/2506.23749v1)

---

## 13. Attention & information efficiency

Merged: doc A's attention-budget model is the accounting system; doc B's information-efficiency objective is the loss function it optimizes.

**The objective function (doc B, adopted as the product's north star):**

> **confident decisions the human can make ÷ attention spent**

By that measure a Change Report with 40 verified properties is more efficient than a two-sentence summary, despite being longer, because it discharges an obligation the summary leaves outstanding. Conversely, an explanation of debouncing offered to a user who did not ask is pure cost. **The test is not length — it is whether the text removes a question the human would otherwise have to answer themselves.** This is the resolution of the doc A/doc B tension (evidence over brevity vs. minimum cognitive effort): evidence discharges cognitive load, but a 40-claim report is itself an attention cost — so the objective function, not either principle alone, decides. Evidence scales with consequence (a one-line CSS change gets one line; a migration gets the full ladder); explanation is pull, not push; and everything the user might need is one interaction away, never regenerated.

**What costs attention (doc A's price list, retained):** *reading* (words on screen, weighted by jargon density and by whether the reader must reconstruct state); *deciding* (every question, approval, or choice — the most expensive unit; verifying system-initiated output costs significant user effort and poorly timed proactivity harms workflow [arXiv 2502.18658](https://arxiv.org/html/2502.18658v3)); *context switching* (notifications, mid-task interruptions); *working memory* (anything the user must hold while reading something else — off-screen state is forgotten). SKILL.md

**How responses are budgeted (doc A, retained).** Before sending, each candidate message is scored on necessity: *what is the minimum information this person needs to make the next correct decision?* Anything not serving the next decision is deferred into an expandable layer. Accounting runs per session — questions asked, decisions requested, words shown, approvals demanded — and as spend accumulates the system degrades gracefully: batching remaining questions, lowering explanation defaults, consolidating status into a single line. This is the dynamic generalization of the seed repo's static 5-item cap, whose internal/external split (cap presentation, never analysis) is the seed of the whole model. SKILL.md rule 9

**Interruption cost (merged).** An interruption is worth its price only when the expected cost of proceeding without the answer (wrong assumption × irreversibility × rework) exceeds the interruption cost. This is the same inequality as the clarification gate (§10) viewed from the user's side — one mechanism, two faces — and it is also Horvitz's expected-value bar for mixed-initiative interaction, which doc B correctly identifies as the formal basis.

**Why this is product behavior, not taste (doc A's three findings, retained):** (1) moderate AI output helps and excessive output erodes the benefit — metering is empirically supported [arXiv 2512.19926](https://arxiv.org/pdf/2512.19926); (2) users cannot perceive their own review overhead — METR's 19%-slower-while-feeling-faster gap means the budget must be enforced by the system, not self-regulated [METR RCT](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/); (3) context rot shows attention budgeting applies to the *model* too — small curated context is a correctness feature for the machine as much as the human. [Chroma context rot](https://upsolve.ai/blog/context-rot)

**Approval fatigue is the failure mode, not under-approval (doc B, adopted).** A tool that asks for confirmation on everything trains reflex approval — Cline's documented failure mode — which is worse than no approval. Hence: approve intent **once** (at the Lock) rather than approving steps many times; gate on reversibility and blast radius; and audit the budget against decision-count, not just word-count. [Qodo on Cline](https://www.qodo.ai/blog/roo-code-vs-cline/)

**Honest caveat (doc A, retained).** The *direction* is supported by evidence; the *specific policy* (budget numbers, decay curves) has no literature to copy and must be tuned by product telemetry and the eval harness.

---

## 14. Human-readable communication

Merged: doc A's depth-as-dimension design + doc B's evidence classes as report content + the jargon rules + the format-must-not-manufacture-content rule.

**Depth as a per-message dimension, not a ladder (doc A, retained).** Every substantive message is a complete, self-sufficient statement at its shallowest level, with two orthogonal controls:

- **Deeper** (progressive disclosure): outcome → what changed → technical explanation → full detail (diffs, traces, reasoning). Each level reachable in one gesture and independently readable — Level 1 never requires reading Level 4. The pre-send check enforces the invariant mechanically. SKILL.md
- **Plain-er** (register shift): the same level re-expressed without jargon — "put the AI model behind a small interface so we can replace it later without rewriting the app" instead of "introduce an abstraction layer between the inference backend and the image pipeline." Same idea, less mental effort.

Depth defaults are inferred from demonstrated behavior *per thread* — never from a permanent expertise profile (§8). IntelliExplain found proactive explanations of code structure and intent improved understanding and correct usage for non-professional programmers; in-situ, on-demand, anchored explanations work. [arXiv 2405.10250](https://arxiv.org/html/2405.10250v3)

**The Change Report is the flagship artifact, and its content is typed (doc B, adopted).** Every claim carries exactly one evidence class:

| Class | Means | Produced by |
|---|---|---|
| **Measured** | Observed differentially, pre and post, same harness | Characterization tests, traces, output hashes, perf samples |
| **Proven** | Structurally guaranteed, no execution needed | Type check, signature diff, lockfile diff, exhaustiveness |
| **Asserted** | Believed on the model's reading of the code | Model reasoning — always labeled as such |
| **Unchecked** | No check exists or none could run | Named explicitly, with the reason |

The Unchecked bucket must never be empty when it should not be. A report claiming full verification of a UI change on a platform with no UI test harness is lying, and one instance destroys the trust the whole product trades on. The system is conservative to the point of appearing pessimistic: anything not differentially observed is Asserted at best. **A claim without an artifact reference is automatically Asserted — enforced by schema, not discipline (§22). If it is not representable in the type, it cannot be overstated in the prose.**

**Jargon translation rules (doc B §18, adopted):** (1) lead with consequence, not mechanism; (2) **never delete the real term** — the user is trying to learn the codebase, not be protected from it; the correct word is used and made inspectable (hover/click/footnote with a two-line plain definition), because withholding vocabulary keeps users dependent, which is bad ethics and bad retention; (3) translate error output, keep the original one click away — the raw trace is not information to a user who cannot read it.

**Error-dump signal extraction (doc A, retained).** Large error input (pasted logs, build output, test failures) is processed fully internally; the message surfaces only the extracted signal — "I found the problem. One of your photo files has a name with a space in it, and the build step that copies it isn't expecting that." — with the raw log and full reasoning one click down. Errors are reported matter-of-factly: what happened, what it means, what the options are, what the system recommends. No alarm styling, no blame framing, no apologetic padding.

**The fabricated-confidence rule — the merge's most important communication constraint (both docs, reinforced).** The seed repo's own evals caught its error-format rule pressuring the model to assert "missing auth header" as definitive without evidence. [evals/RESULTS.md](https://raw.githubusercontent.com/the seed repository/main/evals/RESULTS.md) Generalized (doc B): a response format that requires certainty will manufacture certainty; every template slot is explicitly droppable, and evals test that it actually gets dropped. Concretely: every causal claim in an error summary carries its evidence state ("The log shows X, which usually means Y" vs. "Y is the cause"); unverified hypotheses are labeled; and uncertainty is represented as an **evidence class, never as hedging language** — "Asserted, not measured" is precise; "might possibly" is noise.

**What to borrow verbatim from the seed repo (doc A, retained):** no preamble, no recap, no closing pleasantries; suppress tangents; restate state each turn; specific time estimates where duration matters; completed work made visible — all adapted for execution-by-proxy: the user decides, the system does; every "run this command" becomes "I've run this; here's what happened." SKILL.md

---

# Part III — Architecture

## 15. Context selection & repository intelligence

Merged: doc A §11's build/defer analysis + doc B §§19–20's safety framing and layer split.

**Context selection is a safety mechanism, not just a cost/accuracy concern (doc B, adopted as the section's lead).** Every file in context is a file the agent might edit. Tight context is the first line of scope control, before any enforcement fires. Irrelevant context does not merely waste tokens — it actively degrades retrieval (context rot: all 18 frontier models tested degrade as input grows, with coherent-but-irrelevant context hurting *more* than shuffled) and invites the model to "improve" code it should never have seen. [Chroma context-rot study](https://upsolve.ai/blog/context-rot) Anthropic's framing is the policy: the smallest set of high-signal tokens. "The model saw everything" is not a defensible answer to "why did it change that?"

**The four-stage funnel (doc B, adopted):**

1. **Anchor.** Resolve the request to seed symbols — from the editor selection, the failing test, the stack frame, the terminal error, or lexical matches on nouns in the request. Anchors are cheap and high-precision; most requests have one.
2. **Expand.** Personalized PageRank over a tree-sitter symbol graph, restart vector biased to the anchors (Aider's method, the right default). Pull in definitions, direct callers, and the types crossing the boundary — skeletons first (signatures, docstrings), bodies only for the top-ranked few. [Aider](https://github.com/Aider-AI/aider)
3. **Constrain.** Intersect with the Constitution's ownership rules and the Lock's DENY list. Files the task is forbidden to touch are excluded from context entirely unless needed read-only for comprehension — in which case they are marked read-only in the tool layer too.
4. **Budget.** Pack to an explicit token budget, ranked, with the ranking shown to the user on request. If the budget cannot hold the plausible working set, say so and narrow the task rather than silently truncating.

**Two discipline rules that matter more than the algorithm (doc B):** never dump a whole file when a skeleton suffices; and show the context selection — a one-line "read 6 files, ranked by call proximity to `SliderBinding`" is a cheap, powerful trust signal the user can correct in one word.

**Repository intelligence, split by cost and volatility (doc B's layer table, merged with doc A's ecosystem choices):**

| Layer | Content | Strategy | Freshness |
|---|---|---|---|
| Structural | Files, symbols, signatures, imports, call edges | tree-sitter (MIT, verified) parse → persisted graph | Incremental, content-hash (merkle) invalidated |
| Build | Targets, module boundaries, test mapping, entry points | Parse build files; cache | On manifest change |
| Conventions | Naming, layering, error-handling patterns, test style | Mined + human-confirmed → Constitution | Explicit, versioned, never silent |
| Behavioral | Characterization baselines, perf traces, output fixtures | Captured per Lock, retained | Per task; accumulates into the corpus (§26) |
| Historical | Churn, co-change coupling, past regressions, blame density | Derived from git on demand | Recomputed; never stale |
| Semantic | Embeddings for fuzzy queries | **Phase 2, only if structural fails** | — |

Compiler-grade truth (precise defs/refs/diagnostics) comes from wrapping LSP servers as agent tools per the Serena pattern (rust-analyzer MIT/Apache-2.0, pyright MIT, verified) — do not build code intelligence from scratch. [LSP spec](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/), [Serena pattern](https://github.com/cskwork/serena-mcp-quickstart) grep/BM25 keyword retrieval is the baseline; hybrid retrieval beats any single method, but the MVP starts here. [graph-vs-vector RAG analysis](https://zzet.org/gortex/graph-rag-vs-vector-rag-for-code/)

**Defer-embeddings is a real recommendation, not caution (both docs agree).** Cursor's published pipeline (server-side embedding, Merkle tree of file hashes, content-addressed chunk cache, remote vector store at 1T+-vector scale) answers a scale problem the MVP doesn't have; Cursor claims ~12.5% accuracy gain over grep alone — real but modest. Embeddings capture similarity, not relationships; they go stale on edit. Add local embeddings (LanceDB, Apache-2.0, verified) only when evals show retrieval misses. Deferring is also a privacy decision (§21): no vector index means no code corpus on a third-party service. [Cursor indexing](https://zzet.org/gortex/how-cursor-indexes-codebase-embeddings-vs-graph/), [LanceDB](https://github.com/lancedb/lancedb)

**Blast radius deserves first-class treatment (doc B, adopted):** given a proposed change to symbol S, what could observably move? Transitive reverse call edges, plus historical co-change coupling from git, plus which tests cover it. This is what a senior engineer knows and a newcomer does not, and it is computable. It is also the input that makes the KEEP set **proposable by the system** rather than composed by the user — which is what makes the Lock usable by someone who could not have written it.

**What remains unsolved (doc A, retained):** faithful *semantic* understanding of why code is the way it is — bug history, ABI promises, invariants — is research-open; maintainers report AI PRs systematically miss this implicit context. [maintainer analysis](https://dailycodesolutions.com/blog/for-open-source-programs-ai-coding-tools-are-a-mixed-blessing/) Code Director's answer is not to pretend otherwise: protected scope and human confirmation exist precisely where the system's model of the project is known to be shallow.

---

## 16. Planning & execution

Merged: doc B §§21–22 (phases as permission states; oracle separation; the execution loop) + doc A §12/§16 (wrapped agent loop, git spine, sandboxing tiers).

**Planning.** Plan-before-act is table stakes (Cline, Claude Code, Spec Kit, Kiro). Three things differentiate planning here: (1) **the plan declares its own boundary** — files and symbols it may touch and expected magnitude; this compiles into the execution sandbox, and a plan that does not constrain execution is a paragraph; (2) **mechanisms carry blast radius and reversibility**, not just descriptions — what each step changes, what could observably move, how hard to undo: exactly the information a non-expert needs to approve, and exactly what current plan surfaces omit; (3) **plans are cheap and disposable; Locks are not** — re-planning after failure costs the user nothing because intent lives a layer up (§11). Smallest viable change is enforced by a **plan critic**: a separate critique pass (cheap model, different prompt — a model asked to critique a plan it did not write catches unnecessary steps reliably) asks one question: is any step unnecessary for the stated goal? Steps that fail move to the findings list. This is where "add an abstraction layer while we're here" gets caught.

**Phases are permission states, not prompt sections (doc B, adopted).** Cline's Plan/Act works because plan mode cannot write — the tool set differs. Phases here likewise map to capability sets: Observe has read + search; Plan adds baseline capture; Execute adds write, restricted to the budget; Verify has execute-tests but no write. A phase boundary that exists only as a heading in the system prompt will be crossed.

**Oracle separation (doc B, adopted as a hard architectural invariant).** This falls directly out of Building to the Test: if the verifying process can edit code or tests, it will eventually make the check pass rather than make the behavior correct — not from malice but because that is the shortest path to the objective it was given. [arXiv 2606.28430](https://arxiv.org/abs/2606.28430) Structurally: the baseline is captured before execution, stored outside the writable tree, content-addressed; the verification runner is a distinct process with a read-only mount of the test corpus; any modification to a baseline file during execution invalidates the run.

**The execution loop (doc B §22, adopted):**

```
1 · Checkpoint — git ref before any edit. Free rollback.
2 · Baseline   — capture KEEP surface. Outside writable tree. Executor cannot touch it. (no write access)
3 · Edit       — inside file/symbol budget. Out-of-bounds write refused at tool layer. (the only write phase)
4 · Build      — compile/typecheck. Failure loops to 3 with the error, bounded attempts.
5 · Differential — re-run baseline. Compare. (no write access)
6 · Report     — Measured / Proven / Asserted / Unchecked, with evidence per claim.
```

Bounded retries with a mandatory escape: after N failed build/fix cycles, stop and report the impasse with the actual error rather than continuing to edit — the debug-spiral circuit breaker as a hard limit (§12).

**Supporting machinery (doc A, retained):**

- **Git-native rollback.** Git is the spine: clean tree or auto-snapshot before agent turns; one commit per accepted change-batch with a structured message (intent, scope, confidence, evidence classes); rollback = revert to checkpoint, conversation-aware like Claude Code's `/rewind`. Documented honestly: rollback cannot undo external side effects (installs, pushes, API calls) — those are approval-gated. Known sharp edges handled: dirty-tree conflicts on interrupted sessions, untracked files, the developer's own uncommitted work mixing with agent work (snapshot captures both). [Claude Code rewind analysis](https://www.mindstudio.ai/blog/claude-code-rewind-command-rollback), [claude-code issue #6001](https://github.com/anthropics/claude-code/issues/6001)
- **The coding agent is a wrapped commodity.** mini-swe-agent-style minimal loop (~100-line harness, also the harness used in SWE-bench Pro Verified evaluations) or a wrapped OpenHands runtime. Do not build a novel agent framework — that race is lost and it is not the differentiator. [SWE-agent](https://github.com/SWE-agent/SWE-agent), [SWE-bench Pro](https://arxiv.org/html/2609.08149v1)
- **Sandboxing tiers.** MVP: macOS Seatbelt profile + command approval tiers on desktop (zero-dependency; the same approach Claude Code ships); hardened Docker for headless (default seccomp, cap-drop, no-new-privileges, network off). gVisor/Firecracker only for untrusted multi-tenant workloads. Two gaps persist at every tier: network egress is an exfiltration channel; writable mounts are a code-modification channel. CVE-2025-59532 (Codex sandbox bypass via crafted cwd) stands as the permanent reminder: sandboxes reduce blast radius; they do not eliminate it. [sandboxing tiers](https://www.digitalapplied.com/blog/ai-agent-sandboxing-isolation-patterns-2026), [Seatbelt guide](https://alejandromp.com/development/blog/sandboxing-an-ai-harness-on-macos), [SentinelOne CVE](https://www.sentinelone.com/vulnerability-database/cve-2025-59532/)
- **Model abstraction.** Per-component model choice (expensive planner, cheap editor — Aider's architect-mode split; Cline's per-mode selection is the right precedent and should be user-configurable). Specialization is justified only where structurally required, and there are exactly three places (doc B): the **executor** (strongest available); the **plan critic** (must not have written the plan it critiques — self-review is weak review); and the **verifier** (must not have write access — a security boundary, not an optimization). Intent interpretation, retrieval ranking, and explanation share one model with different prompts; ranking is not a model job at all — it is PageRank. Resist multi-agent architecture for its own sake: it multiplies failure modes, and most "specialist agent" designs are one model with different prompts wearing hats. [Aider architect mode](https://www.promptlayer.com/glossary/aider-architect-mode/)

---

## 17. Verification

The core of the product (doc B §23, adopted; doc A's test-in-the-loop machinery folded in). The design requirement is not "run more checks" — it is to never again conflate "I edited a file" with "I confirmed a behavior," and to make the difference visible in the type system, not the prose.

**Evidence classes** (defined in §14): Measured / Proven / Asserted / Unchecked. The Unchecked bucket is the differentiator and the product's signature; conservatism is policy — anything not differentially observed is Asserted at best.

**The verification ladder** — ordered by cost and by strength, applied as far as the repository and time budget permit:

1. **Structural** — compiles, typechecks, lints, signatures unchanged, lockfile unchanged. Seconds. Always runs. *(In the MVP this plus (2) is most of the evidence base.)*
2. **Existing tests** — the repo's own suite, scoped to blast radius first, then full. Real but incomplete, and its coverage of the KEEP surface is usually unknown. Doc A's adapter: language-detecting test-runner integration (detect project type → run → parse JUnit/JSON → classify fail-to-pass vs. pass-to-pass), exposed as an MCP tool; green tests raise effective autonomy, red tests trigger bounded repair then rollback — never silent scope expansion. [APR survey](https://arxiv.org/html/2506.23749v1) Watch for flaky tests (quarantine + retry budgets); use the symbol graph for test selection on long suites.
3. **Characterization baseline** — the key addition and the hard problem. Auto-generate tests that pin current behavior over the KEEP surface *before* the change, without needing anyone to specify what correct is; re-run after. This is the only mechanism that verifies "nothing else moved" for code nobody wrote tests for — which is most code. Snapshot/approval-testing ecosystems are the mature substrate (approvaltests, jest snapshots, insta). **Phase 1.5, not MVP — see §24.**
4. **Differential execution** — same inputs through old and new code paths, compare outputs. Strongest available evidence for pure-ish functions and pipelines.
5. **Instrumented measurement** — latency traces, memory, render timing. Required for any performance claim, **with variance reported, never a single sample.**
6. **Visual / interaction** — screenshot and interaction-trace diffs. Expensive and flaky; reserve for explicit UI KEEP clauses. *(Not in MVP; doc B's "no visual regression testing" ruling stands for MVP and phase 2 alike unless evals demand it.)*

**Characterization generation is where the engineering risk concentrates (doc B, adopted; the reason it is not in the MVP).** Generating tests that pin current behavior is easy to do badly: tests that are trivially true verify nothing; tests over non-deterministic surfaces (time, network, randomness, ordering) are flaky and destroy trust faster than no tests; tests too tight fail on legitimate intended change and train users to ignore them. Mitigations: prefer pure boundaries identified structurally; require each generated test to **demonstrably fail under a mutation of the code it covers** before admission to the baseline (a mutation-testing gate on our own oracle — a mutation tool per ecosystem, validating our baselines, not the user's code); **quarantine any test non-deterministic across two pre-change runs**. A characterization suite that has not been shown to detect change is decoration.

**Weak-test verification theater is a named risk (doc A, retained).** Where test coverage is thin, "verified" is a claim the system cannot back; repo-level repair with weak tests is research-open. Verification confidence is stated explicitly, never implied. [APR survey](https://arxiv.org/html/2506.23749v1)

**The honest limit on perceptual intent (doc B, adopted verbatim in substance).** The flagship example — "the preview feels laggy, make it feel instant" — is the case where this thesis is weakest, and that is not glossed over. "Feels instant" is perceptual. What is mechanically verifiable is input-to-paint latency, which is a *proxy*: a p95 of 22 ms does not prove the interaction feels good, and a user can reject a change that passes every check. The resolution is not to claim more than is true. It is to **verify the proxy, verify that nothing else moved, and hand the human a fast path to judge the feel** — because judging feel takes them four seconds and is the one thing they are better at than the machine. The system's job is to make everything except the taste judgment free.

---

## 18. Constitution & memory

Doc B §24, adopted, with doc A's state-store requirement merged in.

**Start with the correction (per ruling):** this concept exists, under this name. Spec Kit ships `constitution.md` and `/speckit-constitution`; Kiro ships steering files (product.md, tech.md, structure.md); AGENTS.md is a Linux Foundation format read by 30+ tools across 60k+ repositories. [Martin Fowler SDD survey](https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html), [Glukhov comparison](https://www.glukhov.org/ai-devtools/ai-coding-assistants/spec-kit-vs-kiro-vs-claude-code/) Code Director adopts **AGENTS.md as the substrate** rather than inventing a ninth competing file — portability is worth more than ownership, and a proprietary format is a migration tax users notice immediately.

**The differentiation is enforcement, and one structural idea: split memory by whether it is verifiable.**

| Store | Contains | Written by | Enforced? |
|---|---|---|---|
| **Constitution** (versioned, in-repo) | Durable rules: use SwiftUI; no third-party deps without approval; preserve navigation; prefer simple over abstract | **Human only.** The system may propose a diff; it never self-writes | Yes — compiled into DENY defaults and plan critique |
| **Behavioral corpus** | Characterization baselines, traces, fixtures from past Locks | System, mechanically | Yes — it *is* the enforcement |
| **Decision log** | Rejected approaches with reasons; past Locks; what broke last time | System, append-only | Advisory — surfaced as context, never binding |
| **Preferences** | Disclosure depth, question tolerance, verbosity | System, observed | No — presentation only |

**Only the human writes the binding store.** The system may say "I have seen this pattern three times — add to the Constitution?" and produce a one-line diff, but it cannot promote an observation into a rule. Everything the system writes autonomously is either mechanical evidence (self-correcting — re-run it) or advisory (cannot bind behavior). There is no path by which an inferred assumption becomes an enforced constraint without a human commit. This answers doc A's worry about memory silently accumulating wrong beliefs.

**Memory that cannot be inspected cannot be corrected.** Everything durable is a file in the repository, in a readable format, in version control, with the ordinary review workflow around it. If the user opens a PR and sees their Constitution changed, the system has failed. Doc A's requirement is retained beneath this: a durable per-project intent/scope/decision store replaces the seed repo's flag-file state — cross-session by construction.

---

## 19. Human approval & rollback

Merged: doc B §25's gate table (adopted) + doc A's confidence axis (§12) + doc A's git-native rollback detail (§16).

**Approval fatigue is the failure mode, not under-approval.** A tool that asks for confirmation on everything is a tool with a confirmation reflex, and users click through reflexes. **Gate on reversibility and blast radius, not on action type:**

| Situation | Gate |
|---|---|
| Read, search, analyze, measure | None |
| Edit inside budget, inside a checkpoint | None — the checkpoint is the safety |
| Plan with non-trivial blast radius | **Approve the Lock once, up front** |
| Edit outside the declared budget | Block — explicit expansion |
| KEEP clause would be violated | Halt — human relaxes or abandons |
| Irreversible or external: migration, force push, deploy, data deletion, network write | Confirm with the specific consequence named |
| Change budget exceeded by a wide margin | Checkpoint — "this is much bigger than planned, look?" |
| Intent confidence below threshold *(doc A's axis)* | Clarify or confirm per §10 — regardless of action risk |

**Approve intent once rather than approving steps many times:** one meaningful decision at the Lock beats twelve reflexive ones during execution. And **every block has a visible, logged, one-key override** — a boundary with no override is a boundary users route around by abandoning the tool. The override is a feature; the log is the point. Some users will override everything; that is fine so long as the log makes it visible.

**Rollback is the safety net that makes low-friction approval defensible:** checkpoint before every execution, one command to restore, no understanding required. Aider's commit-per-change discipline is the proven model and costs nothing to adopt. [Aider](https://github.com/Aider-AI/aider) The honest limit is restated wherever rollback is offered: git cannot undo external side effects; those are categorically approval-gated. Human gates sit before irreversible actions — the highest-leverage intervention point per the agent design-pattern comparison (HITL + reflection scored highest across SWE-bench-style benchmarks in a single-source preprint; treat as indicative). [engrXiv 6738](https://engrxiv.org/preprint/download/6738/11022/9350)

---

## 20. Failure modes

Merged table — doc B §26's rows (adopted) plus doc A §22's risk rows and doc A §13's error-handling failure modes, deduplicated:

| Failure | Response |
|---|---|
| "Make it better" (criterial ambiguity) | Refuse to invent criteria. Inventory what exists; ask the human to mark what is load-bearing; convert to a KEEP set (journey F). Never silently pick a definition of better. |
| Wrong assumption about intended behavior | Assumptions are recorded as an explicit ledger in the Lock. The user sees them before execution. Cheap to catch at the Lock; expensive to catch in a diff. Recovery is a designed flow: revert cleanly, restate the corrected interpretation, re-execute (§28, example 9). |
| Fabricated confidence | The deepest risk — the system that exists to be honest about uncertainty manufactures it anyway. Mitigations: every causal claim carries an evidence class; confidence is a typed field, never a formatting style; eval cases reward calibrated hedging and penalize fluent certainty; every template slot is droppable and evals test that it gets dropped. [evals/RESULTS.md](https://raw.githubusercontent.com/the seed repository/main/evals/RESULTS.md) |
| Clarification fatigue | If the gate is miscalibrated toward asking, Code Director becomes the tool that interrupts constantly. Mitigations: the asking bar (§10), batching and caps, "just fix it" as an explicit autonomy grant, gate precision/recall as a first-class eval dimension. [arXiv 2310.10996](https://arxiv.org/html/2310.10996v1) |
| Silent error-dump loop | User pastes 2,400 lines; the system processes fully internally and surfaces extracted signal only (§14). The loop — error → huge response → confusion → more instructions → more errors — is the bug; every actor in it is behaving "normally." |
| Debug spiral | Three "still broken" turns → hard stop, name the doubtful assumption, one diagnostic question; repair budget exhausted → automatic rollback + escalation. Never another silent retry. |
| Huge repository | Structural graph is incremental and merkle-invalidated; anchor-first retrieval never scans globally; baseline capture is scoped to the KEEP surface, not the repo. Degrades to slower, not to wrong. |
| Unknown framework | Say so. Read the dependency source if vendored; fall back to structural-only verification and mark behavioral claims Unchecked. Lower confidence, not silence. |
| Request conflicts with the Constitution | Surface both sides; do not choose. "You asked for X; the Constitution says no new dependencies; X needs one. Add the dependency, implement it by hand (~2h), or change the rule?" |
| Hidden dependency | Blast-radius analysis: co-change coupling from git catches couplings the call graph misses — the two are complementary and neither is sufficient. |
| Hallucinated API or file | Caught structurally and immediately: symbols are resolved against the real graph before the plan is shown. A plan referencing a non-existent symbol never reaches the human. |
| Regression | The central case. Characterization baseline catches it differentially; if a KEEP clause fails, execution halts and the checkpoint restores. The one failure the architecture is built around. |
| Overengineering | Plan critique pass scores each step for necessity; unnecessary steps become findings. The Constitution can carry an explicit simplicity rule. |
| Underengineering / fragile patch | Honestly only partly solvable. Signals: fix touches a symptom far from the blast-radius centroid; no test covers the path; the same area was patched recently (git). Flag as "this is a local patch; the cause may be upstream" rather than blocking. |
| Context pollution | Anchored retrieval with explicit budget; DENY-listed files excluded entirely; context selection shown and correctable. |
| User doesn't understand the explanation | Progressive disclosure with "explain this" on any term; rephrase without merely repeating in shorter words. Track which terms get expanded — a real signal about the user, and the only preference worth learning automatically. |
| Contradictory instructions | Later instruction wins for the goal; KEEP clauses are never silently dropped. "That conflicts with KEEP: export unchanged, which you set in turn 2. Drop that constraint?" Contradiction is surfaced, never resolved by recency alone. |
| Model uncertainty | Represented as evidence class, not hedging language. "Asserted, not measured" is precise; "might possibly" is noise. |
| Agent games its own oracle | Baseline captured pre-execution, outside the writable tree; verifier has no write capability; any baseline modification during execution invalidates the run. [arXiv 2606.28430](https://arxiv.org/abs/2606.28430) |
| Eval gaming / reward hacking | Any metric the product optimizes will be gamed by its own models — SWE-bench Pro showed agents recovering gold patches from git history. Mitigations: leakage controls, structural blinding, published gates, periodic human review of judge decisions. [arXiv 2609.08149](https://arxiv.org/html/2609.08149v1) |
| Weak-test verification theater | Verification confidence stated explicitly; "verified" never implied beyond what ran (§17). |
| Misreading "just fix it" | Experts granting autonomy expect expert judgment in return; a wrong silent assumption under an autonomy grant costs more trust than a wrong question. The assumption ledger still records what was assumed, even when no question is asked. |

---

## 21. Security & privacy

Merged: doc B §§27–28's structure (adopted) + doc A §18's telemetry/local-model detail (retained).

**Security.**

- **Prompt injection via repository content is the primary threat.** Source files, dependency READMEs, issue text, and test fixtures are untrusted input. Content read from the repo can never alter the Lock, expand the file budget, or relax a DENY clause — the boundary is enforced in the tool layer, outside the model's reach, which is precisely why enforcement must not be prompt-based.
- **Execution sandboxing.** Builds and tests run arbitrary repository code: container or VM isolation, no ambient credentials, explicit network policy (off by default in headless runs, as Codex does). OpenHands' runtime is the reference design; do not rebuild it. Assume bypass exists — CVE-2025-59532 is the standing reminder — and layer: sandbox limits blast radius, approvals gate side effects, git limits persistence of damage. [SentinelOne CVE](https://www.sentinelone.com/vulnerability-database/cve-2025-59532/)
- **Secret hygiene / credential handling (merged).** Scan context before it leaves the machine; never include `.env`, key material, or credential-shaped strings; never inject credentials into agent context; approval-gate any command that reads credential stores or pushes/publishes. External side effects are categorically outside git-rollback's reach and must be explicitly confirmed.
- **Supply chain.** New dependencies are a DENY default, not a judgment call — an agent that can add packages is an agent that can add a compromised package. MCP third-party server quality/security varies (10k+ public servers at the Linux Foundation donation); treat remote servers as untrusted input. [MCP donation/governance](https://github.blog/open-source/maintainers/mcp-joins-the-linux-foundation-what-this-means-for-developers-building-the-next-era-of-ai-tools-and-agents/)
- **Blast radius of the tool itself.** No writes outside the repository without explicit, path-specific, documented opt-in. No shell profile edits, no global git config, no background processes.
- **Eval/solution leakage (doc A, retained).** SWE-bench Pro demonstrated agents recovering gold patches from git history and network sources; Code Director's own eval harness must block leakage channels, and its sandbox design should assume agents will find them. [arXiv 2609.08149](https://arxiv.org/html/2609.08149v1)

**Privacy.**

- **Default: everything except inference runs locally.** Parsing, graph construction, ranking, baseline capture, test execution, diffing, reporting are local computation with no service dependency. This is a correctness argument before a privacy one — a repository model that depends on a remote service is stale during outages and wrong in ways the user cannot see.
- **What necessarily leaves the machine is the selected context sent to an inference provider — which is exactly why selection is the privacy story:** "we send ranked excerpts of six files and show you which" is a defensible sentence; "we send your codebase" is not. Provide a redaction pass, per-repository provider pinning, an explicit local-only mode, and a log of what was transmitted per request. Retention and training policy stated per provider, not per product.
- **Local vs. cloud models (doc A, retained).** Model abstraction with per-component choice lets privacy-sensitive code stay on local models (Ollama-class; Aider and Continue both demonstrate viable local operation). The honest trade-off: local models are weaker, and the intent layer is the most quality-sensitive component — ambiguity detection on a weak model may gate poorly. Ship cloud-default with an explicit, understandable local mode that genuinely works, if worse — not a checkbox.
- **Deferring embeddings is partly a privacy decision:** no vector index means no code corpus on a third-party service, removing the single hardest objection in enterprise procurement (§15).
- **Telemetry posture (doc A, retained).** Opt-in only; the opt-in copy states plainly what is collected (interaction-quality signals: clarification accept rates, depth expansions, scope violations, override frequency) and what is never collected (code content). The eval-driven moat depends on interaction telemetry, so the ask must be honest and the default off.

---

## 22. Surfaces: CLI, IDE extension, API/daemon, data model

Doc B §§32–36, condensed; doc A's VS Code-first surface decision reconciled below.

**Architecture:** a local daemon exposing the core loop over JSON-RPC (the LSP pattern), so CLI, IDE, and web are peers rather than layers. Everything except inference is local (§21).

**CLI — the CLI is the product; everything else is a view onto it.** Scriptable and CI-usable, because the Change Report's second-best customer is a pull request.

| Command | Does |
|---|---|
| `cd init` | Build structural index; draft a Constitution from observed conventions for human review |
| `cd intent "<what you want>"` | Interactive Lock authoring — proposes GOAL/KEEP/DENY from blast-radius analysis |
| `cd plan` | Plan with budget and blast radius; no writes |
| `cd run` | Checkpoint, baseline, execute, verify |
| `cd report` | Change Report; `--format=md` for PR comments |
| `cd verify` | Re-run verification against an existing Lock — usable standalone in CI |
| `cd undo` | Restore checkpoint |
| `cd why <symbol>` | Blast radius and coupling for a symbol — useful with no agent involved |

`cd why` and `cd verify` must be genuinely useful without any AI in the loop: a tool that earns its keep before the agent runs is a tool people keep installed. Setup cost kills tools: `cd why` must work in minute one with no Constitution and no Lock.

**IDE — an extension, not a fork.** Forking an editor is a multi-year commitment buying control over a surface that is not the differentiator. The first surface is VS Code (largest install base, extension API sufficient for artifacts + diffs; doc A's decision) with JetBrains and Zed/ACP following. [Superset](https://superset.sh/compare/best-ide-for-ai-agents) Surfaces worth building: the **Lock panel** (goal, KEEP with live check status, budget) pinned while a task runs; inline scope indicators showing which files are in budget; the Change Report as a first-class view alongside the diff, not inside a chat transcript; and **gutter markers distinguishing verified-unchanged regions from changed ones** — the highest-value piece of UI in the product: showing a reviewer which parts of a file they do not need to read.

**GUI — defer.** Justified only by one thing the CLI and IDE cannot do well: the Change Report as a *shareable artifact* — a URL a teammate, reviewer, or non-technical stakeholder can open. That is a phase-2 web surface, not a desktop application, and it is the natural place for team features to attach. Interface discipline throughout: calm, dense, professional; monospace for artifacts, real typography for prose; no gradients, no AI theatrics, no dashboards nobody asked for. The visual model is a build log and a camera report, not a chat product. (Doc A's explicit gimmick exclusion list — AI gradients, glowing buttons, sparkle icons, chatbot personas — is retained and enumerated so nobody "improves" them back in.)

**API & integrations.** Two integrations matter early: a **GitHub Action that posts the Change Report on a PR** — the highest-leverage distribution surface, putting the artifact where review already happens (and directly into the Set-3 market's territory, §4) — and **MCP server exposure of `blast_radius`, `capture_baseline`, and `verify`**, so other agents can use the verification layer. MCP is MIT-licensed and Linux Foundation-governed since December 2025. [MCP standards](https://agenticcommerceprotocol.info/standards/mcp), [Linux Foundation donation](https://github.blog/open-source/maintainers/mcp-joins-the-linux-foundation-what-this-means-for-developers-building-the-next-era-of-ai-tools-and-agents/) Whether "be the verification substrate other agents call" is the endgame or a side bet is a strategic question with a stated fragility — see §26.

**Data model** — the entities that hold the design together:

| Entity | Key fields | Storage |
|---|---|---|
| Utterance | text (immutable), timestamp, surface | `.codedirector/locks/` |
| IntentLock | id, utterance_ref, goal, interpretation, keep[], deny[], budget{files, symbols, magnitude}, acceptance[], assumptions[], status | Versioned, in-repo, human-readable |
| KeepClause | description, kind, compiled_check, baseline_ref, result, evidence_class | Child of Lock |
| Baseline | lock_ref, captured_at, commit, artifacts[] (tests, hashes, traces), determinism_verified | **Outside writable tree, content-addressed** |
| Plan | lock_ref, steps[]{mechanism, blast_radius, reversibility}, budget, critique_result | Disposable |
| Execution | plan_ref, checkpoint_ref, edits[], budget_violations[], retries | Log |
| ChangeReport | claims[]{statement, evidence_class, artifact_ref}, unchecked[], findings[], provenance | Exportable md / JSON |
| Constitution | rules[]{text, compiled_constraint?, source}, version | AGENTS.md + sidecar |
| RepoGraph | symbols, edges, content hashes | Local cache, merkle-invalidated |

**Two invariants hold the design together (doc B, adopted as schema law):** baselines are content-addressed and stored outside the writable tree, so an execution cannot alter its own oracle; and every claim references an artifact — **a claim without an artifact reference is automatically Asserted, enforced by the schema rather than by discipline.** If it is not representable in the type, it cannot be overstated in the prose. Provenance labeling (human / hybrid / AI authorship of each change record) follows the seed repo's CONTRIBUTING.md governance model (§2).

**Suggested stack (doc B §§37–38, condensed):** core daemon in Rust (parsing, graph, hashing, diffing; single static binary; excellent tree-sitter bindings); tree-sitter + grammars for parsing; ast-grep for structural matching and symbol-level scope enforcement; petgraph/sparse linear algebra for the symbol graph and PageRank (no graph database — Aider proves this scale is fine); git2/gix for checkpoints and history mining; xxhash/blake3 for merkle content addressing; rusqlite for index storage; language-native characterization harnesses (insta, jest snapshots, approvaltests); a mutation-testing tool per ecosystem (to validate our own baselines); OpenHands Agent SDK or Claude Agent SDK as execution substrate; MCP SDK for exposure. The stack decision with the most consequence is using someone else's agent loop: building tool-calling, retries, compaction, and sandboxing consumes a year and produces a commodity; the contract layer around it is the whole thesis.

---

## 23. Open-source ecosystem

Merged table: doc A §17's license-verified ledger + doc B §7's "read it for / steal" annotations. Licenses as verified in the tech-research dossier.

| Project | What it does | License | Disposition | Key limitation / note |
|---|---|---|---|---|
| **tree-sitter** | Incremental, error-tolerant parsing; CSTs for 100+ languages | **MIT [verified]** ([LICENSE](https://github.com/tree-sitter/tree-sitter/blob/master/LICENSE)) | **Use directly** | Syntax only — no cross-file semantics; spot-check bundled grammar licenses |
| **ast-grep** | Pattern-based structural search/replace | (per repo; re-check before shipping) | **Use directly** — structural scope enforcement and symbol-level diffing | Ecosystem fit per language varies |
| **LSP servers** (rust-analyzer, pyright, gopls, TypeScript) | Compiler-grade defs/refs/diagnostics | rust-analyzer **MIT/Apache-2.0 [verified]**; pyright **MIT [verified]**; gopls BSD-3, TS Apache-2.0 (re-check before shipping) ([rust-analyzer](https://github.com/rust-lang/rust-analyzer)) | **Use directly / wrap** as agent tools (Serena is the reference: [pattern](https://github.com/cskwork/serena-mcp-quickstart)) | Per-language capability heterogeneity; lifecycle management is real engineering |
| **universal-ctags** | Symbol indexes for 100+ languages | **GPL-2.0 [verified]** ([COPYING](https://github.com/universal-ctags/ctags/blob/master/COPYING)) | **Study; avoid in product** | **The one real licensing hazard.** Subprocess invocation is the conventional safe pattern, but tree-sitter makes the question moot |
| **LanceDB** | Embedded local vector DB, hybrid search | **Apache-2.0 [verified]** ([repo](https://github.com/lancedb/lancedb)) | **Use directly — later**, only when evals show retrieval misses | Younger than pgvector/Qdrant; no strict ACID |
| **Aider** | Git-native terminal pair programmer; ranked repo map | **Apache-2.0 [verified]** ([repo](https://github.com/Aider-AI/aider)) | **Study deeply — read `repomap.py` line by line; re-implement patterns** (repo map, git-as-rollback, read-before-edit) | Terminal UX; repo map degrades on huge monorepos; exact-string edit matching is brittle |
| **github/spec-kit** | Constitution → specify → plan → tasks → implement artifact pipeline | (per repo) | **Study** — artifact-on-disk model, enforced ordering; and to understand exactly how much of the intent-capture surface is already taken | Prose artifacts, no runtime enforcement — the gap Code Director fills |
| **Cline** | Plan/Act agent, approvals, checkpoints, MCP | Apache-2.0 (secondary, verified 2026-06-07 per ssojet) ([repo](https://github.com/cline/cline)) | **Study + benchmark against** — mode boundary as a tool-permission set, not a prompt; its Plan/Act is the market-validated baseline the gate must beat | Token-hungry; per-action binary approvals with no confidence semantics |
| **Continue** | Open IDE assistant, Chat/Plan/Agent modes | Apache-2.0 (secondary sources) | **Study** the mode/tool-gating UX | Maintenance status changed in 2026 — do not depend on its roadmap ([report](https://www.eigent.ai/blog/best-open-source-ai-coding-agents-2026)) |
| **Roo Code** | Cline fork; multi-mode workflows | Apache-2.0 (secondary) | **Study only** | Archived/re-organized in 2026 (reported, unverified) — fork-lineage risk |
| **OpenHands** | Autonomous agent platform; Docker sandbox runtime; event-sourced loop | **MIT** (secondary, corroborated) ([repo](https://github.com/All-Hands-AI/OpenHands)) | **Wrap for execution sandbox; study event-sourced loop** (audit + rollback substrate; `StuckDetector`) | Heavyweight runtime images; unsandboxed local mode can expose host files |
| **SWE-agent / mini-swe-agent** | Research agent; Agent-Computer Interface design; ~100-line harness | **MIT** (secondary) ([repo](https://github.com/SWE-agent/SWE-agent)) | **Study the ACI paper; reuse mini-swe-agent for internal evals** | Research-grade; Python-centric |
| **approvaltests / jest snapshots / insta** | Characterization testing — pinning current behavior without specifying it | (per repos) | **Adopt as the KEEP baseline mechanism** (phase 1.5) | Per-ecosystem; non-determinism needs quarantine (§17) |
| **xxHash / merkle libs** | Fast content addressing for incremental index invalidation | (per repos) | **Use directly** — index freshness without full re-scan | — |
| **MCP** | Open tool-integration standard, Linux Foundation governance since Dec 2025 | **MIT** ([standards](https://agenticcommerceprotocol.info/standards/mcp), [donation](https://github.blog/open-source/maintainers/mcp-joins-the-linux-foundation-what-this-means-for-developers-building-the-next-era-of-ai-tools-and-agents/)) | **Use directly** as the tool bus, both directions | Third-party server quality/security varies — supply-chain risk; treat remote servers as untrusted input |
| **anthropics/claude-code hooks** | PreToolUse interception — the documented community pattern for blocking edits outside a planned file list | (per repo) | **Study — proof the enforcement primitive exists; productize it** | Hook-based, prompt-adjacent; Code Director's enforcement must live in its own tool layer |
| **Sandboxing: Seatbelt / bubblewrap / Docker / gVisor / Firecracker** | Tiered isolation from OS process to microVM | Seatbelt: macOS built-in; bubblewrap LGPL (subprocess/dynamic only); Docker/gVisor/Firecracker Apache-2.0 ([tier guide](https://www.digitalapplied.com/blog/ai-agent-sandboxing-isolation-patterns-2026)) | **MVP: Seatbelt + approval tiers; Docker headless**; gVisor/Firecracker deferred | Network egress = exfiltration channel; writable mounts = modification channel, at every tier |
| **the seed repository** | The seed repo: output contract, escape hatches, eval harness, adapters, context markers | MIT (per repo) | **Study** — eval harness with structural blinding and a published failing gate; adapter shape; idempotent context markers | Prompt-only enforcement; its rules are the *manners*, not the product (§2) |

Aggregate legal posture (doc A, retained): the entire recommended stack is permissively licensed except universal-ctags (GPL-2.0 — excluded by design) and bubblewrap (LGPL — subprocess use only). No copyleft contaminates the product core.

---

