# AI Coding Landscape 2025–2026 — Competitive Research for "Code Director"

**Purpose:** Competitive research for the "Code Director" product blueprint (plain-language intent in; ambiguity detection + clarifying questions before coding; strict scope control; progressive-depth calm explanations; user attention treated as a finite budget; Intent → Plan → Change → Verify loops).

**Method:** Web research (vendor docs, changelogs, credible third-party reviews, academic literature), September 2026. Every factual claim carries a source URL. Where sources conflict or a claim is marketing-only, it is flagged.

---

## Executive summary

The 2025–2026 AI coding market has converged on a single dominant architecture: an LLM agent loop with tool access (read/edit files, run terminal commands, search), wrapped in one of three surfaces — IDE (Cursor, Windsurf, Copilot, Cline/Roo, Continue, Junie), terminal CLI (Claude Code, Codex CLI, Gemini CLI, Aider, Amp), or async cloud agent (Copilot coding agent, Codex cloud, Jules, Devin, OpenHands).

Three of Code Director's pillars are now **partially commoditized**:

- **Plan-then-execute** exists almost everywhere: Cursor Plan Mode, Claude Code plan mode, Cline Plan/Act, Gemini CLI plan mode, Continue Plan mode, Junie "Advanced Plan Mode," Copilot Plan Mode.
- **Scope control / rollback** exists everywhere in mechanical form: permission modes, approval prompts, allowlists, checkpoints, `/undo`, git worktrees, OS sandboxes, `.rooignore`/read-only files.
- **Verification** exists everywhere: agents run tests/builds/linters and iterate on failures.

What **no** shipping product does:

