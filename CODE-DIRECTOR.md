# CODE DIRECTOR
### Human Intent → Technical Execution

*A research and product blueprint. Compiled 2026-09-11 from three research dossiers: a deep analysis of the `the seed repository` repository, a 16-tool market landscape study, and an academic/open-source technical research survey. Every factual claim about external repos, tools, licenses, papers, or study findings carries a citation to the source URL recorded in those dossiers.*

---

## 1. Executive conclusion

**Code Director is a product that treats the human as a film director and the AI as a cinematographer: the human supplies intent in plain language; the system translates intent into a technical interpretation, a plan, scoped code changes, and verification — while formally detecting ambiguity before acting, budgeting the human's attention, adapting explanation depth per message, and gating autonomy on calibrated confidence rather than on model enthusiasm.**

The verdict, honestly:

1. **It is buildable.** Every hard component of the loop — intent-clarity classification, clarifying-question generation, plan-then-execute agent loops, scope control via git, test-in-the-loop verification, sandboxing — exists either as engineering-ready research (ClarifyGPT raised GPT-4 Pass@1 from 70.96% to 80.80% on MBPP-sanitized by asking an average of 2.85 questions per genuinely ambiguous problem, and nothing on unambiguous ones: [arXiv 2310.10996](https://arxiv.org/html/2310.10996v1)) or as shipping mechanics in existing tools (Claude Code's six-tier permission system, Cursor's checkpoints, Aider's git-native rollback: [market research file citations in §4 and §17]).

2. **It is not a new category in the "agent" sense — and pretending otherwise would be dishonest.** The Change/Verify half of the pipeline is commoditized. What is genuinely unbuilt is the Intent half: no shipping product has a formal ambiguity gate, a user-attention budget, or an adaptive explanation-depth system. Whether that constitutes a "category" depends on whether those can be defended — the answer is "partially, briefly, and only through eval discipline and design conviction" (§26).

3. **The numbers that drive the conclusion:**
   - Models reliably *recognize* ambiguity when asked to judge it, yet default to direct answers **>95%** of the time without a gate — so prompt-level politeness will not produce clarification behavior; a structural gate is required. [arXiv 2605.25284](https://arxiv.org/html/2605.25284v1)
   - ClarifyGPT's central lesson is double-edged: asking on *every* prompt hurts; the detection gate matters as much as the questions. [arXiv 2310.10996](https://arxiv.org/html/2310.10996v1)
   - The METR RCT (16 experienced OSS developers, 246 tasks) found AI-allowed tasks took **19% longer** while developers *believed* they were ~20% faster — a perception/reality gap that justifies attention budgeting and verification-first design as measurable product behavior, not vibes. [METR RCT](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/), [arXiv 2507.09089](https://arxiv.org/abs/2507.09089), [METR 2026 follow-up](https://metr.org/blog/2026-02-24-uplift-update/)
   - Every one of 18 frontier models degrades as input length grows, well below advertised context windows — "index everything and stuff it in" is anti-evidence; small curated context is a correctness feature, not a cost optimization. [Chroma context-rot study](https://upsolve.ai/blog/context-rot)
   - Asking works: a purpose-built clarification pipeline (intent-clarity classifier + fine-tuned question generator) was preferred over baseline in ~78–82% of user-study ratings. [arXiv 2507.21285](https://arxiv.org/pdf/2507.21285)

4. **The recommended shape:** build Code Director as an intent-engineering layer with its own interaction system, riding on proven execution substrate (git for rollback, LSP/tree-sitter for code truth, MCP for tools, an existing agent loop for Change/Verify), with an eval harness — blind, weighted, honest — treated as the product's real moat. The inspiration repo's most valuable asset is not its rules; it is the demonstration that interaction quality can be specified, measured, and gated.

---

## 2. What the GitHub repository teaches us

The repository under study is [github.com/the seed repository](https://github.com/the seed repository). Strip away the packaging and the entire behavioral payload is a single ~7 KB Markdown file, `SKILL.md`, containing ten output-formatting rules ("Lead with the next action," "Number multi-step tasks," "Cap lists to 5 items," "No preamble, no recap, no closing pleasantries") plus a short set of escape hatches. Everything else — plugin manifests for roughly 14 platforms, session-start hooks, a TypeScript extension, six localized READMEs, CI — is distribution plumbing around that one file. SKILL.md, [INSTALL.md](https://raw.githubusercontent.com/the seed repository/main/INSTALL.md)

**What it actually solves.** The repo solves an *output-shaping* problem: assistants bury the answer in preamble, tangents, and closers ("Great question! … Hope this helps!"). It does not touch the input side at all. Ambiguity appears exactly once, as a single escape hatch — "Real ambiguity in the request. One short clarifying question beats guessing and rewriting" — which is the thinnest part of the ruleset, with no model of what counts as ambiguous or how much ambiguity justifies blocking. SKILL.md

**What it assumes.** Its assumed reader is a technically capable person who can "Run `npm install jsonwebtoken@latest`, then edit `src/auth.ts:42`" — the inverse of Code Director's target user. It also assumes prompt injection is sufficient: the model is *asked* to follow the rules, and the only enforcement is development-time evals. The fragility of that assumption is visible inside the repo itself: the Pi extension must re-inject the rules after context compaction drops them and track whether the ruleset is "still live in the context the model actually receives." Prompt-only behavior control leaks. extensions/seed-repo.ts

**What is genuinely worth borrowing.** Five things, and they are mostly in the *escape hatches and meta-structure*, not the rules:

1. **The output contract as a first-class, versioned, testable artifact.** The repo treats "how the assistant talks" as a spec with a pre-send check — "if the reader reads only the first line and the last line, do they know (a) what to do next, and (b) what just happened?" That is a cheap, effective output contract Code Director should adopt (adapted: first line = what happened or what's needed; last line = the one decision the user must make). SKILL.md
2. **The escape-hatch pattern.** Rules with explicit, enumerated override conditions (destructive action, explain-request, ambiguity, debug spiral, harness conflict), plus a priority ordering among style, task, and platform ("A rule fights the task. The task wins; the shape stays."). Code Director's ambiguity gate needs exactly this shape: enumerated conditions under which the system must stop and ask.
3. **The debug-spiral circuit breaker.** "If the last three turns have been 'still broken,' stop iterating on code. Name the assumption that might be wrong. Ask one diagnostic question." A turn-count-based metacognitive rule — a primitive attention/cost budget and a guardrail against agentic thrash. This may be the single most transferable idea in the repo.
4. **Rule 9's internal/external split.** The 5-item cap "shapes presentation only; it must not limit analysis, search, tool results, candidate generation, or retained information." That *is* progressive disclosure in embryo: full computation internally, bounded presentation externally. Most "be concise" prompts conflate the two; this one doesn't.
5. **Eval-as-release-gate discipline, with honesty.** The repo's Python harness runs 14 hand-labeled cases with runner isolation (`--setting-sources ""` so operator config doesn't contaminate baselines), pinned models, per-condition dollar budgets, structural blinding (conditions relabeled A/B/C with per-group permutation derived deterministically from a digest of the group key), judge-visible rubric isolation, a 5-dimension weighted rubric (Correctness 35%, Autonomy 25%, Actionability 20%, Safety 10%, Concision 10%) — and it *published a FAILED release gate* rather than laundering the result. That willingness is rarer than any of the rules. [evals/README.md](https://raw.githubusercontent.com/the seed repository/main/evals/README.md), [evals/RESULTS.md](https://raw.githubusercontent.com/the seed repository/main/evals/RESULTS.md)

**What to explicitly avoid.**

- **The attention-load framing as product identity.** The repo half-admits the framing is a hook: the tagline is "No attention-load diagnosis needed!" and the five "attention-load facts" it lists (small working memory, initiation friction, flattened time estimation, dopamine scarcity) are simply human cognition under load. The framing does one real job — it gives ruthlessness a defensible reason ("this isn't rudeness, it's accessibility") — but it caps the ceiling: nobody builds an enterprise product on a meme-named repo, and a commercial product built on a disability persona invites trivialization criticism while narrowing the perceived market. The correct generalization is **cognitive-load-aware interaction design**, not an attention-load app. [README.md](https://raw.githubusercontent.com/the seed repository/main/README.md)
- **Prompt-injection-only mechanism.** Scope control and ambiguity gates that matter must be enforced structurally — tool gating, state machines, approval gates — not requested of the model's good nature. The repo's own re-injection-after-compaction machinery is an admission that prompt context is unreliable memory.
- **Rule 8's failure mode: manufactured confidence.** The repo's *own evals* caught its matter-of-fact-error rule pressuring the model "to name a cause even when the evidence does not identify one" — the grader flagged a response that "asserts 'missing auth header' as the definitive cause and prescribes a specific fix without any evidence." Any style rule that mandates confident structure can fabricate confidence. Code Director's format requirements must never override calibrated uncertainty. [evals/RESULTS.md](https://raw.githubusercontent.com/the seed repository/main/evals/RESULTS.md)
- **Degenerate eval gates.** Their gate rule "no blocking findings anywhere in the case set" guaranteed that no candidate could ever pass while any blocker survived — a known-degenerate gate they shipped anyway. Lesson: wire eval gates to metrics that can actually move.
- **Session-scoped, flag-file state.** `touch ~/.claude/.seed-repo-always` does not scale to cross-session intent and scope memory.

**The scientific caveats.** The evals are prompt-pack-grade science, not product-grade: the judge is the same model family that produced the responses (claude-opus-4-8 grading claude-opus-4-8), n=3 trials with per-case SD up to 0.95, and the repo itself warns "single-case deltas below roughly 0.5 should not be treated as signal." One shipped case (`agent-owned-edit`) could not be passed by any run and still counted toward the blocking-findings rule that failed the gate. Borrow the philosophy; do not borrow the statistical rigor. [evals/RESULTS.md](https://raw.githubusercontent.com/the seed repository/main/evals/RESULTS.md)

**Why the attention-load framing is a hook, not the product.** Every rule in the pack is equally valid for busy executives, non-native speakers, mobile users, non-technical stakeholders — anyone in a hurry. The repo polishes answers to questions it assumes were understood; the larger, harder problem it leaves untouched is that *users can't specify what they want and assistants guess instead of detecting ambiguity*. That gap is precisely Code Director's opening. The repo is a catalog of interaction principles and a model of honest evaluation; its architecture contributes almost nothing, and nearly everything except the interaction principles must be redesigned from scratch: input-side intent intelligence, structural scope control, a *dynamic* attention budget, layered progressive disclosure, durable cross-session state, first-class uncertainty, and evals rebuilt around intent translation rather than style.

---

## 3. The larger problem beyond attention-load

The repo's real subject is not attention-load. It is a universal mismatch between how LLM assistants communicate and how human attention works. Three research threads establish that this mismatch is large, measurable, and underserved.

**The translation gap is the deep problem.** A person can know exactly what they want — "when I tap this, I want the previous state preserved," "make the image processing faster," "this should feel more like Apple's implementation" — without owning the vocabulary (state restoration, memoization, optimistic UI, platform HIG conventions) that an agent needs to act. Every AI coding tool on the market translates that intent *silently*: the model picks a technical interpretation and runs. When the interpretation is wrong, the user discovers it after the diff. The CHI 2022 study of Copilot users ("Expectation vs. Experience") found exactly this texture: the tool gave useful starting points, but users struggled to understand, debug, and integrate the generated code, with frequent mismatch between expected and actual usefulness. [Vaithilingam et al., CHI EA 2022](https://dl.acm.org/doi/10.1145/3491101.3519665)

**AI output adds cognitive load even for experts.** A February 2026 interview study of developer productivity with AI assistants identified six productivity factors and found developers reporting that AI output *adds* cognitive load: careful copying, non-determinism requiring repeated re-asking, junior-developer over-reliance — with an explicit tension between short-term load reduction and long-term skill erosion. [arXiv 2602.03593](https://arxiv.org/html/2602.03593v1) An ICSE-SEIP 2026 mixed-methods field+controlled study inside a firm found that *moderate* use of AI suggestions or chat improved efficiency and reduced perceived workload, while *excessive or combined* use eroded the benefit — direct empirical support for metering AI output rather than maximizing it. [arXiv 2512.19926](https://arxiv.org/pdf/2512.19926) And work on proactive (system-initiated) AI assistance found that verifying proactive output costs significant user effort and that poorly timed proactivity harms workflow — which is the academic way of saying interruptions have a price. [arXiv 2502.18658](https://arxiv.org/html/2502.18658v3)

**The perception gap makes this invisible to users.** The METR randomized controlled trial (16 experienced open-source developers, 246 real tasks on mature repos) found AI-allowed tasks took 19% *longer* while developers believed they were ~20% faster (they had predicted 24% faster beforehand). METR's February 2026 follow-up with 57 developers showed mixed/uncertain effects, and METR itself labels the 19% figure historical for early-2025 tools — but the durable finding is the perception/reality gap itself: people cannot feel the review-and-correction overhead that AI assistance imposes. [METR RCT](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/), [arXiv 2507.09089](https://arxiv.org/abs/2507.09089), [METR 2026 follow-up](https://metr.org/blog/2026-02-24-uplift-update/) A product that makes overhead *visible and budgeted* attacks a cost users currently cannot see.

**The generalization.** attention-load-style attention constraints are the acute presentation of a chronic, universal condition: working memory is small, starting is the hardest step, and every screenful of prose is a tax. Code Director's correct framing is cognitive-load-aware software delegation for *everyone* — beginners who can't verify a diff, experts who want "just fix it" on a tired Tuesday, and everyone in between. That framing enlarges the market, avoids disability-trivialization risk, and happens to be true.

---

## 4. Existing market landscape

The 2025–2026 AI coding market has converged on one architecture — an LLM agent loop with tool access (read/edit files, run terminal, search) — wrapped in one of three surfaces. The useful way to tour the sixteen tools is by **interaction archetype**, because the archetype, not the feature list, determines what each tool can ever become for Code Director's target user.

### Archetype 1: The incumbent IDE assistant — GitHub Copilot

Three layers: inline completions; Chat with Ask/Edit/Agent modes across VS Code, JetBrains, Visual Studio, Xcode, Eclipse; and the asynchronous coding agent that takes a GitHub issue, spins up a GitHub Actions environment, and returns a draft PR. Agent mode runs a tool-calling loop with a system prompt that tells it to keep iterating until done, monitors terminal output and test results, and seeks approval before applying changes. [VS Code blog](https://code.visualstudio.com/blogs/2025/02/24/introducing-copilot-agent-mode), [GitHub blog](https://github.blog/ai-and-ml/github-copilot/agent-mode-101-all-about-github-copilots-powerful-mode/) Copilot added Plan Mode in 2025 ("creates detailed execution plans before coding"), but clarifying questions are not a documented, systematic behavior — plan generation is, interrogating the user is left to the model. [Skywork comparison](https://skywork.ai/blog/ai-agent/catpaw-vs-copilot-vs-cursor/) Scope control rides on approval gates, tool allow/deny config, and GitHub's PR governance. Pricing spans free to Pro ~$10/mo to Enterprise ~$39/user/mo. [Skywork](https://skywork.ai/blog/ai-agent/catpaw-vs-copilot-vs-cursor/) Copilot's gravity is distribution; its interaction philosophy is "assist the expert."

### Archetype 2: The AI-native editors — Cursor, Windsurf, Zed

**Cursor** is the strongest plan-flow in the market: Plan Mode (Oct 2025) "researches your codebase to find relevant files, review docs, and ask clarifying questions," producing an editable Markdown plan — but crucially, the questions are a feature of the plan flow, not an ambiguity-detection system; there is no confidence gate and the model asks when it feels like it. [Cursor blog](https://cursor.com/blog/plan-mode) Its mechanical scope control is the market's best: command approval, destructive-command confirmation, full diff review before applying, one-step undo of an entire agent workflow, checkpoints, a 25-tool-call "Continue" checkpoint, and up to 8 parallel agents in git worktrees (Cursor 2.0). [DigitalApplied](https://www.digitalapplied.com/blog/cursor-2-0-agent-first-architecture-guide), [Chiri atlas](https://chiri.ai/chiri-atlas/cursor-anysphere-inc) Pro is $20/mo. Cursor proves plan UX can sell; it does not prove anyone can use it who can't read a diff.

**Windsurf** is the cultural opposite on clarification: reviews characterize Cascade as high-initiative — "runs shell commands without asking, installs dependencies automatically… often executes rm -rf without confirmation" — with weaker guardrails than Cursor and no documented clarifying-question mechanism. [Neura comparison](https://www.neura.market/directories/md-directory/agents-md-cursor-ai-tips-cursor-vs-windsurf-monp0kjt) It saves attention by never asking, at the cost of scary autonomy. Acquired by Cognition AI (Dec 2025, ~$250M) and being merged with Devin. [Taskade](https://www.taskade.com/blog/windsurf-review)

**Zed** is editor-as-agent-host: a fast Rust editor whose agent panel runs external agents over ACP (Gemini CLI, Claude Code), inheriting whatever behavior the hosted agent has. [Superset comparison](https://superset.sh/compare/best-ide-for-ai-agents)

### Archetype 3: The terminal agents — Claude Code, Codex CLI, Gemini CLI, Aider, Amp

**Claude Code** is the permission-architecture leader: six modes from default prompt-per-tool through acceptEdits, plan (full read, zero write), **auto** (an AI classifier approves low-risk actions and escalates risky ones, escalating after 3 consecutive or 20 total denials), dontAsk, and bypassPermissions — plus hooks and allowlists. This is the closest thing in the market to confidence-gated autonomy, except the gate evaluates *action risk* ("is `rm -rf` dangerous?"), never *intent ambiguity* ("how sure am I this is what you meant?"). [promptt.dev](https://www.promptt.dev/blog/claude-code-dangerously-skip-permissions), [Coursiv](https://coursiv.io/blog/claude-code-plan-mode) Tellingly, practitioners like Armin Ronacher bypass plan mode and *manually* build an ask-me-questions workflow — evidence the shipped feature doesn't deliver intent clarification even to experts. [lucumr.pocoo.org](https://lucumr.pocoo.org/2025/12/17/what-is-plan-mode/)

**OpenAI Codex** deliberately has no big-upfront-plan: "Planning is implicit — Codex is nudged to iterate (read → edit → test)." Its strength is best-in-class OS-level sandboxing (macOS Seatbelt; Linux Landlock/seccomp or Docker + iptables; network disabled by default in Full Auto), three approval levels, `/undo`, `/diff` — with the caveat that CVE-2025-59532 demonstrated a sandbox-boundary bypass via crafted cwd. Sandboxes are real, not infallible. [PromptLayer](https://blog.promptlayer.com/how-openai-codex-works-behind-the-scenes-and-how-it-compares-to-claude-code/), [SentinelOne CVE](https://www.sentinelone.com/vulnerability-database/cve-2025-59532/)

**Gemini CLI** is the free, open (Apache 2.0), high-context CLI with read-only plan mode, approval modes, checkpointing with `/restore` and `/rewind`, and gVisor/Seatbelt sandboxing. [DataCamp](https://www.datacamp.com/blog/gemini-cli-vs-claude-code), [Tessl](https://tessl.io/blog/gemini-cli) **Aider** is the git-native pair programmer: every AI change an atomic commit, `/undo` as `git revert`, `/read-only` files, explicit `/add`-based context scoping, and an Architect mode that splits a reasoning model (plans) from an editor model (diffs) — plan review without any clarification gate. [DeployHQ](https://www.deployhq.com/guides/aider) **Amp** is the anti-knob bet: no model picker, three capability modes (Rush/Smart/Deep), and it reportedly *removed* its plan mode in December 2025, betting on agent quality over alignment ceremony. [sidbharath.com](https://sidbharath.com/blog/amp-code-guide/), [lucumr.pocoo.org](https://lucumr.pocoo.org/2025/12/17/what-is-plan-mode/)

### Archetype 4: The open IDE agents — Continue, Cline, Roo Code

**Continue** offers a Chat → Plan → Agent mode ladder where Plan is a read-only sandbox (read/grep/glob/web tools only) and mode-based tool gating is the core control; clarifying questions are not systematic. [Continue docs](https://docs.continue.dev/ide-extensions/agent/plan-mode) **Cline** canonized Plan ↔ Act: Plan explores, asks questions conversationally, proposes strategy; Act executes with per-step approval — producing the market's most documented **approval fatigue**, where per-action prompts train users into reflex approval. [Cline](https://cline.bot/), [Qodo comparison](https://www.qodo.ai/blog/roo-code-vs-cline/) A 2026 GitHub discussion proposing structured Plan↔Act handoffs (task ID, allowed/excluded changes, acceptance criteria, stop conditions) is notable precisely because it's still a *proposal*: formal task-bounding is not native. [Cline discussion #12959](https://github.com/cline/cline/discussions/12959) **Roo Code** (Cline lineage) organized behavior into modes (Architect/Code/Ask/Debug plus custom modes) — behavioral roles, not ambiguity gates — and was reportedly archived in May 2026, with forks like Kilo Code carrying the concept forward. [frontman.sh](https://frontman.sh/blog/roo-code-vs-cline/)

### Archetype 5: The async cloud agents — Jules, Devin, Copilot coding agent, OpenHands

**Jules** is the second product (with Cursor) where clarifying questions are marketed as a named feature: Jules 2.0 added "Interactive Plan Mode — asks clarifying questions, proposes execution strategies," layered on its assign-task → clone → plan → code → PR pipeline, with environment snapshots and Playwright visual testing. [MorphLLM](https://www.morphllm.com/comparisons/jules-google-coding-agent), [xetechai](https://xetechai.com/google-jules-2-0-update-review-new-features-reveal) Again: plan-mode behavior, not a formal gate. **Devin** is the delegate-and-review-PR archetype — Slack/Linear in, sandboxed PRs out — and reviews find it weaker on "ambiguous, novel tasks," which is exactly Code Director's target input. [Standard Compute](https://standardcompute.com/best-ai-agent/amp-vs-devin) **OpenHands** is the open (MIT) autonomous platform: CodeAct loop in a Docker sandbox, event-stream architecture where every action/observation is logged, SWE-bench Verified SOTA claims in the ~50–77% range depending on model/harness. It is designed for delegation; clarification is an exception path when blocked, not a pre-coding gate. [PromptQuorum](https://www.promptquorum.com/power-local-llm/openhands-review), [Nebuladeck](https://nebuladeck.dev/blog/openhands-coding-agent-guide)

### Archetype 6: The enterprise IDE agent — JetBrains Junie

Junie's Advanced Plan Mode writes structured, editable, committable plans in `.junie/plans`, supports running plan and implementation on different models, and ships **Live Prompting** — steering mid-task without restarting — a genuinely distinctive control feature. Its agentic debugging (real breakpoints, runtime state inspection) is deeper verification than run-tests-only agents. Clarifying questions remain unsystematic. [JetBrains](https://www.jetbrains.com/junie/)

### What the tour shows

Sixteen tools, one loop. Every serious entrant has some combination of plan mode, permission modes, checkpoints, sandboxing, and test-in-the-loop. Not one has: an explicit intent-clarity classifier or confidence score, a *gate* that blocks coding below a clarity threshold, calibrated trade-offs about when asking is worth it, an attention budget, or an explanation system with user-controlled depth. The market built the Change and Verify half of Code Director's loop and bolted on Plan. Nobody engineered the Intent half.

---

## 5. The fundamental gap

**Commoditized — do not rebuild as differentiation:**

- **Plan modes.** Cursor, Claude Code, Cline, Continue, Gemini CLI, Junie, Jules, Copilot all ship plan-then-execute. Plan as a read-only exploration phase with an editable artifact is table stakes. [market landscape §cross-cutting]
- **Mechanical scope control and rollback.** Permission tiers (Claude Code's six), OS sandboxes (Codex), Docker isolation (OpenHands), checkpoints and undo (Cursor, Gemini CLI, Cline, Aider's git-native commits), ignore-files and allowlists, worktree isolation (Cursor, Zed). All of it constrains *what the agent may touch* — none of it constrains *whether the agent understood you*.
- **Verification.** Universal: every serious agent runs tests/builds/linters and iterates; Junie adds debugger integration, Jules adds Playwright visual checks.
- **The agent loop itself.** ReAct, plan-and-execute, and their variants are solved engineering; SWE-bench-style execution eval is standardized. [IBM ReAct overview](https://www.ibm.com/think/topics/react-agent), [SWE-bench family](https://arxiv.org/pdf/2603.13258)

**Unbuilt — the actual gap:**

1. **Formal ambiguity detection with confidence-gated autonomy.** Where clarifying questions exist (Cursor, Jules 2.0, Cline plan mode), they are emergent model discretion inside a planning phase. The academic literature confirms models "recognize ambiguity but rarely ask": they can identify ambiguity when explicitly asked to judge it, yet default to direct answers >95% of the time, and retrieval context makes them *less* likely to ask. [arXiv 2605.25284](https://arxiv.org/html/2605.25284v1) No product quantifies intent-clarity confidence and ties it to the autonomy ceiling. Claude Code's auto mode gates on action risk; nothing gates on *understanding risk*. [promptt.dev](https://www.promptt.dev/blog/claude-code-dangerously-skip-permissions)
2. **Attention budgeting.** No tool treats user attention as a resource to be allocated. The market's dominant direction is the opposite: verbose plans, 8 parallel agents' worth of diffs, streaming tool traces, per-step approvals producing documented prompt fatigue and reflex approval. Nobody models interruption cost, batches questions, or adjusts communication density to what the user can absorb. [Coursiv on Claude Code](https://coursiv.io/blog/claude-code-plan-mode), [DigitalApplied on Cursor](https://www.digitalapplied.com/blog/cursor-2-0-agent-first-architecture-guide)
3. **Adaptive explanation depth.** Explanation verbosity is a global model behavior or a prompt hack, not a per-message, user-controlled progressive-disclosure system. Every product emits one register: technical. Diff views assume diff literacy; plan documents assume the reader can evaluate architecture.
4. **A plain-language intent layer for non-experts.** "Vibe coding" products (Replit, Lovable, v0, Bolt) serve non-experts by removing visibility and control entirely. The middle — non-expert intent vocabulary *plus* rigorous control — is empty. This is Code Director's most defensible positioning: an intent-engineering layer that makes delegation governable for people who can't verify a diff.

**Honest convergence threats.** Cursor, Junie, Jules, and Copilot are all investing in plan UX; if any adds systematic clarifying-question gates and simplified plan summaries, gaps 1 and 2 narrow. And Claude Code's hooks and Cline's open plugin model let a third party prototype Code Director-like gating *today* — the concept being buildable as a layer cuts both ways: fast to prototype, hard to keep exclusive. The durable moats are the attention-budget model and the non-expert intent vocabulary, because those require product and design conviction — a willingness to *not show* the diff — not just a feature flag.

---

## 6. Code Director thesis

A film director says "I want this scene to feel isolated, cold, and tense." They do not specify focal length, aperture, sensor format, or lighting ratios. The cinematographer's job is not obedience — it is *translation*: understanding the intent behind the instruction, selecting the technical decisions that serve it, and, when two interpretations diverge meaningfully, bringing the choice back to the director: "A: long lens, compressed background, minimal movement. B: wider lens, closer camera, more environmental distortion. I recommend A because it preserves the isolation you described."

Code Director's thesis is that this relationship is the correct operating model for human–AI software development, and that it decomposes into a pipeline with a hard seam:

```
   ┌────────────┐    ┌──────────────┐    ┌────────────┐
   │   INTENT   │ →  │     PLAN     │ →  │   CHANGE   │ →  VERIFY → REPORT
   │ (the human │    │ (translation │    │ (scoped,   │
   │  directs)  │    │  + contract) │    │  approved, │
   └────────────┘    └──────────────┘    │ revertible)│
                                          └────────────┘
        └────── the unbuilt half ────┘    └─ commoditized ─┘
```

Three commitments define the thesis:

1. **Human language first.** The user never needs the correct technical vocabulary to work effectively. Vocabulary asymmetry is the system's problem, not the user's.
2. **The seam between Plan and Change is a gate, not a suggestion.** Below a confidence threshold, the system *cannot* proceed to code without resolving ambiguity with the human. This is enforced structurally (tool gating), not requested of the model. The ICML 2025 position paper on uncertainty quantification for agents provides the theoretical license: it names *underspecification uncertainty* — the user didn't say enough — as a distinct category that interactive agents must handle by asking follow-ups and expressing uncertainty in language, not numbers. [ICML 2025 UQ position paper](https://icml.cc/virtual/2025/poster/40147)
3. **Minimum necessary cognitive effort — not minimum words.** Sometimes the correct response is one sentence; sometimes it is a diff; sometimes it is a question; sometimes it is silence while the system works. The optimization target is the human's next correct decision at the lowest reading cost, per the empirical finding that moderate AI output helps and excessive output erodes the benefit. [arXiv 2512.19926](https://arxiv.org/pdf/2512.19926)

The cinematographer metaphor is also, literally, an architecture: Code Director can sit *on top of* an existing agent loop (the "camera crew" — the commoditized Change/Verify machinery) and own the layer the market hasn't built. That is both its opportunity and its fragility, examined in §21 and §26.

---

## 7. Product principles

The brief drafted ten principles. Research supports most of them, sharpens two, and adds caveats to one. The revised set:

1. **Human intent comes before technical terminology.** The system must accept intent in the user's vocabulary and own the translation burden. *Unchanged.*
2. **Ask only when the cost of a wrong assumption exceeds the cost of the question.** The draft said "ask before assuming when ambiguity matters"; ClarifyGPT's central finding sharpens it: asking on *every* prompt adds burden and hurts performance — the detection gate is as important as the questions. [arXiv 2310.10996](https://arxiv.org/html/2310.10996v1) Clarification is an intervention with a price; the gate decides when it's worth paying.
3. **Explain only what is necessary — but never less than necessary.** Minimum necessary cognitive effort, not minimum words. A one-line "Done" that hides a broken assumption is worse than a paragraph. *Unchanged in spirit, sharpened.*
4. **Reveal complexity progressively.** Full computation internally; bounded presentation externally — the repo's rule-9 split generalized. Every message is complete at its shallowest level and expandable on demand. SKILL.md rule 9
5. **Never silently expand scope.** Requested, inferred, and protected scope are explicit artifacts; the diff must reconcile against them. *Unchanged.*
6. **Make changes understandable and reversible.** Every accepted change is a git-native, revertible unit with a plain-language description. *Unchanged.*
7. **Confidence determines autonomy.** High confidence → act and report; medium → state the interpretation and proceed only with lightweight confirmation; low → stop and ask. The system must never manufacture confidence because it can generate code — the failure mode the inspiration repo's own evals caught (a style rule pressuring the model to name an evidence-free cause). [evals/RESULTS.md](https://raw.githubusercontent.com/the seed repository/main/evals/RESULTS.md)
8. **The human directs; the AI translates, executes, and verifies.** Delegation is the default; supervision is the right. Human gates sit before irreversible actions — the highest-leverage intervention point per the agent design-pattern comparison (HITL + reflection scored highest across SWE-bench-style benchmarks in a single-source preprint; treat as indicative). [engrXiv 6738](https://engrxiv.org/preprint/download/6738/11022/9350)
9. **Attention is a finite resource with an exchange rate.** Every question, diff, and notification spends from the same budget. The system tracks the spend and degrades gracefully — batching, deferring, summarizing — rather than interrupting. (New: elevated from a principle to a measurable product behavior, §10.)
10. **Technical sophistication lives underneath the interface, not inside the user's mental workload.** The system's competence should be maximized exactly where the user's reading isn't. *Unchanged.*
11. **(Added) Never let format override truth.** Style rules serve comprehension; the moment a format requirement would force a fabricated cause, a false symmetry, or a suppressed uncertainty, truth wins. This is the negative lesson of the repo's rule 8, promoted to a principle.

---

## 8. Interaction model

The full loop, from cold start:

**Open project.** Code Director indexes the repository in the background (symbol map via tree-sitter/LSP, git state, test-runner detection — §11) and reports one line: what it sees ("A SwiftUI app, 240 files, tests present, clean working tree"). No setup wizard, no config ceremony.

**Describe intention.** The user states intent in their own vocabulary: "make this loading state feel instant." No required syntax, no mode selection. Directive phrases from the brief's "Director Language" ("don't change the layout," "only touch this screen," "explain that without developer jargon," "show me what you're about to change," "just fix it") are meaningful instructions parsed as constraints on scope, depth, and process — not a command language the user must learn.

**Understand.** The intent interpreter produces a technical interpretation *plus a confidence level* (§9), using codebase context: which screen, which symbols, what "loading state" concretely refers to here.

**Clarify — only if gated.** If confidence is below threshold, the system asks the minimum set of questions, in the user's vocabulary, with options it can defend: "Should the user be able to continue editing while that work is happening?" If confidence is adequate, it states its interpretation instead: "I read this as: the UI should respond immediately while the heavy work runs in the background."

**Plan.** A short contract, not an essay:

> **You asked:** Make image export faster.
> **I found:** Export spends most of its time converting the image on the main thread.
> **Plan:** Move conversion off the main thread.
> **Scope:** `ExportView.swift`, `ImageExporter.swift`
> **I will not change:** UI, file format, export quality.
> Apply?

**Change.** Scoped, reversible, git-native edits (§12), executed by the coding agent with the change controller enforcing the contract structurally.

**Verify.** Tests, build, lints run automatically; failures trigger bounded repair, then rollback — never silent scope expansion (§12, §13).

**Report.** A depth-leveled message (§14): outcome first, expandable to what changed, technical explanation, deep detail. One next action.

**Conversation model.** The conversation is the primary surface, but it is not a chatbot transcript — it is a sequence of *artifacts*: intent statements, interpretation cards, questions, plan contracts, change summaries, verification reports. Each artifact is individually addressable (approve, expand, undo, question) — echoing the finding that conversation, direct manipulation, and search are complementary interaction models with different attention trade-offs, so the product offers all three rather than forcing everything through chat. [Conversational Programmers, IUI 2023](https://openreview.net/pdf/7013617f3be8846705978cdd8217bfbef22edf9d.pdf)

**Message anatomy.** Every system message follows the output contract borrowed from the repo: first line = what happened or what's needed from you; last line = the single next decision. In between, only the budgeted middle. The pre-send check is mechanical: "if the user reads only the first and last line, do they know what happened and what to do next?" SKILL.md

---

## 9. Intent/ambiguity system

This is Code Director's defining subsystem — the thing no shipping product has built as an engineered gate. Design:

### Ambiguity taxonomy

An intent statement is ambiguous along enumerable axes, each with different stakes:

- **Referential** — "make this better": what is "this"? (Resolvable cheaply from cursor position, open file, selection.)
- **Qualitative** — "better," "cleaner," "snappier": which dimension — speed, reliability, polish, readability?
- **Scope** — does "fix it" license touching dependencies, renaming, reformatting?
- **Behavioral** — should the user be able to interrupt? Should state persist? What should happen on failure?
- **Acceptance** — how will we know it's done? (The axis TiCoder's test-driven clarification targets: infer intent from tests rather than ask — scales without user turns but cannot capture non-functional intent. [arXiv 2507.21285, Related Work](https://arxiv.org/pdf/2507.21285))

### Detection signals (layered, cheap-first)

1. **Lexical/structural flags.** Vague quantifiers, missing referents, affect words ("feel," "better," "nice"), absent constraints. Near-free heuristics.
2. **Behavioral divergence (ClarifyGPT's mechanism).** Sample *n* candidate solutions/interpretations, run them on generated inputs or check them against the codebase; divergent behavior ⇒ the requirement is ambiguous; the *divergence itself* identifies what to ask about. This raised GPT-4 Pass@1 from 70.96% to 80.80% on MBPP-sanitized with an average of 2.85 questions per genuinely ambiguous problem — and crucially, nothing asked on clear ones. [arXiv 2310.10996](https://arxiv.org/html/2310.10996v1)
3. **Intent-clarity classifier.** Darji & Lutellier trained a classifier that detects under-specified coding prompts plus a fine-tuned clarification-question generator, looped until the prompt is clear or a threshold is hit; users preferred its outputs over baseline in ~78–82% of ratings on precision/focus, contextual fit, and faithfulness. A trained classifier beats zero-shot prompting — but per the tech research, start with prompting + consistency check and fine-tune only with logged production data. [arXiv 2507.21285](https://arxiv.org/pdf/2507.21285)

### Confidence model

Three levels with **defined behaviors**, enforced by the gate:

| Confidence | Meaning | Behavior |
|---|---|---|
| **High** | Interpretation is unambiguous given context; alternatives converge | Proceed. State the interpretation in one line inside the plan. |
| **Medium** | A dominant interpretation exists but a plausible rival survives | State the interpretation and proceed only with a lightweight confirmation ("I think you mean X — say the word if not"), or ask one question if the divergence is behavior-changing. |
| **Low** | Two or more fundamentally different interpretations, or a protected-scope conflict | Block coding. Ask the minimum question set, with options, in user vocabulary. |

Calibration is the hard part and must be treated as research-grade: token-entropy and self-consistency (multi-sample divergence) confidence signals are usable today, but *calibrated, user-actionable* confidence that correlates with "should I ask the human?" is an open problem — the 2025 review of 22 UQ benchmarks found most ecologically invalid, i.e., they don't measure whether uncertainty information helps users make better decisions. [arXiv 2506.07461](https://arxiv.org/html/2506.07461v1) Consequence: ship the gate with heuristic confidence, instrument it, and let the eval harness (§21) decide when the classifier earns more autonomy.

### Clarification UI patterns

- **Multiple-choice first.** Questions ship with concrete, checkable options ("A: Faster. B: Easier to understand. C: More polished. D: More reliable"), because producing an answer is cheaper than composing one. Free text always available.
- **Batched, never drip-fed.** All blocking questions in one message. Question count per task capped (ClarifyGPT's ~2.85 average is the right order of magnitude).
- **Answerable without knowledge.** Options phrased in outcomes, not mechanisms — never "Should I use optimistic UI?" but "Should the change appear instantly even if it might need to be undone a second later?"

### When NOT to ask

ClarifyGPT's finding that always-asking hurts is a hard constraint, and ClarifyCodeBench adds a second: clarification quality degrades as ambiguity count grows, and strong code generation does not imply strong clarification — so the clarification loop must be evaluated separately from coding ability, and the system must *triage* ambiguities rather than enumerate them. [arXiv 2607.00711](https://arxivtldr.org/abs/2607.00711) Concretely, don't ask when: the ambiguity is referential and context resolves it; the interpretations produce identical user-visible behavior; a reversible low-stakes default exists and rollback is one click; or the user has said "just fix it" (an explicit autonomy grant). Which of several detected ambiguities deserves one of the user's scarce attention units — question prioritization under an attention budget — is flagged in the research as open; Code Director's answer is heuristic ranking (behavioral impact × irreversibility × confidence spread) validated by evals.

---

## 10. Attention-budget model

**Definition.** The attention budget is an explicit accounting layer that treats every unit of communication and interruption as spending from a finite per-session resource, with the goal that the user's cumulative cognitive cost stays minimized across the whole task — not per message.

**What costs attention (the price list):**

- *Reading*: words on screen, weighted by jargon density and by whether the reader must mentally reconstruct state ("what changed?").
- *Deciding*: every question, approval, or choice presented. Decisions are the most expensive unit — per the proactive-assistance research, verifying system-initiated output costs significant user effort and poorly timed proactivity harms workflow. [arXiv 2502.18658](https://arxiv.org/html/2502.18658v3)
- *Context switching*: pulling the user out of flow — notifications, mid-task interruptions, mode changes.
- *Working memory*: anything the user must hold while reading something else; off-screen state is forgotten, which is why the repo's "restate state every turn" rule exists. SKILL.md

**How responses are budgeted.** Before sending, each candidate message is scored on necessity: *what is the minimum information this person needs to make the next correct decision?* Anything not serving the next decision is deferred into an expandable layer. The accounting runs per session: track questions asked, decisions requested, words shown, approvals demanded. As the spend accumulates, the system degrades gracefully — batching remaining questions, lowering explanation defaults, consolidating status into a single line — rather than maintaining constant verbosity until the user burns out. This is the dynamic generalization of the repo's static 5-item cap (whose internal/external split — cap presentation, never analysis — is the seed of the whole model). SKILL.md rule 9

**The minimum-necessary-information principle.** Minimum necessary *cognitive effort*, not minimum words — the brief's distinction, now grounded: a two-sentence analogy ("we'll put the AI model behind a small interface so we can replace it later without rewriting the app") can cost less than a one-sentence jargon statement ("introduce an abstraction layer between the inference backend and the image pipeline"), because the second forces a lookup the first doesn't. The metric is effort-to-decision, not tokens.

**Interruption cost.** An interruption is worth its price only when the expected cost of proceeding without the answer (wrong assumption × irreversibility × rework) exceeds the interruption cost. This is the same inequality as the clarification gate (§9) viewed from the user's side — one mechanism, two faces.

**Why this is justified as product behavior, not taste.** Three findings converge: (1) moderate AI output helps, excessive output erodes the benefit — metering is empirically supported [arXiv 2512.19926](https://arxiv.org/pdf/2512.19926); (2) developers cannot perceive their own review overhead — METR's 19%-slower-vs-feeling-20%-faster gap means an unbudgeted tool can make users slower while feeling faster, so the budget must be enforced by the system, not self-regulated by the user [METR RCT](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/), [METR 2026 follow-up](https://metr.org/blog/2026-02-24-uplift-update/); (3) attention budgeting applies to the *model* too — context rot shows every frontier model degrading as input grows, so small curated context is a correctness feature for the machine as much as the human. [Chroma context rot](https://upsolve.ai/blog/context-rot)

**Honest caveat.** The research file flags attention-budgeted progressive disclosure as "design-space, weak evidence base": the *direction* is supported, the *specific policy* (budget numbers, decay curves) will have to be tuned by product telemetry and the eval harness, not derived from literature.

---

## 11. Context/codebase intelligence

**What the system must know about a project.** Enough to translate intent and scope changes safely: repository structure and entry points; symbols and their relationships (definitions, references, call sites); framework and build configuration; which tests exist and how to run them; git state and recent change history; project conventions; and — critically — *where the boundaries are* (what "this screen" or "the export pipeline" concretely comprises). The user should never have to explain any of this manually.

**What is genuinely useful now (build/adopt):**

- **tree-sitter** (MIT, verified) for incremental, error-tolerant parsing, AST-aware chunking, symbol extraction, and structural search — the de-facto standard Cursor itself uses for chunking. Syntax only: no name resolution, no cross-file semantics. [tree-sitter](https://tree-sitter.github.io/tree-sitter/), [Cursor indexing analysis](https://zzet.org/gortex/how-cursor-indexes-codebase-embeddings-vs-graph/)
- **LSP servers** (rust-analyzer MIT/Apache-2.0, pyright MIT, verified) wrapped as agent tools for compiler-grade truth — precise definitions, references, diagnostics — which embeddings cannot provide. Serena demonstrates the pattern: expose LSP as symbol-level agent tools across 20+ languages. Don't build code intelligence from scratch. [LSP spec](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/), [Serena pattern](https://github.com/cskwork/serena-mcp-quickstart)
- **A ranked repo map** — Aider's key lesson: a tree-sitter/ctags-style skeleton of the whole repository in a few thousand tokens is attention-cheap context that beats naive file-stuffing. [Aider](https://github.com/Aider-AI/aider)
- **grep/BM25 keyword retrieval** as the retrieval baseline; hybrid retrieval (keyword + vector + graph) consistently beats any single method, but the MVP starts here. [graph-vs-vector RAG analysis](https://zzet.org/gortex/graph-rag-vs-vector-rag-for-code/)
- **git history** for recent-changes context ("it worked yesterday" → `git log` and bisect are the first tools, §24).

**What is overengineering (defer):**

- **Custom vector/embedding infrastructure.** Cursor's published architecture — server-side embedding, Merkle tree of file hashes for incremental re-sync, content-addressed chunk cache, a remote vector store at 1T+ vector scale — is what a company with Cursor's scale does, not what an MVP needs. Cursor claims ~12.5% accuracy gain over grep alone from semantic search, which is real but modest; embeddings capture *similarity, not relationships*, go stale on edit, and need a freshness pipeline. Start with symbol map + grep/BM25; add local embeddings (LanceDB, Apache-2.0, verified) only when evals show retrieval misses. [Cursor indexing](https://zzet.org/gortex/how-cursor-indexes-codebase-embeddings-vs-graph/), [Turbopuffer-scale writeup](https://riftmap.dev/blog/cursor-monorepo-indexing/), [LanceDB](https://github.com/lancedb/lancedb)
- **Full code-graph databases** (SCIP/RepoGraph-style). Sourcegraph's four-retriever approach (keyword trigram index, embeddings, SCIP static-analysis graph, local context) shows where the industry ends up, but LSP-on-demand gets ~80% of the value without maintaining a graph database. [Sourcegraph lessons](https://sourcegraph.com/blog/lessons-from-building-ai-coding-assistants-context-retrieval-and-evaluation), [repo-RAG survey](https://arxiv.org/html/2510.04905v1)
- **Agentic graph-guided retrieval** (LocAgent, CodePlan) — academically closest to Code Director's plan-first repo reasoning (CodePlan frames repo-level coding as planning over a dependency graph: build the graph, derive an edit plan ordered by dependencies, generate with retrieved context), but a v2 concern. [CodePlan via repo-RAG survey](https://arxiv.org/html/2510.04905v1)

**Context rot as a design constraint.** The Chroma study (18 frontier models, task difficulty held constant) found *every* model degraded as input length grew — beginning far below advertised windows (all models degraded on ~113K-token conversational inputs), with near-miss distractors compounding damage and coherent-but-irrelevant context hurting *more* than shuffled. [context rot](https://upsolve.ai/blog/context-rot), [Hivetrail summary](https://hivetrail.com/blog/context-rot-chroma-study) Compaction, structured note files, pruning, just-in-time retrieval, and sub-agent isolation (sub-agents return condensed summaries) are the documented mitigations; Anthropic's framing — "the smallest set of high-signal tokens" — is the policy. [mitigations thesis](https://is.muni.cz/th/y4pmx/thesis.pdf), [context rot](https://upsolve.ai/blog/context-rot) Consequence: the context engine's job is *selection*, not collection. "Index the whole repo and stuff it in" is anti-evidence.

**What remains unsolved.** Faithful *semantic* understanding of why code is the way it is — bug history, ABI promises, invariants — is research-open; maintainers report AI PRs systematically miss this "implicit context." [maintainer analysis](https://dailycodesolutions.com/blog/for-open-source-programs-ai-coding-tools-are-a-mixed-blessing/) Code Director's answer is not to pretend otherwise: protected scope and human confirmation exist precisely for the places where the system's model of the project is known to be shallow.

---

## 12. Controlled execution

**Scope model.** Every change request produces an explicit scope contract with three zones:

- **Requested scope** — what the user named ("only touch this screen" → the files composing that screen).
- **Inferred scope** — what the plan requires beyond the named scope (dependencies, call sites), declared before execution: "Fixing this also requires updating the two places that call it."
- **Protected scope** — what must not change: explicit user restrictions ("don't touch anything else"), architectural boundaries, and convention-sensitive areas (public APIs, migrations, generated files).

The contract is an artifact the change controller enforces structurally — tool gating on file paths and edit types — not a prompt instruction. A proposed edit outside requested + inferred scope blocks and escalates. This formalizes what Cline's 2026 discussion was still only *proposing* (structured handoffs with allowed changes, excluded changes, acceptance criteria, stop conditions). [Cline discussion #12959](https://github.com/cline/cline/discussions/12959)

**Approval tiers (confidence × risk, not risk alone).** Claude Code's auto mode — an AI classifier approving low-risk actions and escalating risky ones — is the market's best action-risk gate. [promptt.dev](https://www.promptt.dev/blog/claude-code-dangerously-skip-permissions) Code Director's differentiator is a second axis: *intent* confidence. A low-risk action (small diff, no side effects) still requires confirmation if intent confidence is medium; a high-risk action (destructive command, external side effect) always requires explicit approval regardless of confidence. Destructive-action confirmation is an inviolable override — safety outranks brevity, per the repo's escape-hatch hierarchy. SKILL.md

**Git-native rollback.** Make git the spine: require a clean tree or auto-snapshot before agent turns; one commit per accepted change-batch with a structured message (intent, scope, confidence); rollback = revert to checkpoint, conversation-aware like Claude Code's `/rewind`. Document honestly that rollback cannot undo external side effects (installs, pushes, API calls) — gate those behind approval. Handle the known sharp edges: dirty-tree/merge conflicts on interrupted sessions, untracked files, and the developer's own uncommitted work mixing with agent work (snapshot must capture both). [Claude Code rewind analysis](https://www.mindstudio.ai/blog/claude-code-rewind-command-rollback), [git checkpoint patterns](https://aicodingpatterns.com/en/patterns/git-con-ia-desarrollo-asistido/), [claude-code issue #6001](https://github.com/anthropics/claude-code/issues/6001)

**Sandboxing tiers.** MVP: macOS Seatbelt profile + command approval tiers for the desktop product (zero-dependency; the same approach Claude Code ships) and Docker with hardened flags (default seccomp, cap-drop, no-new-privileges, network off) for headless runs. Graduate to gVisor/Firecracker only for untrusted multi-tenant workloads. Two documented gaps persist at every tier: network egress is an exfiltration channel; writable mounts are a code-modification channel. And remember CVE-2025-59532 — Codex's sandbox boundary was bypassed via a crafted cwd: sandboxes reduce blast radius, they do not eliminate it. [sandboxing tiers](https://www.digitalapplied.com/blog/ai-agent-sandboxing-isolation-patterns-2026), [Seatbelt guide](https://alejandromp.com/development/blog/sandboxing-an-ai-harness-on-macos), [CVE-2025-59532](https://www.sentinelone.com/vulnerability-database/cve-2025-59532/)

**Test-in-the-loop verification.** A thin language-detecting test-runner adapter (detect project type → run → parse JUnit/JSON output → classify fail-to-pass vs. pass-to-pass), exposed as an MCP tool. Tie results to the autonomy gate: green tests raise effective autonomy; red tests trigger bounded repair, then rollback — never silent scope expansion. This operationalizes the APR literature: test-in-the-loop repair pipelines are proven (ContrastRepair: 143/337 Defects4J), while repo-level repair with weak test coverage remains open — so where tests are weak, verification confidence must be *stated as low*, not implied. [APR survey](https://arxiv.org/html/2506.23749v1) Watch for flaky tests (quarantine + retry budgets) and use the symbol/call graph for test selection on long suites.

**Table stakes vs. differentiating.** Checkpoints, diff review, undo, sandboxing, test loops: table stakes — the market has them all. Differentiating: the scope *contract* as an enforced artifact, the intent-confidence axis in approval gating, and the reconciliation report (§14) that compares proposed vs. actual changes against the contract in plain language.

---

## 13. Error handling

**The problem.** The brief names it precisely: the silent error dump loop — user pastes thousands of lines of logs, the AI responds with an enormous technical explanation, and the cycle compounds: error → huge response → confusion → more instructions → more code → more errors. Every actor in this loop is behaving "normally"; the loop itself is the bug.

**Signal extraction.** When large error input arrives (pasted logs, build output, test failures), the system processes the full dump internally and surfaces only the extracted signal:

> **I found the problem.**
> The image processor is receiving a value in the wrong format.
> **I can fix this without changing the rest of the pipeline.**
> Want me to apply it?

The raw log and full reasoning live one click down, not in the message. This is the attention budget (§10) applied to the highest-volume input class, and rule-9's internal/external split applied to diagnostics: full analysis internally, bounded presentation externally. SKILL.md rule 9

**The calm summary pattern.** Errors are reported matter-of-factly: what happened, what it means, what the options are, what the system recommends. No alarm styling, no blame framing, no apologetic padding — the repo's rule 8 ("matter-of-fact tone for errors") borrowed, with its failure mode surgically removed (below).

**Circuit breakers for debug spirals.** Borrow the repo's best idea directly: if the last three turns have been "still broken," stop iterating on code, name the assumption that might be wrong, and ask one diagnostic question. SKILL.md Generalize it into the execution controller: bounded repair attempts per failure (repair budget), automatic rollback when the budget is exhausted, and escalation to the human with the doubtful assumption stated in plain language — not another silent retry. This is also cost control: agentic repair loops are known to be expensive (SWE-Search's MCTS approach reaches 31–39% on SWE-bench Lite at high cost). [APR survey](https://arxiv.org/html/2506.23749v1)

**The fabricated-confidence failure mode — the thing to avoid above all.** The inspiration repo's own evals caught its matter-of-fact-error rule pressuring the model "to name a cause even when the evidence does not identify one," with the grader flagging a response that "asserts 'missing auth header' as the definitive cause and prescribes a specific fix without any evidence." [evals/RESULTS.md](https://raw.githubusercontent.com/the seed repository/main/evals/RESULTS.md) A calm, confident summary of an unverified hypothesis is *worse* than a verbose honest one — it converts uncertainty into false certainty at exactly the moment the user is least able to check. Rule: every causal claim in an error summary carries its evidence state ("The log shows X, which usually means Y" vs. "Y is the cause"), and unverified hypotheses are labeled as such. Format never overrides truth (Principle 11).

---

## 14. Human-readable technical communication

**Critique of the brief's Level 1–4 hierarchy.** The draft hierarchy — Level 1 outcome ("Done. The loading screen now responds immediately"), Level 2 what changed, Level 3 technical explanation, Level 4 deep detail — is directionally right and matches what the research supports: IntelliExplain found proactive explanations of code structure and intent improved understanding and correct usage for non-professional programmers, and companion work (Ivie; Nam et al. 2024) shows in-situ, on-demand, anchored explanations work. [arXiv 2405.10250](https://arxiv.org/html/2405.10250v3) But as specified it has two flaws: (1) it's a *vertical* stack with a single axis, when real messages vary on at least two — depth and *kind* (outcome, plan, change, error); a 4-level ladder on every message would bloat everything; (2) it risks the static-classification mistake the brief itself warns against in §18.

**The improved design: depth as a per-message dimension, not a ladder.** Every substantive message is a complete, self-sufficient statement at its shallowest level, with two orthogonal controls:

- **Deeper** (progressive disclosure): outcome → what changed → technical explanation → full detail (diffs, traces, reasoning). Each level is reachable by one click/keystroke and each level is independently readable — Level 1 never requires reading Level 4. The repo's pre-send check enforces the invariant mechanically. SKILL.md
- **Plain-er** (register shift): the same level re-expressed without jargon. "Introduce an abstraction layer between the inference backend and the image pipeline" → "put the AI model behind a small interface so we can replace the model later without rewriting the rest of the app." Same idea, less mental effort.

Depth defaults are inferred from *demonstrated behavior per thread* — the user who expands technical detail three messages running gets deeper defaults on that thread; the user who says "just fix it" gets outcome-first terse — never from a permanent "beginner/expert" profile. The interface adapts to the user's *current cognitive need*; an expert on a tired Tuesday and a beginner on a curious Saturday are the same product.

**The rewriting discipline.** "Same idea, less mental effort" is an editorial standard applied to every user-facing string: prefer outcomes to mechanisms, concrete file/screen names to abstractions, one decision per message. It is enforced by the eval harness (§21), not by hoping the model feels like it.

**What to borrow verbatim from the repo:** no preamble, no recap, no closing pleasantries; suppress tangents (a stale dependency is not this task's business); state restatement each turn ("step 3 of 5 done: schema updated") because off-screen state is forgotten; specific time estimates where duration matters; completed work made visible. All adapted for execution-by-proxy: the user decides, the system does — every "run this command" becomes "I've run this; here's what happened." SKILL.md

---

## 15. UX architecture

**Surfaces.** Calm, professional, native-feeling. The major panels:

1. **Conversation (primary).** The artifact stream from §8: intents, interpretation cards, questions with checkable options, plan contracts, change summaries, verification reports. Not a chatbot transcript — each artifact is individually actionable (approve, expand, undo, question).
2. **Current plan/contract.** A persistent, glanceable card showing the active scope contract: requested, inferred, protected; status; confidence. The single source of truth for "what is it doing right now."
3. **Changes.** Diff presentation designed for the diff-illiterate: a plain-language change summary first ("3 files changed: export now runs in the background"), with per-file expandable rows and the raw diff one level down. Accept/undo per change-batch, not per hunk.
4. **Context.** Project understanding surfaced on demand — "what Code Director knows about this project" (structure, conventions, test status) — never as a persistent dashboard competing for attention.
5. **History/undo.** A timeline of change-batches with one-click revert per batch, conversation-aware (reverting a batch can surface the intent that created it).

**Interaction principles (Apple-like, extracted not copied):**

- **Progressive disclosure everywhere.** The default view of everything is its shallowest complete form; depth is always one deliberate gesture away, never forced. This is the repo's rule 9 turned into layout: full computation internally, bounded presentation externally.
- **Direct manipulation.** The user acts on artifacts — approve this plan, revert this change, answer this question — rather than issuing meta-commands to a chatbot.
- **System feedback.** State is always visible in one line (what's happening, what's done, what's needed), per the repo's restate-state rule; nothing important exists only in a scrollback.
- **Calm defaults.** No urgency styling except for genuinely blocking decisions; errors are matter-of-fact (§13); the product should read as a quiet, competent colleague.

**Explicitly avoided visual gimmicks** (per the brief, enumerated so nobody "improves" them back in): AI gradients, glowing AI buttons, sparkle icons, excessive badges, fake futuristic HUDs, unnecessary animation, chatbot personas/avatars, enormous text panels, "magic" marketing language, anything that makes the interface look like an AI demo. The goal is not to make AI look futuristic; it is to make complex development feel clear and controllable.

---

## 16. Technical architecture

Designed from scratch, but deliberately boring where the ecosystem is solved. **[MVP]** marks MVP-essential; **[v1+]** marks later.

```
┌──────────────────────────────────────────────────────────────────────┐
│                        CODE DIRECTOR                                 │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  INTERACTION LAYER [MVP]                                       │  │
│  │  IDE extension (VS Code first) + conversation UI               │  │
│  │  artifacts (intent / question / plan / change / report)        │  │
│  │  depth controls · attention budgeter · output contract check   │  │
│  └──────────────┬─────────────────────────────────────────────────┘  │
│                 │                                                    │
│  ┌──────────────▼─────────────────────────────────────────────────┐  │
│  │  INTENT LAYER  (the differentiator)                            │  │
│  │  Intent interpreter [MVP] — plain language → technical interp. │  │
│  │  Ambiguity detector [MVP] — heuristics + ClarifyGPT-style      │  │
│  │    consistency check; classifier [v1+ once logged data exists] │  │
│  │  Confidence gate [MVP] — high/med/low → autonomy ceiling       │  │
│  │  Question generator [MVP] — batched, option-ful, plain         │  │
│  └──────────────┬─────────────────────────────────────────────────┘  │
│                 │                                                    │
│  ┌──────────────▼─────────────────────────────────────────────────┐  │
│  │  PLANNING & CONTEXT                                            │  │
│  │  Planning engine [MVP] — plan-and-execute; scope contract      │  │
│  │  Context engine [MVP] — small curated context; repo map;       │  │
│  │    just-in-time retrieval; compaction                          │  │
│  │  Repo index [MVP] — tree-sitter symbols + grep/BM25            │  │
│  │  LSP tools [v1+] — compiler-grade def/ref/diagnostics          │  │
│  │  Embeddings (LanceDB) [v2 — only if evals demand]              │  │
│  └──────────────┬─────────────────────────────────────────────────┘  │
│                 │                                                    │
│  ┌──────────────▼─────────────────────────────────────────────────┐  │
│  │  EXECUTION & CONTROL                                           │  │
│  │  Coding agent [MVP — wrapped loop, mini-swe-agent-style]       │  │
│  │  Change controller [MVP] — enforces scope contract via tool    │  │
│  │    gating; approval tiers (confidence × risk); circuit breaker │  │
│  │  Verification engine [MVP] — test-runner adapter (MCP tool),   │  │
│  │    fail-to-pass classification, bounded repair, rollback-on-red│  │
│  │  Git integration [MVP] — snapshot, one commit per batch,       │  │
│  │    revert = undo, structured commit messages                   │  │
│  │  Sandbox [MVP] — Seatbelt (macOS) / Docker (headless);         │  │
│  │    gVisor/Firecracker [v2+]                                    │  │
│  └──────────────┬─────────────────────────────────────────────────┘  │
│                 │                                                    │
│  ┌──────────────▼─────────────────────────────────────────────────┐  │
│  │  FOUNDATION                                                    │  │
│  │  Model abstraction [MVP] — cloud + local (Ollama-class);       │  │
│  │    per-component model choice (planner vs. editor)             │  │
│  │  MCP bus [MVP] — tool integrations both directions             │  │
│  │  State store [MVP] — durable per-project intent/scope/decision │  │
│  │    history (NOT flag files)                                    │  │
│  │  Permissions & policy [MVP] · telemetry (opt-in) [v1]          │  │
│  │  Eval harness [MVP — internal] — blind A/B, weighted rubric,   │  │
│  │    isolation, published gates                                  │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

Component notes:

- **IDE integration [MVP].** A VS Code extension is the pragmatic first surface (largest install base, extension API sufficient for artifacts + diffs). A standalone app and JetBrains support follow; Zed's ACP shows the hosting protocol direction. [Superset](https://superset.sh/compare/best-ide-for-ai-agents)
- **Code intelligence [MVP: tree-sitter; v1+: LSP].** tree-sitter (MIT, verified) for parsing/symbols/chunking; wrap existing language servers as agent tools per the Serena pattern rather than building from scratch. universal-ctags is GPL-2.0 — study only, prefer tree-sitter to make the question moot (§17). [tree-sitter](https://tree-sitter.github.io/tree-sitter/), [Serena](https://github.com/cskwork/serena-mcp-quickstart)
- **Coding agent [MVP].** Do not build a novel agent framework: a mini-swe-agent-style minimal loop (~100-line harness; also the harness used in SWE-bench Pro Verified evaluations) or a wrapped OpenHands runtime. The agent loop is a commodity; Code Director's value lives above it. [SWE-agent](https://github.com/SWE-agent/SWE-agent), [SWE-bench Pro](https://arxiv.org/html/2609.08149v1)
- **Model abstraction [MVP].** Per-component model choice (expensive planner, cheap editor — Aider's architect-mode split; ReWOO-style planning cuts token use) with local-model support for privacy-sensitive code. [Aider architect mode](https://www.promptlayer.com/glossary/aider-architect-mode/), [ReWOO/plan patterns](https://nomadx.ae/blog/ai-agent-reasoning-react-plan-execute-tree-of-thought-2026/)
- **Eval harness [MVP, internal].** Not optional. The product's claims (asks when it should, doesn't when it shouldn't, stays in scope, communicates at the right depth) are behavioral and must be gated by blind, weighted, isolated evals — the inspiration repo's harness philosophy, rebuilt around intent translation: vague prompts, underspecified scope, non-technical phrasing, multi-turn clarification. [evals/README.md](https://raw.githubusercontent.com/the seed repository/main/evals/README.md)

---

## 17. Open-source ecosystem

All licenses below were verified against the projects' own LICENSE/COPYING files or repository pages where marked [verified]; secondary-source licenses are attributed. Full ledger in the tech research file.

| Project | What it does | License | Disposition | Key limitation / legal note |
|---|---|---|---|---|
| **tree-sitter** | Incremental, error-tolerant parser; CSTs for 100+ languages | **MIT [verified]** ([LICENSE](https://github.com/tree-sitter/tree-sitter/blob/master/LICENSE)) | **Use directly** | Syntax only — no cross-file semantics; grammar quality varies; spot-check bundled grammar licenses |
| **LSP servers** (rust-analyzer, pyright, gopls, TypeScript) | Compiler-grade defs/refs/diagnostics as JSON-RPC | rust-analyzer **MIT/Apache-2.0 [verified]**; pyright **MIT [verified]**; gopls BSD-3, TS Apache-2.0 (per project convention — re-check before shipping) ([rust-analyzer](https://github.com/rust-lang/rust-analyzer)) | **Use directly / wrap** as agent tools (Serena is the reference: [pattern](https://github.com/cskwork/serena-mcp-quickstart)) | Per-language capability heterogeneity; lifecycle management is real engineering |
| **universal-ctags** | Symbol indexes for 100+ languages | **GPL-2.0 [verified]** ([COPYING](https://github.com/universal-ctags/ctags/blob/master/COPYING)) | **Study; avoid in product** | **The one real licensing hazard.** Do not link/embed in a proprietary product; subprocess invocation is the conventional safe pattern, but tree-sitter makes the question moot |
| **LanceDB** | Embedded local vector DB, hybrid search | **Apache-2.0 [verified via multiple sources]** ([repo](https://github.com/lancedb/lancedb)) | **Use directly — later**, only when evals show retrieval misses | Younger than pgvector/Qdrant; no strict ACID; index tuning at scale |
| **Aider** | Git-native terminal pair programmer; ranked repo map | **Apache-2.0 [verified]** ([repo](https://github.com/Aider-AI/aider)) | **Study deeply; re-implement patterns** (repo map, edit formats, git-as-rollback, read-before-edit) | Terminal UX; repo map degrades on huge monorepos; exact-string edit matching is brittle |
| **Continue** | Open IDE assistant, Chat/Plan/Agent modes | Apache-2.0 (secondary sources) | **Study** the mode/tool-gating UX | Maintenance status changed in 2026 — do not depend on its roadmap ([report](https://www.eigent.ai/blog/best-open-source-ai-coding-agents-2026)) |
| **Cline** | Plan/Act agent, approvals, checkpoints, MCP | Apache-2.0 (secondary, verified 2026-06-07 per ssojet) ([repo](https://github.com/cline/cline)) | **Study + benchmark against** — its Plan/Act is the market-validated baseline Code Director's gate must beat | Token-hungry; per-action binary approvals with no confidence semantics — the gap Code Director fills |
| **Roo Code** | Cline fork; multi-mode workflows | Apache-2.0 (secondary) | **Study only** | Archived/re-organized in 2026 (reported, unverified) — fork-lineage risk |
| **OpenHands** | Autonomous agent platform; Docker sandbox runtime; event-sourced loop | **MIT** (secondary, corroborated) ([repo](https://github.com/All-Hands-AI/OpenHands)) | **Wrap for execution sandbox; study event-sourced loop** (audit + rollback substrate; `StuckDetector`) | Heavyweight runtime images; unsandboxed local mode can expose host files; autonomy-first, not director-first |
| **SWE-agent / mini-swe-agent** | Research agent; Agent-Computer Interface design; ~100-line harness | **MIT** (secondary) ([repo](https://github.com/SWE-agent/SWE-agent)) | **Study the ACI paper; reuse mini-swe-agent for internal evals** | Research-grade; Python-centric |
| **MCP** | Open tool-integration standard, Linux Foundation governance since Dec 2025 | **MIT** ([standards](https://agenticcommerceprotocol.info/standards/mcp), [donation](https://github.blog/open-source/maintainers/mcp-joins-the-linux-foundation-what-this-means-for-developers-building-the-next-era-of-ai-tools-and-agents/)) | **Use directly** as the tool bus, both directions | Third-party server quality/security varies — supply-chain risk; treat remote servers as untrusted input; auth/RBAC maturing |
| **Sandboxing: Seatbelt / bubblewrap / Docker / gVisor / Firecracker** | Tiered isolation from OS process to microVM | Seatbelt: macOS built-in; bubblewrap LGPL (subprocess/dynamic only); Docker/gVisor/Firecracker Apache-2.0 ([tier guide](https://www.digitalapplied.com/blog/ai-agent-sandboxing-isolation-patterns-2026)) | **MVP: Seatbelt + approval tiers; Docker for headless**; gVisor/Firecracker deferred to multi-tenant needs | Network egress = exfiltration channel; writable mounts = modification channel, at every tier |

Aggregate legal posture: the entire recommended stack is permissively licensed except universal-ctags (GPL-2.0 — excluded by design) and bubblewrap (LGPL — subprocess use only). No copyleft contaminates the product core.

---

## 18. Security/privacy

- **Local vs. cloud models.** Model abstraction with per-component choice (§16) lets privacy-sensitive code stay on local models (Ollama-class; Aider and Continue both demonstrate viable local operation). The honest trade-off: local models are weaker, and the intent layer is the most quality-sensitive component — ambiguity detection on a weak model may gate poorly. Ship cloud-default with an explicit, understandable local mode, not the reverse.
- **Code exfiltration risk.** The primary channels: prompts sent to cloud models (document exactly what context leaves the machine, per request, in a user-inspectable form); MCP servers (third-party server quality/security varies — treat remote servers as untrusted input; supply-chain risk is real at 10k+ public servers); and sandbox network egress (an exfiltration channel at every isolation tier — network off by default in headless runs, as Codex does). [MCP risk](https://www.digiall.com.mx/blog/digiall-tech-news-3/anthropic-donates-model-context-protocol-to-linux-foundation-under-new-agentic-ai-32), [sandboxing](https://www.digitalapplied.com/blog/ai-agent-sandboxing-isolation-patterns-2026)
- **Sandboxing and permissions.** Seatbelt + approval tiers on desktop; hardened Docker headless (§12). Assume bypass exists (CVE-2025-59532 is the standing reminder) and layer: sandbox limits blast radius, approvals gate side effects, git limits persistence of damage.
- **Credential handling.** Never inject credentials into agent context; approval-gate any command that reads credential stores or pushes/publishes; external side effects are categorically outside git-rollback's reach and must be explicitly confirmed (§12).
- **Telemetry posture.** Opt-in only, and the opt-in copy states plainly what is collected (interaction-quality signals: clarification accept rates, depth expansions, scope violations) and what is never collected (code content). The eval-driven moat (§21) depends on interaction telemetry, so the ask must be honest and the default off.
- **Eval/solution leakage.** A niche but real concern for the internal harness: SWE-bench Pro demonstrated agents recovering gold patches from git history and network sources — evaluation-time reward hacking that dropped one model from 78.8% to 57.3% once controls were applied. Code Director's own evals must block leakage channels, and its sandbox design should assume agents will find them. [SWE-bench Pro](https://arxiv.org/html/2609.08149v1)

---

## 19. MVP

**The MVP is: intent understanding + ambiguity gate + controlled scoped changes + human-readable reporting.** Nothing else.

Concretely, the smallest shippable Code Director:

1. A VS Code extension with the conversation surface and artifact model (§8).
2. The intent interpreter + ambiguity detector (heuristics + ClarifyGPT-style consistency check) + the three-level confidence gate with defined behaviors (§9). **This is the MVP's reason to exist.**
3. The scope contract (requested/inferred/protected) enforced by tool gating on the coding agent (§12).
4. A minimal wrapped agent loop (mini-swe-agent-style) doing Change; git-native snapshot/commit/revert as undo; the test-runner adapter for verify.
5. Depth-leveled reporting with the output contract (first line = what happened; last line = next decision) and batched, option-ful clarification questions.
6. The internal eval harness from day one — blind, weighted, honest — with cases built around intent translation, not style.

**Explicitly NOT in the MVP:** embeddings/vector search (grep/BM25 + repo map only); LSP deep integration (tree-sitter suffices initially); local models; JetBrains/standalone surfaces; multi-agent anything; fine-tuned classifiers (prompting + consistency check until logged data exists); MCP *server* exposure; worktree-parallel agents; Live-Prompting-style mid-task steering; dashboards, analytics, teams features.

**Why this is the smallest version that feels meaningfully different:** strip any of the four pillars and the product collapses into an existing archetype. Without the ambiguity gate it's Cline's plan mode with better prose. Without the scope contract it's another agent that edits 15 files when asked to "make this better." Without depth-leveled reporting it's a verbose chatbot. Without intent understanding there is no product at all. Conversely, everything excluded above is either commoditized (and wrappable later) or unproven-value (and deferrable until evals demand it). The MVP is small not because ambition is small, but because the differentiating layer is thin by nature — it lives between the user's sentence and the agent's first edit, and that is where all the engineering courage goes.

---

## 20. Development roadmap

**Phase 0 — Eval infrastructure first (weeks 0–6).** Build the harness before the product: case schema for intent-translation scenarios (vague prompts, underspecified scope, non-technical phrasing, multi-turn clarification, error dumps), blind A/B judging with structural blinding and rubric isolation (borrowed wholesale from the inspiration repo's harness philosophy), weighted dimensions re-oriented to Code Director's claims — interpretation fidelity, gate precision/recall (asked when it should; didn't when it shouldn't), scope adherence, attention cost per task, verification honesty. [eval harness philosophy](https://raw.githubusercontent.com/the seed repository/main/evals/README.md) Add leakage controls from the start (SWE-bench Pro's lesson). [arXiv 2609.08149](https://arxiv.org/html/2609.08149v1)

**Phase 1 — MVP (roughly months 1–4).** VS Code extension; conversation surface with artifacts; repo index (tree-sitter symbols + grep/BM25 + ranked repo map); intent interpreter + heuristic/consistency-check ambiguity detector + confidence gate; scope contract + change controller with tool gating; wrapped minimal agent loop; git snapshot/commit/revert; test-runner adapter; Seatbelt/Docker sandbox; model abstraction (cloud); depth-leveled reporting; output-contract pre-send check. Release gate: the eval suite, with published results — including failures.

**Phase 2 — v1 (roughly months 4–9).** LSP-wrapped code intelligence (compiler-grade refs/diagnostics); attention-budget accounting layer with session telemetry (opt-in); durable per-project intent/scope/decision store; expanded surfaces (JetBrains, standalone); local-model tier; mid-task steering; hardened approval tiers (confidence × risk matrix tuned from telemetry); clarification-quality specialization driven by eval data — including the decision point on training a fine-tuned intent-clarity classifier once logged production data justifies it. [arXiv 2507.21285](https://arxiv.org/pdf/2507.21285)

**Phase 3 — v2 (roughly months 9–18).** Conditional on evals demanding them: local embeddings (LanceDB) for semantic retrieval; worktree-parallel task execution; MCP server exposure (Code Director as a tool inside other IDEs); CodePlan-style repo-level dependency-graph planning for architectural requests [repo-RAG survey](https://arxiv.org/html/2510.04905v1); gVisor/Firecracker tiers if multi-tenant or CI use cases emerge; team features (shared conventions, shared scope policies).

Sequencing logic: every v2 item is gated on demonstrated need, because the research file's overengineering list is explicit — custom vector infra, code-graph DBs, microVM fleets, multi-agent swarms, fine-tuned classifiers before evals demand them are all defer-or-never items, not ambitions.

---

## 21. Competitive differentiation

**Against each archetype:**

- **vs. incumbent IDE assistants (Copilot):** Copilot distributes an agent; Code Director re-engineers the conversation. Copilot's plan mode generates plans but has no documented systematic clarification behavior. Differentiation: the gate, the budget, the depth system. [Skywork](https://skywork.ai/blog/ai-agent/catpaw-vs-copilot-vs-cursor/)
- **vs. AI-native editors (Cursor, Windsurf):** Cursor's Plan Mode asks clarifying questions *emergently* — Code Director's are *gated and calibrated*; Windsurf proves the cost of never asking. Both assume diff-literate users; Code Director serves the diff-illiterate without removing control. [Cursor Plan Mode](https://cursor.com/blog/plan-mode), [Windsurf characterization](https://www.neura.market/directories/md-directory/agents-md-cursor-ai-tips-cursor-vs-windsurf-monp0kjt)
- **vs. terminal agents (Claude Code, Codex, Aider, Gemini CLI, Amp):** Claude Code's auto mode gates action risk; Code Director gates *understanding* risk — the orthogonal axis. Codex omits planning by design; Amp removed plan mode by conviction. The differentiation is a philosophy they have explicitly bet against. [promptt.dev](https://www.promptt.dev/blog/claude-code-dangerously-skip-permissions), [Amp plan-mode removal](https://lucumr.pocoo.org/2025/12/17/what-is-plan-mode/)
- **vs. open IDE agents (Cline, Continue, Roo lineage):** their Plan/Act and mode ladders are the baseline Code Director must beat on gate precision; their documented approval fatigue is the attention budget's Exhibit A. [Qodo](https://www.qodo.ai/blog/roo-code-vs-cline/)
- **vs. async cloud agents (Jules, Devin, OpenHands):** delegation-and-PR-review optimizes for tasks that arrive well-specified; reviews find them weaker on ambiguous, novel tasks — Code Director's home ground. [Standard Compute on Devin](https://standardcompute.com/best-ai-agent/amp-vs-devin)
- **vs. vibe-coding tools (Replit, Lovable, v0, Bolt):** they serve non-experts by removing visibility and control; Code Director serves them by making control legible. Adjacent category, opposite philosophy.

**Where the moat comes from:**

1. **Eval-driven interaction quality.** The product's claims are behavioral and measurable; a serious, blind, honest eval harness compounds into a quality lead that competitors can only close by building the same unglamorous infrastructure. The inspiration repo demonstrates the posture; Code Director industrializes it.
2. **The ambiguity/confidence gate.** Academically grounded (ClarifyGPT, Darji & Lutellier) and absent from every shipping product; hard to retrofit into tools whose cultures (Windsurf's initiative, Amp's anti-knob stance, Codex's no-plan design) are committed elsewhere.
3. **Attention discipline as measurable product behavior.** Requires the willingness to *not show* output — a design conviction incumbents monetizing engagement and capability demos will struggle to adopt.

**How copyable is it, honestly?** The mechanics are copyable in a quarter by a determined incumbent: hooks and permission systems already allow prototyping the gate today (§5). What is not quickly copyable is the *calibration data* (which questions were worth asking, per real users) and the *organizational willingness* to ship less visible capability in exchange for less user effort. Realistic defensibility: 12–24 months of category definition, after which Code Director is either the reference implementation of a feature every tool has, or the product that owns the non-expert-plus-control niche the incumbents structurally can't serve. Both outcomes are examined in §26.

---

## 22. Risks and failure modes

**Technical risks.**

- **Fabricated confidence.** The deepest risk: the system that exists to be honest about uncertainty manufactures it anyway — calm summaries of unverified hypotheses, gates that pass because the model *feels* sure. Mitigations: every causal claim carries an evidence state (§13); confidence is a first-class field, never a formatting style (Principle 11); eval cases specifically reward calibrated hedging and penalize fluent certainty. The cautionary tale is documented in the inspiration repo's own results. [evals/RESULTS.md](https://raw.githubusercontent.com/the seed repository/main/evals/RESULTS.md)
- **Clarification fatigue.** If the gate is miscalibrated toward asking, Code Director becomes the tool that interrupts constantly — recreating ClarifyGPT's always-ask failure at product level. Mitigations: the gate inequality (§9), question batching and caps, "just fix it" as an explicit autonomy grant, and gate precision/recall as a first-class eval dimension. [arXiv 2310.10996](https://arxiv.org/html/2310.10996v1)
- **Eval gaming / reward hacking.** Any metric the product optimizes will be gamed by its own models — SWE-bench Pro showed agents recovering gold patches from git history and network sources. Mitigations: leakage controls in the harness, structural blinding, published gates, and periodic human review of judge decisions. [arXiv 2609.08149](https://arxiv.org/html/2609.08149v1)
- **Weak-test verification theater.** Where test coverage is thin, "verified" is a claim the system cannot back; repo-level repair with weak tests is research-open. Mitigation: verification confidence stated explicitly, never implied (§12). [APR survey](https://arxiv.org/html/2506.23749v1)
- **Calibration is research-grade.** "Should I act or ask?" confidence that is calibrated and user-actionable is an open problem; the shipped gate starts heuristic and earns autonomy through evals (§9). Overpromising here is the single easiest way to discredit the product. [arXiv 2506.07461](https://arxiv.org/html/2506.07461v1)

**Market risks.**

- **Incumbent convergence.** Cursor, Junie, Jules, and Copilot are all investing in plan UX; a systematic clarification gate is a quarter's work for any of them (§5, §21). The defense is speed, calibration data, and the non-expert positioning incumbents structurally avoid.
- **Feature-not-product gravity.** Platform hooks (Claude Code hooks, Cline's plugin model) let the gate exist as a layer on someone else's agent — validation and threat in one. If the ecosystem absorbs the interaction model, Code Director's durable asset is the eval infrastructure and the user trust, not the mechanism.

**UX risks.**

- **Prompt fatigue.** Cline's documented failure mode: per-step approvals train reflex approval, which is worse than no approval. An attention budget that *adds* decisions is self-defeating; the budget must be audited against decision-count, not just word-count. [Qodo/Cline](https://www.qodo.ai/blog/roo-code-vs-cline/)
- **The uncanny valley of calm.** A system that withholds detail can feel like a system that hides mistakes. Progressive disclosure must be *instantly* expandable and the expansion must be complete — depth control as a right, not a ration.
- **Misreading "just fix it."** Experts granting autonomy expect expert judgment in return; a wrong silent assumption under an autonomy grant costs more trust than a wrong question. Wrong-assumption recovery is a designed flow (§24, example 9), not an apology.

---

## 23. What NOT to build

Explicit list, with reasons:

1. **Another general-purpose coding agent.** The edit/run/test loop is a commodity in a red ocean against Copilot, Cursor, and Claude Code, with zero structural advantage (§5). Wrap one; don't build one.
2. **Custom vector DB / embedding infrastructure.** Start with symbol map + grep/BM25; add LanceDB only when evals show retrieval misses. Cursor-scale Merkle pipelines answer a scale problem the MVP doesn't have. [tech research B4/B15](https://zzet.org/gortex/how-cursor-indexes-codebase-embeddings-vs-graph/)
3. **A code-graph database (SCIP/RepoGraph-style).** LSP-on-demand gets ~80% of the value without the maintenance burden. [Sourcegraph](https://sourcegraph.com/blog/lessons-from-building-ai-coding-assistants-context-retrieval-and-evaluation)
4. **Multi-agent swarms.** MAGIS-style role orchestration shows coordination overhead with modest absolute gains (16.67% SWE-bench Lite); one well-gated agent beats five ungated ones for this product's thesis. [APR survey](https://arxiv.org/html/2506.23749v1)
5. **Fine-tuned classifiers before evals demand them.** Prompting + consistency check first; fine-tune the intent-clarity classifier only with logged production data. [arXiv 2507.21285](https://arxiv.org/pdf/2507.21285)
6. **A custom agent framework.** Wrap OpenHands' runtime or a mini-swe-agent-style loop. [SWE-agent](https://github.com/SWE-agent/SWE-agent)
7. **AI-gradient visual gimmicks.** Sparkles, glowing buttons, futuristic HUDs, chatbot personas — explicitly listed so they can be explicitly rejected in every design review (§15).
8. **An attention-load-branded app.** The framing is a hook that caps the market and invites trivialization criticism; the product is cognitive-load-aware design for everyone (§2).
9. **Firecracker microVM fleets** — until untrusted multi-tenant workloads exist. [sandboxing tiers](https://www.digitalapplied.com/blog/ai-agent-sandboxing-isolation-patterns-2026)
10. **A "Director Language" command syntax.** The brief's director phrases must work as natural language, parsed as constraints; the moment users must learn syntax, the intent layer has failed its own premise (§8).

---

## 24. Interaction examples

Ten scripted interactions, each followed by the mechanisms exercised.

### 1. Vague request

> **User:** Make this better.
>
> **Code Director:** "Better" can mean a few things here. Looking at this screen, the most likely candidates are the slow panel switching and some inconsistent spacing.
>
> What should improve most?
> **A** Faster
> **B** Easier to understand
> **C** More polished visually
> **D** More reliable
>
> *(Or tell me in your own words.)*

*Mechanisms: ambiguity taxonomy (qualitative axis), low-confidence gate blocking coding, multiple-choice clarification in outcome vocabulary, codebase context narrowing the options.*

### 2. Non-technical description

> **User:** I don't know what this thing is called, but when I click this it should remember what I was doing.
>
> **Code Director:** Got it — when someone leaves this screen and comes back, everything they entered should still be there.
>
> One question: if they close the whole app and reopen it tomorrow, should it still remember, or only while the app stays open?
>
> **A** Only while the app is open
> **B** Forever, until they clear it

*Mechanisms: intent translation from pure outcome language ("remember what I was doing" → state preservation/restoration), one batched behavioral question, no jargon ("state," "persistence," "lifecycle" never appear).*

### 3. Performance complaint

> **User:** This feels slow.
>
> **Code Director:** I checked what's actually slow. Loading this screen takes about 3 seconds, and nearly all of it is one thing: it resizes every photo at full size before showing anything.
>
> I can make the screen appear almost immediately and fill in the photos as they're ready. Nothing else changes.
>
> Want me to do that?

*Mechanisms: silent technical diagnosis (profiling) with plain-language signal extraction, high-confidence interpretation stated rather than asked (ClarifyGPT gate: don't ask when context resolves it), implicit scope statement ("nothing else changes"), single next decision.*

### 4. UI request

> **User:** Make this feel more like a native iOS app.
>
> **Code Director:** I read that as: it should *behave* like an iOS app, not just look like one. Concretely I'd change three things: swipe back from the edge to go back, large title that shrinks as you scroll, and standard iOS sheets instead of custom popups.
>
> I will not change: your colors, fonts, or layout.
>
> Is that the "native" you mean — or is it more about the visual style?

*Mechanisms: interpretation of aesthetic intent into concrete platform conventions, medium-confidence gate (stated interpretation + one confirming question), explicit protected scope.*

### 5. Bug

> **User:** It worked yesterday and now it doesn't.
>
> **Code Director:** Something changed between yesterday and now — I'll find what.
>
> *(checks recent changes)*
>
> Found it. Yesterday evening a change to how dates are saved went in; this morning's entries are saved in the new format, and the history screen can only read the old one.
>
> I can make the history screen read both formats. Two files, no changes to how anything is saved.
>
> Apply?

*Mechanisms: git history as first diagnostic tool, causal claim with stated evidence, scoped repair plan, no blame, no stack trace at the top level.*

### 6. Large error dump

> **User:** *(pastes 2,400 lines of build log)*
>
> **Code Director:** **I found the problem.**
>
> One of your photo files has a name with a space in it, and the build step that copies it isn't expecting that.
>
> I can fix the build step so any filename works — one file changed.
>
> Want me to apply it?
>
> ▾ Technical detail (the full log and why this happens)

*Mechanisms: signal extraction from massive input, calm summary pattern, full analysis internal / one-click expansion external, scope contained to the actual cause.*

### 7. Scope restriction

> **User:** The save button doesn't work. Fix it but don't touch anything else.
>
> **Code Director:** Understood — I'll fix the save button and treat everything else as off-limits.
>
> Here's the problem: the button works, but it saves to a location the app no longer reads from. The minimal fix touches one file: `SaveButton.swift`.
>
> **Heads up:** the same wrong location is also used by auto-save. Fixing that too would mean touching a second file. Your call:
> **A** Fix only the button, exactly as you said
> **B** Fix both, since it's the same bug

*Mechanisms: protected scope taken literally, inferred-scope expansion detected and *surfaced as a choice* rather than executed — the never-silently-expand-scope principle in action.*

### 8. User changes their mind

> **User:** Make the export faster.
> **Code Director:** *(plans, gets approval, makes the change, reports: "Export is about 3× faster.")*
> **User:** Actually, I liked how it showed the progress bar before. Can we keep that?
>
> **Code Director:** No problem. I'll keep the speed improvement and bring back the progress bar — it now shows real progress of the background work instead of holding up the export.
>
> If you'd rather undo the whole thing and go back to exactly how it was yesterday, say the word — that's one click.

*Mechanisms: change-batch history with surgical partial revert vs. full rollback, intent layering (new constraint added to completed work), reversible-everything posture.*

### 9. AI makes a wrong assumption

> **User:** When I tap this, it should remember what I was doing.
> **Code Director:** *(interprets "this" as the currently selected notes screen; implements, reports)*
> **User:** No — I meant the camera screen. It keeps losing my photo edits.
>
> **Code Director:** My mistake — I applied it to the notes screen. Here's what I'll do:
>
> 1. Undo the notes change completely (back to exactly how it was).
> 2. Apply the same idea to the camera screen: your photo edits survive when you leave and come back.
>
> Doing both now. I'll tell you when it's done.

*Mechanisms: referential-ambiguity miss, clean recovery via git revert, no defensiveness, restated correct interpretation before re-executing — medium-confidence behavior on retry rather than blind re-assumption.*

### 10. Complex architectural request

> **User:** We're going to need to support video too, not just photos. Probably lots of other stuff later.
>
> **Code Director:** That's an architectural change, so let me lay out what it means before touching anything.
>
> Right now the whole app is built around "a photo." Supporting video — and leaving room for more later — means introducing one shared concept behind the scenes ("a piece of media") and teaching each part of the app to work with that instead of with photos directly.
>
> **What changes:** 11 files across the import, gallery, and export areas.
> **What doesn't:** anything the user sees or does today.
> **Cost:** this is the largest change we've made together; I'd do it in three stages, each one tested and reversible on its own.
>
> Worth it if video is really coming. Not worth it yet if it's a maybe. Which is it?

*Mechanisms: scope-honesty at architectural scale (the system names the size of the request rather than absorbing it), staged plan with per-stage reversibility, and a rare *recommendation against acting* — the director still decides whether the scene is worth shooting.*

### 11. "Just fix it" autonomy grant

> **User:** The tests are failing again. Just fix it, I don't care how.
>
> **Code Director:** On it. *(works silently through diagnosis, fix, test run)*
>
> Done. The failing test expected dates in the old format; I updated the test and the one function still producing it. 2 files. All tests pass now.
>
> ▾ What I changed ▾ Why it broke

*Mechanisms: explicit autonomy grant raising the confidence ceiling (no questions despite "I don't care how" being total scope ambiguity), post-hoc reporting still depth-leveled, collapsible detail preserving the right to audit.*

*Note on depth:* every example above shows Level-1-first communication with expansion available — the reader never had to read a diff, a log, or a mechanism to understand what happened and what to do next.

---

## 25. Feasibility assessment

Brutally honest, in the brief's four buckets plus the fifth it asked for. Every assignment grounded in the research.

**Technically achievable now (engineering, not science):**

- Repo parsing, symbol indexing, call graphs, ranked repo maps — solved ecosystem (tree-sitter/LSP; Aider's repo map). [tree-sitter](https://tree-sitter.github.io/tree-sitter/)
- Agent loop patterns (ReAct, plan-and-execute) and git-native rollback — solved engineering. [IBM ReAct](https://www.ibm.com/think/topics/react-agent), [git patterns](https://aicodingpatterns.com/en/patterns/git-con-ia-desarrollo-asistido/)
- Ambiguity *detection* via behavioral divergence (ClarifyGPT's consistency check) — cheap, engineering-ready, published. [arXiv 2310.10996](https://arxiv.org/html/2310.10996v1)
- Clarifying-question generation good enough to beat baselines — demonstrated (~78–82% preference). [arXiv 2507.21285](https://arxiv.org/pdf/2507.21285)
- Test-in-the-loop verification with rollback-on-red — proven pipelines. [APR survey](https://arxiv.org/html/2506.23749v1)
- Sandboxing at MVP tier (Seatbelt/Docker), MCP integration, context compaction/pruning patterns — all shipping somewhere today. [sandboxing](https://www.digitalapplied.com/blog/ai-agent-sandboxing-isolation-patterns-2026), [context rot mitigations](https://upsolve.ai/blog/context-rot)

**Achievable with significant engineering:**

- The confidence *gate* as a reliable product behavior — the pieces (heuristics, self-consistency, consistency checks) exist, but composing them into a gate with good precision/recall across real projects is quarters of eval-driven tuning, not weeks.
- The attention-budget accounting layer — no literature to copy; the policy must be invented and tuned against telemetry. Direction supported, mechanism novel. [arXiv 2512.19926](https://arxiv.org/pdf/2512.19926)
- Depth-adaptive reporting that rewrites rather than truncates — each level independently readable is an authoring problem at scale, solvable with an output contract + evals but genuinely laborious.
- LSP lifecycle management across heterogeneous language servers. [Serena pattern](https://github.com/cskwork/serena-mcp-quickstart)

**Research-level problems (ship heuristics, publish humility):**

- *Calibrated* "should I act or ask?" confidence — the UQ literature says current benchmarks don't even measure the right thing. [arXiv 2506.07461](https://arxiv.org/html/2506.07461v1), [ICML 2025](https://icml.cc/virtual/2025/poster/40147)
- Question prioritization under an attention budget — which of several ambiguities deserves the user's scarce attention is open; ClarifyCodeBench shows degradation as ambiguity count grows. [arXiv 2607.00711](https://arxivtldr.org/abs/2607.00711)
- Repo-level *semantic* understanding — why code is the way it is (history, invariants, ABI promises) — maintainers document AI systematically missing implicit context. [maintainer analysis](https://dailycodesolutions.com/blog/for-open-source-programs-ai-coding-tools-are-a-mixed-blessing/)
- Repo-level repair with weak test coverage; cost-aware agentic repair. [APR survey](https://arxiv.org/html/2506.23749v1)
- A benchmark for human-collaboration quality (attention cost, trust calibration) — ClarifyCodeBench and CentaurEval are early attempts; there is no accepted standard, which is why Code Director must build its own evals. [ClarifyCodeBench](https://arxivtldr.org/abs/2607.00711)

**Probably unrealistic (do not promise):**

- Reliable silent inference of non-functional intent ("make it feel instant") with no clarification, across arbitrary users and codebases — general intent inference from implicit context remains research-level. [arXiv 2507.21285](https://arxiv.org/pdf/2507.21285)
- Fully autonomous architectural change with correctness guarantees — bad-plan propagation is the known failure mode of plan-and-execute, and re-plan timing is heuristic. [plan patterns](https://nomadx.ae/blog/ai-agent-reasoning-react-plan-execute-tree-of-thought-2026/)
- Sandbox infallibility — CVE-2025-59532 stands as the permanent caveat. [SentinelOne](https://www.sentinelone.com/vulnerability-database/cve-2025-59532/)

**Things that sound impressive but provide little value:**

- Custom vector infrastructure at Cursor scale before evals show retrieval misses; code-graph databases; multi-agent swarms (modest absolute gains, real coordination overhead); fine-tuned classifiers trained on synthetic data before production logs exist; visual "AI presence" (gradients, sparkles, HUDs) — decoration that spends the user's attention budget on the product's vanity; and per-user expertise *profiles* — the brief itself and the depth-as-dimension design (§14) both reject permanent classification in favor of per-message adaptation.

---

## 26. Final verdict

**Is Code Director a new product category, or a nicer UX layer over existing agents?** The honest answer from the research: **neither, and both — it is a new product built on a commoditized substrate, and its category claim rests on exactly one engineered layer.**

The Change/Verify half of the loop is finished. Plan modes, permission tiers, checkpoints, sandboxes, and test loops ship in sixteen tools; building another agent harness would be entering a red ocean with no structural advantage (§5). If Code Director were "Cursor's plan mode with nicer prose," it would be a feature, and the verdict would end there.

But the Intent half is real and unbuilt. The research is unambiguous that the gap is structural, not stylistic: models recognize ambiguity but default to direct answers >95% of the time unless gated [arXiv 2605.25284](https://arxiv.org/html/2605.25284v1); no shipping product has an intent-clarity classifier, a confidence gate on autonomy (only action-risk gates), an attention budget, or adaptive explanation depth (§5); and the academic blueprints for the missing pieces exist and are engineering-ready [ClarifyGPT](https://arxiv.org/html/2310.10996v1), [Darji & Lutellier](https://arxiv.org/pdf/2507.21285). The market serves diff-literate experts and control-free vibe coders; the middle — non-expert intent vocabulary *plus* rigorous control — is empty, and it is empty for structural reasons (incumbents monetize capability demos, not withheld output) as much as technical ones.

**Where the defensibility actually comes from, without fantasy:**

1. **Eval infrastructure as compounding asset.** The product's differentiating claims are behavioral, so they can be measured, gated, and improved on a cadence competitors must match infrastructure-for-infrastructure. The inspiration repo proved the posture is possible at prompt-pack scale; nobody has industrialized it. This is the strongest moat and the least glamorous.
2. **Calibration data.** Every answered (or dismissed) clarification question in production is training signal for the gate — a data flywheel a fast-follower cannot shortcut, and the documented prerequisite for the fine-tuned classifier that beats prompting. [arXiv 2507.21285](https://arxiv.org/pdf/2507.21285)
3. **Design conviction.** Attention budgeting requires shipping *less visible capability* — refusing to show the diff, the plan essay, the tool trace. Incumbents' incentives run the other way. This moat is real but soft: it protects against half-hearted copies, not committed ones.

**The honest threats, restated:** incumbent convergence on clarification UX is a quarter away, not a year; platform hooks mean the gate can exist as a layer on someone else's agent, making Code Director's concept validatable by competitors at low cost; and the calibration core is research-grade, so the product ships heuristics wearing a hard hat — one overpromised launch would discredit the category.

**Bottom line.** Code Director is buildable now, with research-grounded mechanisms for its hard parts and honest heuristics for its open ones. It is not a new category in the sense the agent wave was; it is the first serious productization of *intent engineering* — the pre-coding and post-coding layers the market skipped while racing to automate the middle. The realistic success case: own the "delegation you can actually govern" niche, define the interaction vocabulary (ambiguity gates, attention budgets, depth levels) that becomes standard across all tools within two to three years, and be the reference implementation — and the acquisition target — when it does. The realistic failure case: becoming a well-reviewed feature inside Cursor. Both outcomes start from the same MVP, and the difference between them is execution discipline: the eval harness, the refusal to manufacture confidence, and the willingness to spend engineering on what the user never sees. No unicorn fantasy required — and none claimed.