1. **Formal ambiguity detection with confidence-gated autonomy.** Clarifying questions are an *emergent, optional, model-discretion behavior* inside plan modes — not a system-level gate. Academic work shows base models reliably recognize ambiguity but almost never act on it unless explicitly prompted, and no tool quantifies intent-clarity confidence and ties it to autonomy level.
2. **Attention-budgeted communication.** No tool treats user attention as a resource to be allocated. If anything, the market trends the other way: verbose plans, long diffs, streaming traces. Interruption economics (when is asking worth the user's attention?) are unmanaged everywhere.
3. **Explanation depth as a first-class adaptive system.** Explanation verbosity is a global model behavior or a prompt hack ("explain like I'm five"), not a per-user, per-change adaptive layer with progressive disclosure levels.
4. **A plain-language intent layer for non-experts.** Every agent assumes a user who can review a diff and judge a plan. "Make this loading state feel instant" is genuinely hard input for all of them — they will translate it to a technical interpretation *silently*.

The honest framing: the market has built the **Change** and **Verify** half of Code Director's loop and bolted on **Plan**. Nobody has built the **Intent** half as an engineered system.

---

## Tool-by-tool findings

### 1. GitHub Copilot (incl. agent mode & coding agent)

**Interaction model.** Three layers: (a) inline completions + Next Edit Suggestions; (b) Chat with Ask/Edit/Agent modes in VS Code, JetBrains, Visual Studio, Xcode, Eclipse; (c) the asynchronous Copilot **coding agent**: assign a GitHub issue and it spins up a GitHub Actions environment, works autonomously, and returns a draft PR. Agent mode reached GA through mid-2025; agent mode uses a tool-calling loop (read_file, edit_file, run_in_terminal, etc.) with a system prompt that tells it to keep iterating until done. Sources: https://code.visualstudio.com/blogs/2025/02/24/introducing-copilot-agent-mode , https://github.blog/ai-and-ml/github-copilot/agent-mode-101-all-about-github-copilots-powerful-mode/ , https://www.cloudcontraptions.com/blog/retro-2025-05-copilot-agents/

**Ambiguity / plan.** Copilot added **Plan Mode** (2025) that "creates detailed execution plans before coding"; agent mode "seeks your approval before applying changes." Clarifying questions are not a documented, systematic behavior — plan generation is, but interrogating the user about ambiguous intent is left to the model. Source: https://skywork.ai/blog/ai-agent/catpaw-vs-copilot-vs-cursor/

**Scope control.** Approval gates before edits/commands; MCP- and tool-level allow/deny configuration; `copilot-instructions.md` for conventions; cloud agent output is constrained by GitHub's existing governance — draft PRs, branch protection, required human review ("the agent's PRs needed human approval and couldn't approve themselves"). Sources: https://github.com/orgs/community/discussions/159255 , https://www.cloudcontraptions.com/blog/retro-2025-05-copilot-agents/

**Explanation style.** Chat-oriented; diffs presented per-file in the editor; no adaptive explanation-depth system. Reasoning summaries depend on the selected model.

**Verification.** Agent mode monitors terminal output, test results, build and lint errors and course-corrects autonomously. Source: https://github.blog/ai-and-ml/github-copilot/agent-mode-101-all-about-github-copilots-powerful-mode/

**Pricing/positioning.** Free tier; Pro ~$10/mo; Business ~$19/user/mo; Pro+ $39/mo (1,500 premium requests/mo); Enterprise ~$39/user/mo. Positioning: the default, ecosystem-integrated incumbent. Sources: https://skywork.ai/blog/ai-agent/catpaw-vs-copilot-vs-cursor/ , https://smartscope.blog/en/generative-ai/github-copilot/github-copilot-agent-mode-claude-code-august-2025-update/

### 2. Cursor (Anysphere)

**Interaction model.** AI-native VS Code fork. Tab autocomplete; Cmd+K inline edits; Agent mode (multi-step: search, multi-file edit, run terminal commands, iterate on errors); Cursor 2.0 (Oct 2025) rebuilt the editor around the agent with up to 8 parallel agents isolated via git worktrees, plus background/cloud agents that turn issues into PRs. Sources: https://www.digitalapplied.com/blog/cursor-2-0-agent-first-architecture-guide , https://chiri.ai/chiri-atlas/cursor-anysphere-inc

**Ambiguity / plan.** **Plan Mode** (Oct 2025) is the closest thing to Code Director's intent phase in the market: "Cursor researches your codebase to find relevant files, review docs, and **ask clarifying questions**"; the plan becomes an editable Markdown file with file paths and to-dos; Cursor also auto-suggests plan mode for complex tasks. Crucially, clarifying questions here are a feature of the *plan* flow, not an ambiguity-detection system — there is no confidence gate; the model asks when it feels like it. Source: https://cursor.com/blog/plan-mode

**Scope control.** The strongest mechanical toolkit: command approval with auto-approve only for safe operations, destructive commands need explicit confirmation; complete diff review across all files before applying; one-step undo of an entire agent workflow; checkpoints for rollback to any prior snapshot; 25-tool-call cap before a "Continue" checkpoint; project-directory boundary. Sources: https://www.digitalapplied.com/blog/cursor-2-0-agent-first-architecture-guide , https://chiri.ai/chiri-atlas/cursor-anysphere-inc

**Explanation style.** Plan documents and diff views; no progressive-depth explanation system; verbosity tracks the model.

**Verification.** Auto-runs tests/builds and checks for errors as part of agent loops; Bugbot (July 2025) does AI review on PRs. Sources: https://www.digitalapplied.com/blog/cursor-2-0-agent-first-architecture-guide , https://chiri.ai/chiri-atlas/cursor-anysphere-inc

**Pricing/positioning.** Hobby free; Pro $20/mo (≈225 frontier requests after June 2025 credit switch); Pro+ $60; Ultra $200; Teams $40/user. Positioning: power-user AI-first editor. Sources: https://www.digitalapplied.com/blog/cursor-2-0-agent-first-architecture-guide , https://codegen.com/comparisons/replit-vs-cursor/

### 3. Windsurf (Codeium → Cognition AI)

**Interaction model.** AI-native VS Code fork whose Cascade agent works at project level: describe goal in natural language → Cascade analyzes codebase → builds step-by-step plan → executes edits/commands → user reviews diffs. Sources: https://www.deployhq.com/guides/windsurf , https://therightgpt.com/windsurf-ai/

**Ambiguity / plan.** Cascade generates plans, but reviews characterize Windsurf's philosophy as *high initiative*: "runs shell commands without asking, installs dependencies automatically, makes decisions independently… often executes rm -rf without confirmation" — the cultural opposite of clarification-first. No documented clarifying-question mechanism. Source: https://www.neura.market/directories/md-directory/agents-md-cursor-ai-tips-cursor-vs-windsurf-monp0kjt

**Scope control.** Inline per-change diffs (accept/reject per change); persistent coding rules; but weaker guardrails than Cursor per comparative reviews; `.codeiumignore`-style exclusions. Sources: https://www.deployhq.com/guides/windsurf , https://www.neura.market/directories/md-directory/agents-md-cursor-ai-tips-cursor-vs-windsurf-monp0kjt

**Explanation style.** Diff-centric review; Cascade narrates steps. No adaptive depth.

**Verification.** Runs terminal commands and reacts to output; real-world test: CommonJS→ESM migration of 3,000-line codebase in one attempt with 2/47 test failures. Source: https://codeant.ai/blogs/best-ai-code-editor-cursor-vs-windsurf-vs-copilot

**Pricing/positioning.** Pro from $15/mo, generous free tier; acquired by Cognition AI (Dec 2025, ~$250M) and being merged with Devin. Sources: https://www.neura.market/directories/md-directory/agents-md-cursor-ai-tips-cursor-vs-windsurf-monp0kjt , https://www.taskade.com/blog/windsurf-review

### 4. Claude Code (Anthropic)

**Interaction model.** Terminal-first agent (CLI; plus VS Code extension, JetBrains plugin, web/desktop surfaces). Full agent loop in the user's real environment: read/edit files, run shell, MCP tools, subagents, hooks. Sources: https://coursiv.io/blog/claude-code-plan-mode , https://claude-blog.setec.rs/authors/alon-wolenitz/

**Ambiguity / plan.** **Plan mode** is a *permission mode*, not an interrogation mode: full read access, zero write access; Claude explores and proposes an approach as a plan file (`~/.claude/plans/<session>.md`) before any edit. Enhanced/multi-agent plan mode (v2.0.51+, Nov 2025) uses Haiku subagents for exploration. Asking clarifying questions is model discretion; notable practitioners (Armin Ronacher) bypass plan mode entirely and *manually* build an ask-me-questions workflow ("getting the agent to ask me clarifying questions… iterating until I'm decently happy") — evidence the shipped feature doesn't fully deliver intent clarification. Sources: https://coursiv.io/blog/claude-code-plan-mode , https://claude-blog.setec.rs/authors/alon-wolenitz/ , https://lucumr.pocoo.org/2025/12/17/what-is-plan-mode/

**Scope control.** The most granular permission taxonomy in the market: default (prompt per tool), acceptEdits, plan, **auto** (an AI classifier approves low-risk actions and escalates risky ones; escalates after 3 consecutive or 20 total denials), dontAsk, bypassPermissions; plus AllowedTools allowlists, hooks for pre/post tool policy enforcement, and `--dangerously-skip-permissions` for sandboxes/CI. This is closest to "confidence-gated autonomy" — but the gate is on **action risk**, not on **intent ambiguity**. Sources: https://www.promptt.dev/blog/claude-code-dangerously-skip-permissions , https://coursiv.io/blog/claude-code-plan-mode

**Explanation style.** Streams reasoning + diffs in terminal; users can ask for explanation; no adaptive depth levels. Community complaint surfaces around plan mode token consumption/verbosity. Source: https://claude-blog.setec.rs/authors/alon-wolenitz/

**Verification.** Runs tests/builds; verifier subagent skills ("Verification specialist", "Create verifier skills") formalize verify passes. Source: https://gitee.com/starcn/claude-code-system-prompts?skip_mobile=true

**Pricing/positioning.** Pro $20/mo; Max 5x/20x; API per-token. Positioning: the agentic terminal standard for serious developers. Source: https://coursiv.io/blog/claude-code-plan-mode

### 5. OpenAI Codex (CLI + cloud)

**Interaction model.** Dual surface: (a) local open-source CLI/IDE extension with three approval levels — Suggest (read-only auto, confirm edits/commands), Auto Edit (auto-apply file patches, confirm commands), Full Auto (autonomous inside sandbox); (b) cloud tasks in isolated containers preloaded with the repo, parallel, PR-producing. Approval-policy config adds untrusted/on-failure/on-request/never granularity. Sources: https://deepstation.ai/blog/what-is-openai-codex-the-guide-to-ai-powered-coding-2026 , https://blog.promptlayer.com/how-openai-codex-works-behind-the-scenes-and-how-it-compares-to-claude-code/ , https://community.openai.com/t/codex-vscode-extension-agent-full-access-always-asks-for-approval/1355908

**Ambiguity / plan.** Deliberately *no* big-upfront-plan: "Planning is implicit — Codex is nudged to iterate (read → edit → test) instead of producing a big upfront plan." No clarifying-question system. Source: https://blog.promptlayer.com/how-openai-codex-works-behind-the-scenes-and-how-it-compares-to-claude-code/

**Scope control.** Best-in-class OS-level sandboxing (macOS Seatbelt; Linux Landlock/seccomp or Docker + iptables; network disabled by default in Full Auto), tiered approvals, `/undo`, `/diff`. Note CVE-2025-59532 (sandbox boundary bypass via crafted cwd) — sandboxes are real but not infallible. Sources: https://blog.promptlayer.com/how-openai-codex-works-behind-the-scenes-and-how-it-compares-to-claude-code/ , https://www.sentinelone.com/vulnerability-database/cve-2025-59532/ , https://deepseek.csdn.net/6a2a194e10ee7a33f27abb39.html

**Explanation style.** Auditable patch loop with diffs, logs, citations of terminal output; terse-by-default CLI; reasoning effort configurable. No progressive explanation layer.

**Verification.** System prompt instructs verification via the project's own checks before declaring success; runs tests/linters/typecheckers with evidence in output. Sources: https://blog.promptlayer.com/how-openai-codex-works-behind-the-scenes-and-how-it-compares-to-claude-code/ , https://deepstation.ai/blog/what-is-openai-codex-the-guide-to-ai-powered-coding-2026

**Pricing/positioning.** Bundled with ChatGPT plans (Plus $20/mo etc.); open-source (Apache-2.0) CLI. Positioning: contained, auditable delegation. Source: https://www.morphllm.com/comparisons/jules-google-coding-agent

### 6. Google: Gemini CLI + Jules

**Gemini CLI.**
- **Interaction:** open-source (Apache 2.0) terminal agent; 1M-token context; GEMINI.md hierarchical context; extensions/hooks/subagents; powers Gemini Code Assist in VS Code. Source: https://www.datacamp.com/blog/gemini-cli-vs-claude-code
- **Ambiguity/plan:** plan mode (read-only research and planning until user approves implementation); default-on per DataCamp's comparison; no formal clarification gate. Sources: https://www.datacamp.com/blog/gemini-cli-vs-claude-code , https://www.therundown.ai/tools/gemini-cli
- **Scope control:** approval modes (default / auto_edit / yolo), `--checkpointing` automatic file snapshots + `/restore`, `/rewind` (Esc Esc) for conversation+code, sandbox via gVisor/LXC/macOS Seatbelt. Sources: https://www.datacamp.com/blog/gemini-cli-vs-claude-code , https://tessl.io/blog/gemini-cli , https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/index.md
- **Verification:** runs tests/builds/linters via shell tools. Source: https://www.therundown.ai/tools/gemini-cli
- **Pricing:** generous free tier (1,000 req/day Flash via Google account per DataCamp; official quota pages list 250/day for unpaid API keys — figures vary by auth path). Positioning: the free, open, high-context CLI. Source: https://www.datacamp.com/blog/gemini-cli-vs-claude-code , https://www.therundown.ai/tools/gemini-cli

**Jules.**
- **Interaction:** fully async cloud agent (Google Cloud VM per task); assign task → Jules clones repo, plans, codes → opens a GitHub PR. No editor integration; no real-time pairing. Source: https://www.morphllm.com/comparisons/jules-google-coding-agent
- **Ambiguity/plan:** **shows an editable plan before executing**; Jules 2.0 added "Interactive Plan Mode — asks clarifying questions, proposes execution strategies." This is one of only two products (with Cursor) where clarifying questions are marketed as a named feature — again as plan-mode behavior, not a formal ambiguity gate. Sources: https://www.morphllm.com/comparisons/jules-google-coding-agent , https://xetechai.com/google-jules-2-0-update-review-new-features-reveal
- **Scope control:** file selector to scope tasks to specific files; per-repo memory; environment snapshots; network *enabled* (vs Codex's disabled) so it can install deps. Source: https://www.morphllm.com/comparisons/jules-google-coding-agent
- **Verification:** writes and runs tests; Playwright visual testing with screenshots; critic-augmented generation (self-review loop). Source: https://xetechai.com/google-jules-2-0-update-review-new-features-reveal
- **Pricing:** Free 15 tasks/day / 3 concurrent; AI Pro $19.99/mo (100/day, 15 concurrent); AI Ultra $124.99/mo (300/day, 60 concurrent). Source: https://www.llmreference.com/agent/jules

### 7. Aider

**Interaction model.** Terminal pair-programmer, vendor-agnostic (GPT-5, Claude, Gemini, DeepSeek, Ollama…); every AI change is an **atomic git commit**; three chat modes (`/code`, `/ask`, `/architect`); watch mode reacts to `AI!` / `AI?` comment markers in any editor. Source: https://www.deployhq.com/guides/aider

**Ambiguity / plan.** **Architect mode** splits a strong reasoning model (plans) from a cheap editor model (emits diffs) — plan review before code is touched, and you can `/ask` to debate approach first. But no clarifying-question gate; Aider expects the user to supply precise context (`/add` files). Sources: https://www.deployhq.com/guides/aider , https://www.promptlayer.com/glossary/aider-architect-mode/

**Scope control.** The most *git-native* scope control: atomic commits, `/undo` (git revert), `/read-only <file>` for immutable files, explicit `/add`-based context scoping ("be explicit in your prompts about which files are in scope"). Source: https://www.deployhq.com/guides/aider

**Explanation style.** Minimalist terminal diffs; `/tokens` shows cost; explanation on demand via `/ask`. No adaptive depth.

**Verification.** `/test <cmd>` runs tests and auto-attempts fixes on failure; `/lint` similarly; `/run` shares arbitrary command output. Source: https://www.deployhq.com/guides/aider

**Pricing/positioning.** Free/open-source; user pays model API costs. Positioning: the refined, commit-native CLI for developers who think in git. Source: https://www.deployhq.com/guides/aider

### 8. Continue.dev

**Interaction model.** Open-source VS Code/JetBrains extension + CLI (`cn`); Autocomplete, Edit, Chat, and **three-mode workflow: Chat → Plan → Agent**. Source: https://skywork.ai/skypage/en/Continue.dev-In-Depth-My-Guide-to-the-Future-of-AI-Assisted-Development/1972847152152506368

**Ambiguity / plan.** Plan mode is a "safe, read-only sandbox": read-only tools only (read, grep, glob, web fetch, MCP), cannot edit files or run commands; user switches to Agent mode to execute the co-developed plan. Clarifying questions: not systematic. Source: https://docs.continue.dev/ide-extensions/agent/plan-mode

**Scope control.** Mode-based tool gating is the core control (Chat: no tools; Plan: read-only; Agent: all tools); per-tool approval in Agent mode; model/provider-agnostic including fully local. Sources: https://docs.continue.dev/ide-extensions/agent/plan-mode , https://docs.continue.dev/ide-extensions/agent/quick-start

**Explanation style.** Standard chat + diffs; nothing adaptive.

**Verification.** Agent mode runs commands; no distinctive verify system.

**Pricing/positioning.** Open-source core, free; paid hub/team features. Positioning: the customizable, self-hostable open platform. Source: https://mstone.ai/tools-wizard/continue-dev-features-pricing/

### 9. Cline

**Interaction model.** Open-source agent in VS Code + terminal CLI + JetBrains + headless/CI; **Plan ↔ Act** workflow is the canonical design: Plan mode explores, asks questions, proposes a strategy; Act mode executes with per-step approval or auto-approve. Sources: https://cline.bot/ , https://frontman.sh/blog/roo-code-vs-cline/

**Ambiguity / plan.** Plan mode "asks questions" per docs/reviews — conversational, model-driven; a 2026 GitHub discussion proposes an automatic Plan↔Act review loop with structured handoffs (task ID, allowed changes, excluded changes, acceptance criteria, stop conditions) — notably still a *proposal*, i.e. formal task-bounding is not native. Sources: https://www.qodo.ai/blog/roo-code-vs-cline/ , https://github.com/cline/cline/discussions/12959

**Scope control.** Every file edit/command requires approval unless auto-approve is deliberately enabled; checkpoints + one-click undo per step; `.clinerules` for repo conventions. Sources: https://cline.bot/ , https://frontman.sh/blog/roo-code-vs-cline/

**Explanation style.** Step-by-step diffs; verbose tool-call stream; no attention management — approval fatigue is a known pain.

**Verification.** Monitors linter/compiler output, watches terminal output including long-running dev servers. Source: https://cline.bot/

**Pricing/positioning.** Free/open-source, BYO model key. Positioning: transparent, model-agnostic human-in-the-loop agent. Source: https://cline.bot/

### 10. Roo Code

**Interaction model.** Open-source VS Code agent (Cline fork lineage) organized around **modes**: Architect (plan/design), Code, Ask, Debug, plus user-defined Custom Modes with per-mode models and tool groups. Sources: https://frontman.sh/blog/roo-code-vs-cline/ , https://clearsay.net/learn-to-code-in-2025/

**Ambiguity / plan.** Architect mode for specs/plans; Ask mode for explanation. Modes encode *behavioral roles*, not ambiguity gates.

**Scope control.** `.rooignore` (read/write exclusion lists), checkpoints, Auto-Approve graduated by tool category. Sources: https://github.com/samhvw8/Roo-Cline/blob/main/CHANGELOG.md , https://frontman.sh/blog/roo-code-vs-cline/

**Status caveat:** the Roo Code extension was reportedly shut down May 15, 2026 with the repo archived read-only; community forks (e.g., ZooCode, Kilo Code) carry the mode concept forward. Kilo Code ships Code/Architect/Ask/Debug + custom modes, a "modes marketplace," 400+ models, and usage-based pricing. Sources: https://frontman.sh/blog/roo-code-vs-cline/ , https://skywork.ai/blog/kilo-code-ai-review-2025-vs-code-jetbrains/

**Explanation style / verification.** Diff-based; runs commands; nothing distinctive on explanation depth.

**Pricing.** Free/open-source, BYO keys.

### 11. OpenHands (formerly OpenDevin)

**Interaction model.** Open-source (MIT) autonomous agent platform: describe a task → CodeAct agent loop (plan → write/execute → test → fix → commit) inside a **Docker sandbox** with its own filesystem, shell, browser. Web GUI, CLI, headless mode, Python SDK; 2026 versions orchestrate other agents (Claude Code, Codex, Gemini CLI). Sources: https://www.promptquorum.com/power-local-llm/openhands-review , https://nebuladeck.dev/blog/openhands-coding-agent-guide

**Ambiguity / plan.** Plans internally; "at which point it asks you precisely the right question rather than hallucinating" is claimed by one review (vendor-adjacent, unverified in docs); fundamentally designed for *delegation*, not dialogue — clarification is an exception path when blocked, not a pre-coding gate. Source: https://agentstant.com/tools/opendevin/

**Scope control.** Sandbox isolation is the primary guardrail (architecturally stronger than IDE agents that operate on your live environment); review = PR review. Sources: https://agentstant.com/tools/opendevin/ , https://www.qwe.edu.pl/ai-tools/openhands-open-source-devin-install/

**Explanation style.** Action logs/traces; designed to be checked, not narrated to.

**Verification.** Runs test suites, fixes failures iteratively; SWE-bench Verified SOTA claims (Apr 2025; ~50–77% range reported depending on model/harness/version). Sources: https://www.promptquorum.com/power-local-llm/openhands-review , https://nebuladeck.dev/blog/openhands-coding-agent-guide

**Pricing/positioning.** Open-source free (BYO API keys); OpenHands Cloud managed tiers; Enterprise with RBAC/SSO. Positioning: open "Devin alternative" for delegating scoped tasks. Sources: https://nebuladeck.dev/blog/openhands-coding-agent-guide , https://neuronfeed.com/startups/openhands

### 12. Amp (Sourcegraph)

**Interaction model.** Opinionated CLI-first agent (VS Code extension killed March 2026 to go all-in on CLI; connects to JetBrains/Neovim/Zed via the same binary). No model picker — always frontier models, maximum reasoning; three modes: **Rush** (fast), **Smart** (unconstrained), **Deep** (extended thinking); automatic subagents with isolated contexts; Oracle (a secondary reasoning model) invocable for analysis. Sources: https://devthrottle.com/coding-agents/amp , https://capy.ai/articles/amp-code-vs-capy , https://docs.rhi.zone/normalize/research/ampcode.html

**Ambiguity / plan.** Explicitly anti-knob: "Amp chooses the model stack. You choose how much capability the task deserves." Notably, Amp was reported as **removing** its plan mode (Dec 2025) — betting on agent quality over up-front alignment ceremony. No clarification system. Sources: https://sidbharath.com/blog/amp-code-guide/ , https://lucumr.pocoo.org/2025/12/17/what-is-plan-mode/

**Scope control.** Mode dial (Rush/Smart/Deep) is a capability/cost gate rather than a permission system; AGENTS.md with glob-scoped guidance; subagent isolation. Sources: https://docs.rhi.zone/normalize/research/ampcode.html , https://devthrottle.com/coding-agents/amp

**Explanation style.** Shareable durable threads as team-visible records; Thread Map visualization; the *social* explanation surface is novel, but there's no per-user adaptive depth.

**Verification.** Subagent-based parallel review passes (correctness/security/tests) are a documented workflow. Source: https://sidbharath.com/blog/amp-code-guide/

**Pricing/positioning.** Usage-based credits at cost, no BYOK; free ad-supported tier. Positioning: "uncompromising" agent for developers who trust the vendor's opinions. Sources: https://standardcompute.com/best-ai-agent/amp-vs-devin , https://devthrottle.com/coding-agents/amp

### 13. JetBrains Junie (+ Air)

**Interaction model.** Agent inside JetBrains IDEs + standalone Junie CLI (terminal, CI/CD, GitHub/GitLab); Air is a separate multi-agent orchestration environment (macOS preview). Sources: https://www.jetbrains.com/junie/ , https://devops.com/jetbrains-launches-air-and-junie-cli-to-blend-traditional-ide-with-ai-agents/

**Ambiguity / plan.** **"Advanced Plan Mode":** writes structured plan (requirements, design, delivery stages) before touching code; plans live as editable, committable files in `.junie/plans`; plan and implementation can run on different models. Approve or redirect. Closest to a *documented* plan artifact, but clarifying questions still not systematic. Source: https://www.jetbrains.com/junie/

**Scope control.** Human-in-the-loop review/approve/steer of key actions; dynamic allowlist; user confirms execution; **Live Prompting** (steer mid-task without restarting) — a genuinely distinctive attention/control feature. Source: https://www.jetbrains.com/junie/

**Explanation style.** Structured plan documents; leverages IDE code intelligence for grounding. No adaptive depth.

**Verification.** Agentic debugging (real debugger, breakpoints, runtime state inspection) — deeper verify than run-tests-only agents. Source: https://www.jetbrains.com/junie/

**Pricing/positioning.** AI Pro ~$8.33/mo (10 AI credits/30 days); AI Ultimate $25/mo (35 credits); BYOK at provider rates. Positioning: enterprise-grade agent for the JetBrains installed base. Source: https://www.jetbrains.com/junie/

### 14. Zed agent

**Interaction model.** Fast open-source Rust editor with built-in **agent panel**, edit prediction, and ACP (Agent Client Protocol) to host external agents (Gemini CLI, Claude Code, etc.); local models via Ollama/LM Studio or BYOK; optional git worktree per thread for isolation. Sources: https://github.com/tysoncung/awesome-vibe-coding , https://superset.sh/compare/best-ide-for-ai-agents

**Ambiguity/scope/explanation/verification.** Largely inherits behavior from whichever agent runs through it; native agent supports rules/profiles but no distinctive clarification or explanation-depth system. Positioning: editor-as-agent-host; Pro $10/mo for hosted models. Sources: https://github.com/tysoncung/awesome-vibe-coding , https://superset.sh/compare/best-ide-for-ai-agents

### 15. Devin (Cognition AI) — reference autonomous agent

**Interaction model.** The archetypal fully-autonomous "AI software engineer": tasks assigned via Slack/Linear/web IDE; plans, codes, runs tests, opens PRs in its own cloud sandbox with browser; parallel sessions; machine snapshots and playbooks; interactive planning mode. Sources: https://standardcompute.com/best-ai-agent/amp-vs-devin , https://www.layer3labs.io/guides/devin-ai-explained

**Ambiguity / scope / explanation / verification.** Interactive planning mode exists; fundamentally a delegate-and-review-PR model — clarification happens, if at all, inside its planning step; explanation = PR + session trace. Weaker on "ambiguous, novel tasks" per reviews — precisely Code Director's target input. Source: https://standardcompute.com/best-ai-agent/amp-vs-devin

**Pricing.** Re-priced late 2025 from $500/mo to: Free tier; Pro $20/mo; Max $200/mo; Team $80 base + $40/seat; ACU metering (~$2–2.25/ACU, ~15 min of agent work). Sources: https://www.layer3labs.io/guides/devin-ai-explained , https://rationalgo.ai/resources/app-builder/devin-ai-pricing-vs-rationalgo-500-vs-free-credits

---

## Cross-cutting analysis: the Code Director gap

### What the market has already built (be honest about this)

| Code Director pillar | Closest existing coverage | Verdict |
|---|---|---|
| Intent → Plan → Change → Verify loop | Cursor Plan Mode; Claude Code plan mode; Cline Plan/Act; Junie Advanced Plan Mode; Gemini CLI plan mode; Jules editable plans; Aider architect mode | **Plan is commoditized** as a read-only exploration + editable-plan phase. Intent (deep, dialogic, confidence-scored understanding of what the human means) is not. |
| Scope control / guardrails | Permission modes (Claude Code's 6-tier system), sandboxes (Codex OS-level, OpenHands Docker), checkpoints/undo (Cursor, Gemini CLI, Aider git-native, Cline), allowlists/denylists (.rooignore, AllowedTools, /read-only), worktree isolation (Cursor, Zed) | **Mechanically strong everywhere.** But all of it constrains *what the agent may touch*, not *whether the agent understood you*. |
| Verification | Universal: every serious agent runs tests/builds/linters and iterates. Junie's debugger-integration and Jules' Playwright visual checks go further. | **Commoditized.** |
| Human-readable explanations | Plan markdown files (Cursor, Junie), thread sharing (Amp), PR descriptions (all async agents) | Partial: artifacts exist, but explanation is a byproduct, not a designed layer. |

### The five real gaps

**Gap 1 — Ambiguity detection is an engineered system in nobody's product.**
Where clarifying questions exist (Cursor Plan Mode, Jules 2.0 "Interactive Plan Mode", Cline plan mode), they are emergent LLM behavior inside a planning phase: the model asks if it happens to feel uncertain. No product has (a) an explicit intent-clarity classifier or confidence score, (b) a *gate* that blocks coding below a clarity threshold, or (c) calibrated trade-offs about when asking is worth it. The academic literature confirms this is unsolved at the model level: models "recognize ambiguity but rarely ask clarifying questions" — they can identify ambiguity when explicitly asked to judge it, yet default to direct answers >95% of the time, and adding retrieval context makes them *less* likely to ask (arXiv:2605.25284, "Knowing but Not Showing," Cornell/ICML). A purpose-built clarification pipeline for coding (intent-clarity classifier + fine-tuned question generator) exists only in research (arXiv:2507.21285) and was preferred over baseline in ~80% of user-study ratings. Sources: https://arxiv.org/html/2605.25284v1 , https://www.arxiv.org/pdf/2507.21285

**Gap 2 — Autonomy is gated on action risk, never on intent confidence.**
Claude Code's auto mode (AI classifier approves low-risk actions, escalates risky ones) is the most sophisticated gating in the market, but the classifier evaluates *the action* ("is `rm -rf` dangerous?"), not *the understanding* ("how sure am I that this is what the user meant?"). Code Director's thesis — confidence-gated autonomy where ambiguity in intent lowers the autonomy ceiling — has no shipping analog. Source: https://www.promptt.dev/blog/claude-code-dangerously-skip-permissions

**Gap 3 — Attention is treated as free, and often taxed heavily.**
The market's dominant direction is *more* output: longer plans, parallel agents producing 8 diffs, verbose tool-call streams, per-step approval prompts (Cline/Claude default mode) that produce documented "prompt fatigue leading to reflex approval" — the exact failure mode an attention budget would prevent. Nobody models interruption cost, batches questions, or adjusts communication density to what the user can absorb. The closest adjacent ideas are Cursor's 25-tool-call "Continue" checkpoint (a pacing mechanism, but for cost/review, not comprehension) and Windsurf's high-initiative approach (saves attention by not asking — at the cost of scary autonomy). Sources: https://coursiv.io/blog/claude-code-plan-mode , https://www.digitalapplied.com/blog/cursor-2-0-agent-first-architecture-guide

**Gap 4 — Explanation depth is not adaptive or progressive.**
Every product emits one register: technical. Diff views assume diff literacy. Plan documents assume the reader can evaluate architecture. There is no "explain this change to me at level 1/2/3" system, no per-user model of expertise, no progressive disclosure. The Async agents (Jules, Devin, Copilot coding agent) produce PR descriptions aimed at engineers; nothing serves the "director" who said "make the loading state feel instant" and wants to know, in plain language, what is about to happen and why.

**Gap 5 — The plain-language intent layer for non-experts is structurally absent.**
Every tool's review loop (diffs, plans, test logs) presumes a professional developer. "Vibe coding" products (Replit, Lovable, v0, Bolt — adjacent category) *do* serve non-experts but solve the problem by removing visibility and control entirely (no scope control, no meaningful review, checkpoint-based billing complaints). The middle — non-expert intent vocabulary *plus* rigorous control — is empty. This is Code Director's most defensible positioning: not "agent for people who can't code" (crowded, control-free) and not "agent with a plan mode for engineers" (commoditizing), but **an intent-engineering layer that makes delegation governable for people who can't verify a diff**.

### Strategic implications for Code Director

1. **Don't compete on agent competence** — the loop (edit/run/test/iterate) is a commodity; building another agent harness is entering a red ocean against Copilot/Cursor/Claude Code with zero structural advantage.
2. **The defensible layer is pre-coding and post-coding, not coding:** formal intent-clarity scoring with clarification gates (Gap 1–2), attention-budgeted communication design (Gap 3), adaptive explanation depth (Gap 4). Code Director could plausibly sit *on top of* an existing agent (Claude Code/Codex/Aider as the "camera crew") — the cinematography metaphor is literally an orchestration-layer architecture.
3. **Watch the plan-mode convergence risk:** Cursor, Junie, Jules, and Copilot are all investing in plan UX. If any of them adds systematic clarifying-question gates and simplified plan summaries for non-experts, Gaps 1–2 narrow. The durable moats are the attention-budget model and the non-expert intent vocabulary — those require product and design conviction (a willingness to *not show* the diff), not just a feature flag.
4. **Honest threat:** Claude Code's permission-mode + hooks architecture and Cline's open plugin model both allow third parties to prototype Code Director-like gating today (hooks that block edits until a clarity check passes). The concept is buildable as a layer — which cuts both ways: fast to prototype, hard to keep exclusive.

---

## Appendix: quick-reference table

| Tool | Surface | Plan/clarify | Scope control | Verify | Price (entry paid) |
|---|---|---|---|---|---|
| GitHub Copilot | IDE ext. + cloud agent | Plan Mode (2025) | Approvals, PR governance | Tests/builds in loop | $10/mo |
| Cursor | AI IDE | Plan Mode w/ clarifying Qs | Checkpoints, undo, 25-call cap, diff review | Auto tests + Bugbot | $20/mo |
| Windsurf | AI IDE | Cascade plans (high initiative) | Diffs, rules; weaker guardrails | Terminal feedback | $15/mo |
| Claude Code | CLI (+IDE) | Plan mode (read-only) | 6 permission tiers, hooks, allowlists | Tests, verifier skills | $20/mo |
| OpenAI Codex | CLI + cloud | No upfront plan (iterate) | OS sandbox, 3 approval modes, /undo | Project checks required | $20/mo (ChatGPT Plus) |
| Gemini CLI | CLI (open src) | Plan mode (read-only) | Approval modes, checkpointing, sandbox | Shell tools | Free / $19.99 (AI Pro) |
| Jules | Async cloud | Editable plan + interactive plan mode | File selector, snapshots | Tests + Playwright | Free / $19.99/mo |
| Aider | CLI (open src) | Architect mode (plan/edit split) | Atomic git commits, /undo, /read-only | /test /lint loops | Free + API |
| Continue.dev | IDE ext. (open src) | Chat→Plan→Agent modes | Mode-based tool gating | Commands in Agent | Free |
| Cline | IDE ext./CLI (open src) | Plan/Act (asks Qs in Plan) | Per-step approval, checkpoints | Lint/compiler watch | Free + API |
| Roo Code | IDE ext. (archived 5/2026) | Architect/Ask modes | .rooignore, checkpoints, auto-approve tiers | Commands | Free + API |
| OpenHands | Platform (open src) | Internal plan; asks when blocked | Docker sandbox; PR review | Full test loops | Free + API |
| Amp | CLI | Modes Rush/Smart/Deep; dropped plan mode | Capability dial, AGENTS.md | Subagent review passes | Usage-based |
| Junie | JetBrains IDE/CLI | Advanced Plan Mode (.junie/plans) | HITL approvals, dynamic allowlist, Live Prompting | Agentic debugger | ~$8.33/mo |
| Zed | Editor | Via ACP-hosted agents | Worktree per thread | Inherited | Free / $10/mo |
| Devin | Async cloud | Interactive planning mode | Sandbox, PR review | Tests in sandbox | Free / $20/mo |

*Compiled September 2026. Pricing changes fast in this market; verify before external use.*
