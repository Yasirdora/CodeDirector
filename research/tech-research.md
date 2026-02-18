# Code Director — Technical Research

Research for the "Code Director" product blueprint: human-intent-first interaction, formal ambiguity detection & clarification before coding, confidence-gated autonomy, attention-budgeted communication (progressive disclosure), strict change-scope control with rollback, repository-level context intelligence.

Compiled 2026-09-11. Every factual claim carries a source URL. Licenses marked **[verified]** were checked against the project's own LICENSE/COPYING file or repository page; others are marked with the secondary source used.

---

# PART A — Academic / Technical Foundations

## A1. Human–AI collaboration in programming

- **"LLM-Based Human-Agent Collaboration and Interaction Systems: A Survey" (ACL 2026 survey + awesome-list).** A taxonomy of human–agent collaboration covering feedback types (corrective/guidance), interaction modes (delegation, supervision, cooperation, coordination), and orchestration strategies. Relevant coding entries include ConvCodeWorld (conversational code generation with feedback), MINT (multi-turn interaction with tools), and InterCode (interactive coding with execution feedback). Matters to Code Director because it frames the human as *supervisor/director* with distinct feedback granularities — exactly the "director + cinematographer" split. Source: https://github.com/HenryPengZou/Awesome-Human-Agent-Collaboration-Interaction-Systems
- **"Expectation vs. Experience" (Vaithilingam, Zhang, Glassman, CHI EA 2022).** Found Copilot gave a useful starting point but users struggled to understand, debug, and integrate generated code; frequent mismatch between expected and actual usefulness. Directly motivates intent-clarification-before-coding and verification affordances. Source: https://arxiv.org/html/2405.10250v3 (cited therein, §1); original: https://dl.acm.org/doi/10.1145/3491101.3519665
- **"Measuring the Impact of Early-2025 AI on Experienced Open-Source Developer Productivity" (Becker, Rush, Barnes, Rein — METR RCT, July 2025).** 16 experienced OSS developers, 246 real tasks on mature repos: AI-allowed tasks took **19% longer**, while developers *believed* they were ~20% faster (predicted 24% faster beforehand). The perception–reality gap is the durable finding; METR's Feb 2026 follow-up (57 developers) showed mixed/uncertain effects, and METR labels the 19% figure historical for early-2025 tools. Matters because Code Director's value prop — reducing review/correction overhead and the "feels fast but isn't" failure mode — targets exactly the overhead METR measured. Sources: https://www.scienceblog.com (summary), https://devs-group.ch/en/blog/ai-productivity-studies-2026/ (2026 follow-up table)

## A2. Cognitive load in software development and AI tool output

- **"Beyond the Commit: Developer Perspectives on Productivity with AI Coding Assistants" (arXiv, Feb 2026).** Interview study identifying 6 productivity factors; developers report AI output *adds* cognitive load (careful copying, non-determinism requiring repeated re-asking, junior-developer over-reliance). Short-term load reduction vs long-term skill/ownership erosion tension. Source: https://arxiv.org/html/2602.03593v1
- **ICSE-SEIP'26 mixed-methods Copilot study (arXiv 2512.19926).** Field + controlled study in a firm: *moderate* use of either suggestions or chat improved efficiency and reduced perceived workload; *excessive or combined* use eroded the benefit. Strong empirical support for attention budgeting — the amount and mode of AI output must be metered, not maximized. Source: https://arxiv.org/pdf/2512.19926
- **"Assistance or Disruption?" (arXiv 2502.18658, 2025).** Explores proactive (system-initiated) AI programming support and its trade-offs vs user-initiated interaction; verification of proactive output costs significant user effort, and poorly timed proactivity harms workflow. Directly relevant to progressive disclosure timing and confidence-gated interruptions. Source: https://arxiv.org/html/2502.18658v3

## A3. Intent recognition / intent classification for code

- **"Curiosity by Design: An LLM-based Coding Assistant Asking Clarification Questions" (Darji & Lutellier, arXiv 2507.21285, 2025).** Trains (1) an *intent clarity classifier* that detects under-specified coding prompts and (2) a fine-tuned clarification-question generator, in a loop until the prompt is clear or a threshold is hit. Users preferred its answers over baseline in ~78–82% of cases on precision/focus, contextual fit, faithfulness. This is the closest published blueprint for Code Director's "formal ambiguity detection" gate — and shows a trained classifier beats zero-shot prompting. Source: https://arxiv.org/pdf/2507.21285
- **TiCoder (test-driven intent clarification) and CodeLutra (preference-guided refinement)** — cited in the above as the alternative school: infer intent from tests/preference feedback rather than ask. Useful comparison point: clarification-by-tests scales without user turns but can't capture non-functional intent. Source: https://arxiv.org/pdf/2507.21285 (Related Work §2.2)

**Hard vs solved:** Intent *clarity* classification is tractable (trainable classifier with public datasets, per Darji & Lutellier). General *intent inference* from implicit context remains research-level.

## A4. Ambiguity detection and clarifying-question generation

- **ClarifyGPT (Mu et al., arXiv 2310.10996, 2023).** Detects ambiguity via a *code consistency check*: sample n solutions, run them on generated test inputs; divergent behavior ⇒ ambiguous requirement. Then generates targeted questions by comparing the divergent implementations. Raised GPT-4 Pass@1 from 70.96% → 80.80% on MBPP-sanitized; avg 2.85 questions/ambiguous problem. Key design lesson: asking on *every* prompt adds burden and hurts — the detection gate is as important as the questions. Source: https://arxiv.org/html/2310.10996v1
- **ClarifyCodeBench (arXiv 2607.00711, 2026).** Interactive benchmark for clarifying ambiguous coding requirements; headline finding: *strong code generation does not imply strong clarification*, and clarification quality degrades as ambiguity count grows. Means Code Director must evaluate its clarification loop separately from its coding ability. Source: https://arxivtldr.org/abs/2607.00711
- **NLP lineage:** CLARQ / CLARQ-Gen datasets pair user questions with follow-up clarifying queries (cited in Darji & Lutellier §2.3); "Learning to Clarify: Multi-turn Conversations with Action-Based Contrastive Self-Training" (2025) trains proactive clarification. Sources: https://arxiv.org/pdf/2507.21285, https://github.com/HenryPengZou/Awesome-Human-Agent-Collaboration-Interaction-Systems

**Hard vs solved:** Detection via behavioral divergence (ClarifyGPT) and trained classifiers (Darji) are *engineering-ready*. Knowing *which* of several ambiguities is worth one of the user's scarce attention units — question prioritization under an attention budget — is research-level open.

## A5. Agent planning (ReAct, plan-and-execute, etc.)

- **ReAct (Yao et al., ICLR 2023).** Interleaved Thought→Action→Observation loop; grounding each step in observations; failure mode is looping/drift on long tasks. Source: https://www.ibm.com/think/topics/react-agent
- **Plan-and-Execute / Plan-and-Solve (Wang et al., ACL 2023) and ReWOO.** Separate planner (expensive model, runs once) from executor (cheap model, runs many steps); explicit inspectable plan; failure mode is bad-plan propagation unless re-planning. ReWOO pre-plans all tool calls with variable placeholders, cutting token use. Sources: https://aiagentslist.com/blog/react-cot-plan-and-execute-ai-agent-reasoning-patterns-explained, https://nomadx.ae/blog/ai-agent-reasoning-react-plan-execute-tree-of-thought-2026/
- **Design-pattern comparison for agentic systems (engrXiv preprint 6738, 2025/26).** Meta-table across SWE-bench-style benchmarks: HITL + Reflection (human approval gates at irreversible actions) scored highest (SWE-bench ~72.5 vs ReAct 33.2, Plan-and-Execute 48.8 — treat as indicative, single-source preprint). Supports Code Director's confidence-gated autonomy: human gates *before irreversible actions* are the highest-leverage intervention. Source: https://engrxiv.org/preprint/download/6738/11022/9350

**Hard vs solved:** The loop patterns are solved engineering. *When to re-plan vs proceed* and plan-quality estimation remain heuristic.

## A6. Conversational programming

- **"Conversational Programmers" / Programmer's Assistant (Ross et al., IUI 2023, via OpenReview).** Built a conversational assistant on a code-fluent foundation model; found conversation, direct manipulation, and search are *complementary* interaction models with different trade-offs in user attention, context relevance, and follow-up ability. Evidence that conversation is one lens among several — not the whole product. Source: https://openreview.net/pdf/7013617f3be8846705978cdd8217bfbef22edf9d.pdf
- **ConvCodeWorld (ICLR 2025).** Benchmarks conversational code generation in reproducible feedback environments — shows verbal feedback + execution feedback combination outperforms either alone. Source: https://github.com/HenryPengZou/Awesome-Human-Agent-Collaboration-Interaction-Systems
- **InterCode (NeurIPS 2023) and MINT (ICLR 2024).** Standardize interactive coding with execution feedback; multi-turn tool+language feedback measurably improves task success. Source: https://github.com/HenryPengZou/Awesome-Human-Agent-Collaboration-Interaction-Systems

## A7. Explainable AI for code + uncertainty / confidence estimation

- **IntelliExplain (arXiv 2405.10250).** Conversational code generation with proactive explanations for non-professional programmers; explanations of code structure/intent improved understanding and correct usage. Companion work: **Ivie** (Yan et al. 2024) — instant in-situ anchored explanations of generated code; **Nam et al. 2024** — in-IDE on-demand AI explanations. Source: https://arxiv.org/html/2405.10250v3
- **"From Calibration to Collaboration: LLM Uncertainty Quantification Should Be More Human-Centered" (arXiv 2506.07461, 2025).** Reviews 22 UQ benchmarks and finds most are ecologically invalid — they don't measure whether uncertainty info helps *users* make better decisions. Practical methods catalogued: verbalized confidence with calibration tuning (Tian et al. 2023), internal-state calibrators (Mielke et al. 2022), multicalibration (Detommaso et al. 2024). Source: https://arxiv.org/html/2506.07461v1
- **"Uncertainty Quantification Needs Reassessment for Large Language Model Agents" (ICML 2025 position paper).** Argues aleatoric/epistemic dichotomy breaks down for interactive agents; proposes *underspecification uncertainty* (user didn't say enough), interactive learning (ask follow-ups), and *output uncertainty* (express uncertainty in language, not numbers). This is essentially the theoretical license for Code Director's confidence-gated autonomy + clarification loop. Source: https://icml.cc/virtual/2025/poster/40147

**Hard vs solved:** Token-entropy and self-consistency (multi-sample divergence) confidence signals are usable today; *calibrated, user-actionable* confidence that correlates with "should I ask the human?" is research-level.

## A8. Repository-level code understanding

- **"Retrieval-Augmented Code Generation: A Survey with Focus on Repository-Level Approaches" (arXiv 2510.04905, Oct 2025).** Comprehensive taxonomy: graph-based RAG (GraphCoder, CodeGRAG, CoCoMIC, RepoGraph, CodexGraph), agentic retrieval (LocAgent — graph-guided multi-hop reasoning exposed as tools; CodePlan — repo-level planning over dependency graphs). Source: https://arxiv.org/html/2510.04905v1
- **CodePlan (Bairi et al., Microsoft, FSE 2024).** Frames repo-level coding as planning over a dependency graph: build the graph, derive a plan of edits ordered by dependencies, generate with retrieved context. Closest academic analog to Code Director's "repository-level context intelligence" + plan-first flow. Source: https://arxiv.org/html/2510.04905v1 (ref [105])
- **RepoGraph (ICLR 2025)** — repository-level code graph plug-in that boosts AI SE agents. Source: https://arxiv.org/html/2510.04905v1 (ref [20])

**Hard vs solved:** Parsing, symbol indexing, call graphs are solved (see Part B). Faithful *semantic* understanding of why code is the way it is (history, invariants) is not solved — maintainers report AI PRs systematically miss "implicit context" (bug history, ABI promises, invariants). Source: https://dailycodesolutions.com/blog/for-open-source-programs-ai-coding-tools-are-a-mixed-blessing/

## A9. Context management in LLM agents (context rot, compaction)

- **"Context Rot: How Increasing Input Tokens Impacts LLM Performance" (Chroma, Hong/Troynikov/Huber, July 2025).** 18 frontier models (Claude, GPT, Gemini, Qwen families), task difficulty held constant: **every** model degraded as input length grew; degradation begins far below advertised windows (all models degraded on ~113K-token conversational inputs); near-miss distractors compound the damage; coherent-but-irrelevant context hurt *more* than shuffled. Also: "Lost in the Middle" (Liu et al., TACL 2024) U-shaped positional recall; Du et al. (arXiv 2510.05381) show length alone hurts even with perfect retrieval. Sources: https://upsolve.ai/blog/context-rot, https://hivetrail.com/blog/context-rot-chroma-study
- **Mitigations documented:** compaction (rolling summarization), structured external note files, context pruning, just-in-time tool retrieval, sub-agent isolation (sub-agents return condensed summaries). Anthropic's framing: find "the smallest set of high-signal tokens." Sources: https://is.muni.cz/th/y4pmx/thesis.pdf, https://upsolve.ai/blog/context-rot
- **Implication for Code Director:** attention budgeting applies to the *model* as much as the human — repository context intelligence exists precisely to keep prompts small; "index the whole repo and stuff it in" is anti-evidence.

**Hard vs solved:** Compaction/pruning/retrieval patterns are solved engineering; knowing *what* to prune without losing task-critical context is still heuristic.

## A10. Automated program repair (APR)

- **"A Survey of LLM-based Automated Program Repair" (arXiv 2506.23749, 2025).** Taxonomy: fine-tuning (big gains, heavy overfitting to suspected bug location), prompting (few-shot rival specialized systems — Xia et al. 2023), procedural test-in-the-loop pipelines (ContrastRepair: 143/337 Defects4J), agentic (MAGIS multi-agent 16.67% SWE-bench Lite; SWE-Search MCTS 31% GPT-4o / 39% Claude 3.5, expensive). Source: https://arxiv.org/html/2506.23749v1
- **"A Systematic Literature Review on LLMs for APR" (Zhang et al., arXiv 2405.01660, 2024)** and Huang et al. CSUR 2024 taxonomy. Source: https://zhangj111.github.io/files/TSE25_LLM4APR.pdf
- **Relevance:** test-in-the-loop repair is the validation engine for Code Director's change-scope control: a patch that fails tests auto-triggers bounded repair or rollback, never silent expansion of scope.

**Hard vs solved:** Single-function bugs with good tests: largely solved. Repository-level repair with weak test coverage: open; cost-aware agentic repair: open.

## A11. LLM agent evaluation (SWE-bench family)

- **SWE-bench (Jimenez et al., ICLR 2024).** 2,294 real GitHub issues across 12 Python repos; execution-based (fail-to-pass tests), not text similarity. **SWE-bench Verified** (OpenAI, 2024): 500 human-curated instances; the de-facto agent leaderboard. Source: https://arxiv.org/pdf/2603.13258 (§4.1)
- **SWE-bench Pro / Pro Verified (arXiv 2609.08149, 2026).** Demonstrates *evaluation-time reward hacking*: agents recovered gold patches from git history and network sources; anti-hacking controls dropped one model from 78.8% → 57.3%. Critical lesson for Code Director's own eval harness and for sandboxing (block solution leakage channels). Source: https://arxiv.org/html/2609.08149v1
- **Adjacent benchmarks:** Multi-SWE-bench (multilingual), SWE-Lancer (1,400+ freelance tasks), SWE-bench-Live (contamination-resistant refresh), Terminal-Bench, SWE-Perf (performance). Source: https://arxiv.org/pdf/2509.09853, https://arxiv.org/html/2609.08149v1

**Hard vs solved:** Execution-based functional eval is solved and standardized. Evaluating *human-collaboration quality* (attention cost, clarification quality, trust calibration) has no accepted benchmark — ClarifyCodeBench and CentaurEval are early attempts. Sources: https://arxivtldr.org/abs/2607.00711, https://github.com/HenryPengZou/Awesome-Human-Agent-Collaboration-Interaction-Systems

## A12. Research-hard vs solved — summary table

| Capability Code Director needs | Status | Basis |
|---|---|---|
| Parse/index repositories, call graphs | **Solved** (engineering) | tree-sitter/LSP/SCIP ecosystem; Part B |
| Detect under-specified prompts | **Mostly solved** | Darji & Lutellier classifier; ClarifyGPT consistency check |
| Generate targeted clarifying questions | **Mostly solved** | ClarifyGPT, Darji & Lutellier |
| Prioritize which question deserves user attention | **Research-open** | ClarifyCodeBench shows degradation with ambiguity count |
| Calibrated "should I act or ask?" confidence | **Research-open** | ICML 2025 UQ position paper; arXiv 2506.07461 |
| Attention-budgeted progressive disclosure | **Design-space, weak evidence base** | ICSE-SEIP'26 workload study; proactive-support trade-offs |
| Agent loop patterns (ReAct/plan-execute) | **Solved** | Standard frameworks |
| When to re-plan / plan-quality estimation | **Heuristic** | engrXiv pattern survey |
| Context compaction/pruning | **Solved patterns, open policy** | Chroma context rot |
| Repo-level semantic understanding (history/invariants) | **Research-open** | Maintainer-workload analyses; repo-RAG survey |
| Repo-level APR with weak tests | **Research-open** | APR surveys |
| Rollback via git | **Solved** (engineering) | Part B |

---

# PART B — Open-Source Ecosystem

## B1. tree-sitter

- **What:** Incremental, error-tolerant parser generator producing concrete syntax trees for ~100+ languages via community grammars; bindings for Rust/C/Python/JS/etc. https://tree-sitter.github.io/tree-sitter/
- **License:** **MIT [verified]** — fetched LICENSE from tree-sitter/tree-sitter master (Copyright 2018 Max Brunsfeld). https://github.com/tree-sitter/tree-sitter/blob/master/LICENSE
- **Why it matters:** Foundation for AST-aware code chunking (this is what Cursor uses for chunking — https://zzet.org/gortex/how-cursor-indexes-codebase-embeddings-vs-graph/), symbol extraction, edit localization, and structural search. Aider's repo map also uses tree-sitter (via grep-ast).
- **Recommendation:** **Use directly.** De-facto standard, zero legal friction, incremental parsing survives broken mid-edit files.
- **Legal concerns:** None for the core. Individual grammars are separately licensed (mostly MIT); spot-check any grammar you bundle.
- **Limitations:** Syntax only — no name resolution, no cross-file semantics; that's LSP/SCIP territory. Grammar quality varies by language.

## B2. Language Server Protocol & major servers

- **What:** JSON-RPC protocol (Microsoft) decoupling language smarts from editors: go-to-def, references, hover, diagnostics, workspace edits, semantic tokens. Spec: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/
- **Licenses:** rust-analyzer **MIT OR Apache-2.0 [verified]** (https://github.com/rust-lang/rust-analyzer, License section); pyright **MIT [verified]** (fetched LICENSE.txt, Microsoft); TypeScript itself Apache-2.0; gopls BSD-3-Clause (Go project standard) — these two per repository convention, worth a final check before shipping.
- **Why it matters:** LSP gives Code Director *compiler-grade* truth — precise definitions/references/diagnostics — which embeddings cannot. The Serena project demonstrates the pattern: expose LSP as agent tools ("symbol-level" find/edit, 20+ languages, ~30s setup). https://github.com/cskwork/serena-mcp-quickstart
- **Recommendation:** **Use directly / wrap.** Don't build code intelligence from scratch; wrap existing servers as agent tools (Serena is the reference implementation to study — or adopt).
- **Legal concerns:** None major; all major servers permissively licensed. Running servers as subprocesses avoids any linking questions entirely.
- **Limitations:** Per-language server heterogeneity (capabilities differ wildly); lifecycle management (startup latency, crashes, per-project config) is real engineering; servers assume an editor-shaped client.

## B3. ctags (universal-ctags)

- **What:** Generates symbol indexes (names, kinds, scope, signatures) for 100+ languages. https://github.com/universal-ctags/ctags
- **License:** **GPL-2.0 (GPLv2+) [verified]** — fetched COPYING; project discussion confirms the move to consistent "GPLv2+". https://github.com/universal-ctags/ctags/blob/master/COPYING , https://github.com/universal-ctags/ctags/issues/969
- **Why it matters:** Aider's repo map (its key context feature) is built on ctags-style symbol extraction; a lightweight symbol index feeds ranked repo maps that beat naive file-stuffing.
- **Recommendation:** **Study; use only as external process if at all.** tree-sitter covers the same need with a permissive license.
- **Legal concerns:** **GPL-2.0 is the one real licensing hazard in this stack.** Do not link or embed in a proprietary product; invoking the binary as a subprocess and consuming its tags output is the conventional safe pattern (output of a tool is generally not a derivative work), but prefer tree-sitter to make the question moot.
- **Limitations:** Regex/heuristic parsing — less accurate than tree-sitter CSTs; no cross-file resolution.

## B4. Embeddings + vector search for code (LanceDB; Cursor & Sourcegraph approaches)

- **LanceDB:** Embedded, serverless vector DB on the Lance columnar format; in-process, zero-copy, versioning, hybrid (vector + BM25 + SQL filter) search; Python/TS/Rust SDKs. License **Apache-2.0 [verified via multiple independent sources]** (https://github.com/lancedb/lancedb; https://dev.co/ai/vector-databases/lancedb; https://js.langchain.com/docs/integrations/vectorstores/lancedb/). **Recommendation: use directly** if Code Director wants local-first semantic index. Limitations: younger than pgvector/Qdrant; no strict ACID; index tuning (IVF/HNSW) needed at scale.
- **Cursor's published approach:** local AST-aware chunking (tree-sitter), server-side embedding, vectors+obfuscated metadata in Turbopuffer, **Merkle tree of file hashes** for incremental re-sync (~every 5–10 min), content-addressed chunk cache; Cursor claims ~12.5% accuracy gain over grep alone from semantic search; scale: 1T+ vectors across 80M+ namespaces (Turbopuffer case study figures). Sources: https://zzet.org/gortex/how-cursor-indexes-codebase-embeddings-vs-graph/, https://zylos.ai/research/2026-04-19-codebase-intelligence-repository-understanding-ai-agents/, https://riftmap.dev/blog/cursor-monorepo-indexing/
- **Sourcegraph's published approach:** four retrievers combined — keyword (Zoekt trigram index), embedding-based semantic, **graph-based via static analysis (SCIP code graph: definitions/references/implementations)**, and local context (open files, git history). Sources: https://sourcegraph.com/blog/lessons-from-building-ai-coding-assistants-context-retrieval-and-evaluation, https://sourcegraph.com/docs/cody/core-concepts/context
- **Key caveats for design:** embeddings capture *similarity, not relationships* — no resolved call edges, stale-on-edit until re-embedded (needs a Merkle-tree-like freshness pipeline); hybrid retrieval (keyword + vector + graph) consistently beats any single method. Sources: https://zzet.org/gortex/graph-rag-vs-vector-rag-for-code/, https://continuumcode.ai/guides/augment-code-vs-sourcegraph-cody/
- **Recommendation:** LanceDB (local-first) or even simpler: start with BM25/grep + ctags/tree-sitter symbol map; add embeddings only when evals show retrieval misses. Study Cursor/Sourcegraph writeups; do not copy the remote-vector-DB architecture for an MVP.

## B5. Aider

- **What:** Terminal AI pair programmer; repo map (tree-sitter/ctags-based ranked symbol map), git-native auto-commits per change (each AI change a reviewable, revertable commit), 100+ languages, BYO model incl. local. https://github.com/Aider-AI/aider
- **License:** **Apache-2.0 [verified]** — LICENSE.txt on repo (202-line Apache text); corroborated by https://github.com/Sachin7456/ollama-local-coding-agent/blob/main/THIRD_PARTY_NOTICES.md and https://ssojet.com/blog/open-source-ai-coding-agents
- **Why it matters:** Two ideas to take: (1) **repo map as attention-cheap context** — a ranked skeleton of the whole repo in a few thousand tokens; (2) **git-as-rollback done right** — every agent action is a commit, so undo is `git revert`, aligning perfectly with Code Director's change-scope control.
- **Recommendation:** **Study deeply; wrap selectively.** Its edit formats (whole-file / diff / diff-fenced / udiff), lint+test loops, and "read-before-edit" discipline are battle-tested patterns worth re-implementing cleanly rather than depending on the package.
- **Legal concerns:** None (Apache-2.0).
- **Limitations:** Terminal UX; repo map degrades on huge monorepos; exact-string edit matching fails on model-formatted output drift; conversational, not plan-first.

## B6. Continue.dev

- **What:** Open-source IDE assistant (VS Code/JetBrains): autocomplete, chat, agent mode, configurable context providers, fully local via Ollama. https://github.com/continuedev/continue
- **License:** **Apache-2.0** (per https://github.com/Sachin7456/ollama-local-coding-agent/blob/main/THIRD_PARTY_NOTICES.md and https://ssojet.com/blog/open-source-ai-coding-agents; repo states Apache-2.0).
- **Why it matters:** Reference for IDE integration surface (context providers, `@codebase`, inline edit); "allow/ask/exclude" tool-permission model is a simple, shippable precursor to confidence gating.
- **Recommendation:** **Study.** Multiple 2026 sources report the official repo went read-only / maintenance status changed (https://www.eigent.ai/blog/best-open-source-ai-coding-agents-2026) — do not build a dependency on its roadmap.
- **Legal concerns:** License fine; maintenance risk is the real concern.
- **Limitations:** Extension-form complexity; context retrieval (their docs/defaults) is embedding-heavy and pluggable but not deeply structural.

## B7. Cline

- **What:** Most-starred open IDE agent (66k+ stars): Plan/Act modes, per-edit and per-command human approval, checkpoints, browser use, first-class MCP support; JetBrains/Zed/Neovim/CLI by 2026. https://github.com/cline/cline
- **License:** **Apache-2.0** (https://ssojet.com/blog/open-source-ai-coding-agents, "verified 2026-06-07"; https://www.morphllm.com/ai-coding-agent).
- **Why it matters:** The **Plan/Act split + approval-per-action + checkpoints** UX is the market-validated baseline that Code Director's confidence-gated autonomy must beat or formalize. Plan mode is literally "clarify & plan before coding" — validate against it.
- **Recommendation:** **Study + benchmark against; wrap only if building a VS Code extension MVP.**
- **Legal concerns:** None (Apache-2.0).
- **Limitations:** Token-hungry autonomy on large tasks; approvals are per-action binary (no confidence semantics — the gap Code Director fills); context management is append-and-truncate.

## B8. Roo Code

- **What:** Cline fork adding multi-mode workflows (Code/Architect/Ask/Debug + custom modes), 500+ model support. https://github.com/RooCodeInc/Roo-Code
- **License:** **Apache-2.0** (https://ssojet.com/blog/open-source-ai-coding-agents).
- **Why it matters:** The mode system shows role-separation UX (plan in Architect, execute in Code) mirroring plan-and-execute agent architecture.
- **Recommendation:** **Study only.** One source reports Roo Code archived in 2026 (https://whitepapers.openzeka.com/papers/yerel-llm-rehberi/) — treat maintenance status as **unverified/uncertain**; either way, fork-lineage risk argues against depending on it.
- **Legal concerns:** None (Apache-2.0).
- **Limitations:** Mode-system complexity/learning curve; inherits Cline's token economics.

## B9. OpenHands (formerly OpenDevin)

- **What:** Full autonomous SE agent platform: sandboxed Docker execution runtime, CLI/web/server, CodeAct action space, micro-agents, evaluation harnesses; 68.4% SWE-bench Verified with Claude Opus 4.6 + CodeAct v3 scaffold. https://github.com/All-Hands-AI/OpenHands
- **License:** **MIT** (https://github.com/Sachin7456/ollama-local-coding-agent/blob/main/THIRD_PARTY_NOTICES.md; https://ssojet.com/blog/open-source-ai-coding-agents; SourceForge comparison).
- **Why it matters:** Best open reference for (a) **sandboxed execution backend abstraction** (Docker/VM/local/remote runtimes behind one interface), (b) event-stream architecture where every action/observation is logged — a natural substrate for audit + rollback, (c) stuck/loop detection (`StuckDetector`).
- **Recommendation:** **Wrap for the execution sandbox; study the event-sourced loop.**
- **Legal concerns:** None (MIT).
- **Limitations:** Heavyweight (runtime image management); unsandboxed "local" mode can expose host files (documented risk, https://www.eigent.ai/blog/best-open-source-ai-coding-agents-2026); designed for autonomy-first, not director-first interaction.

## B10. SWE-agent

- **What:** Research agent from Princeton: Agent-Computer Interface (ACI) design — custom command set, linter-gated edits, constrained viewer — showing *interface design for agents* matters as much as model quality (NeurIPS 2024 paper). https://github.com/SWE-agent/SWE-agent
- **License:** **MIT** (THIRD_PARTY_NOTICES link above; https://www.eigent.ai/blog/best-open-source-ai-coding-agents-2026).
- **Why it matters:** The ACI paper is the canonical argument that *tool ergonomics shape agent performance* — directly applicable to designing Code Director's edit/query tool surface (e.g., lint-on-edit, scoped file viewer).
- **Recommendation:** **Study the paper; reuse `mini-swe-agent` (~100-line harness) for internal evals** — it's also the harness used in SWE-bench Pro Verified evaluations (https://arxiv.org/html/2609.08149v1).
- **Legal concerns:** None (MIT).
- **Limitations:** Research-grade, not a product shell; Python-centric benchmark orientation.

## B11. MCP (Model Context Protocol)

- **What:** Open standard (Anthropic, launched 2024-11-25) for connecting agents to tools/data: servers expose tools/resources/prompts; JSON-RPC 2.0 over stdio or streamable HTTP. Donated 2025-12-09 to the **Agentic AI Foundation (Linux Foundation)** alongside Block's goose and OpenAI's AGENTS.md; 10k+ public servers at donation (21k+ by mid-2026), ~97M monthly SDK downloads; adopted by Claude, ChatGPT, Gemini, Copilot, Cursor, VS Code. Sources: https://agenticcommerceprotocol.info/standards/mcp, https://github.blog/open-source/maintainers/mcp-joins-the-linux-foundation-what-this-means-for-developers-building-the-next-era-of-ai-tools-and-agents/, https://gingerlabs.ai/blog/mcp-adoption-timeline
- **License:** **MIT** (https://agenticcommerceprotocol.info/standards/mcp).
- **Why it matters:** Makes Code Director's tools interoperable in both directions: consume third-party MCP servers (git, test runners, browsers) and *expose* Code Director itself as an MCP server for IDEs. Linux Foundation governance removes rug-pull risk.
- **Recommendation:** **Use directly** as the tool-integration bus.
- **Legal concerns:** None (MIT, foundation-governed).
- **Limitations:** Third-party server quality/security varies (supply-chain risk); auth/RBAC layers are still maturing (https://www.digiall.com.mx/blog/digiall-tech-news-3/anthropic-donates-model-context-protocol-to-linux-foundation-under-new-agentic-ai-32). Treat remote servers as untrusted input.

## B12. Sandboxing options

Tiered by isolation strength (source: https://www.digitalapplied.com/blog/ai-agent-sandboxing-isolation-patterns-2026):

| Tier | Tech | License | Notes |
|---|---|---|---|
| OS process | macOS Seatbelt (`sandbox-exec` / SBPL profiles), Linux bubblewrap+Landlock+seccomp | Seatbelt: macOS built-in (proprietary OS, free to use); bubblewrap: LGPL | ~0ms overhead; no kernel isolation. Claude Code's Sandboxed Bash uses Seatbelt on macOS / bubblewrap on Linux. Practical guide: https://alejandromp.com/development/blog/sandboxing-an-ai-harness-on-macos |
| Container | Docker (default seccomp profile, cap-drop, no-new-privileges, network off) | Docker Engine: Apache-2.0 | Shares host kernel — insufficient alone for untrusted code, fine with approvals + read-only mounts |
| User-space kernel | **gVisor (`runsc`)** | **Apache-2.0** (https://www.digitalapplied.com/blog/ai-agent-sandboxing-isolation-patterns-2026) | Sentry intercepts syscalls in Go; x86_64/ARM64; used by Google Cloud Run; middle ground |
| MicroVM | **Firecracker** (KVM, <1s boot, sub-second snapshots) | **Apache-2.0** (AWS; E2B maintains an Apache-2.0 fork — same source) | 2026 baseline for untrusted agent code (E2B, Vercel Sandbox); Linux hosts only |
| Full VM | Lima/Apple Virtualization/QEMU | varies | 30s+ provision; compliance tier |

- **Ecosystem watch:** purpose-built agent sandboxes proliferated in 2025–26 (microsandbox/libkrun, cplt — Seatbelt+Landlock single binary, Anthropic's experimental sandbox-runtime, matchlock). Curated list: https://github.com/bureado/awesome-agent-runtime-security
- **Recommendation (MVP):** **macOS Seatbelt profile + command approval tiers** for the desktop product (zero-dependency, same approach Claude Code ships); **Docker with hardened flags** for headless runs; graduate to gVisor/Firecracker only when running untrusted multi-tenant workloads. Key documented gaps regardless of tier: network egress = exfiltration channel; writable mounts = code-modification channel (per Anthropic's own stated limitations, same source above).

## B13. Git-as-rollback

- **What:** Rollback/checkpoint strategies used by shipping agents: Aider commits every AI change (revert = `git revert`); Claude Code 2.0 auto-checkpoints before each AI edit with `/rewind` restoring code and/or conversation (limitation: terminal side-effects — installs, pushes, API calls — are not reverted; session-scoped, not durable); Cline checkpoints; `git worktree` per-task isolation for parallel agents; community request for stash/branch-based checkpoints (claude-code issue #6001).
- Sources: https://www.mindstudio.ai/blog/claude-code-rewind-command-rollback, https://github.com/anthropics/claude-code/issues/6001, https://aicodingpatterns.com/en/patterns/git-con-ia-desarrollo-asistido/, https://parallelcode.dev/blog/claude-code-git-worktree
- **Recommendation:** **Use directly — make git the spine of change-scope control.** Concrete design: (1) require a clean tree or auto-snapshot before agent turns; (2) one commit per accepted change-batch with structured message (intent, scope, confidence); (3) rollback = revert to checkpoint, conversation-aware like `/rewind`; (4) document that rollback cannot undo external side-effects — gate those behind approval; (5) worktrees for concurrent agent tasks.
- **Legal concerns:** None. **Limitations:** dirty-tree/merge conflicts on interrupted sessions; untracked-file handling; developers' own uncommitted work mixing with agent work — snapshot must capture both.

## B14. Test-runner integration

- **What:** Agents need execution feedback: run tests, parse results, feed failures back (test-in-the-loop APR, §A10). Practical pieces: pytest's JSON/JUnit output, `gotestsum`, Jest `--json`, nextest (cargo); universal JUnit XML parsing; SWE-bench harnesses (`mini-swe-agent`) show the minimal loop.
- **Recommendation:** **Build a thin language-detecting test-runner adapter** (detect project type → run → parse → classify fail-to-pass/pass-to-pass), behind an MCP tool. Tie results to the confidence gate: green tests raise effective autonomy; red tests trigger bounded repair, then rollback — never scope expansion.
- **Limitations:** flaky tests poison the feedback loop (quarantine + retry budgets); long suites need selection (test-impact analysis via the symbol/call graph from B1/B2); sandboxing (B12) decides where tests run.

## B15. What genuinely helps vs overengineering for an MVP

**Genuinely helps (build/adopt now):**
1. tree-sitter for chunking + symbol extraction (B1)
2. LSP-or-ctags symbol map → ranked repo map (Aider's lesson; B2/B3/B5)
3. git-native checkpoint/rollback as a first-class feature (B13)
4. Plan/Act separation with an explicit ambiguity gate before coding (ClarifyGPT-style consistency check is cheap; §A4)
5. Test-in-the-loop validation with rollback-on-red (B14)
6. Seatbelt/Docker sandboxing at MVP scale (B12)
7. MCP for tool integrations (B11)
8. Context discipline: small curated context beats big context (Chroma context rot; §A9)

**Overengineering for an MVP (defer):**
1. Custom embedding + vector DB infrastructure (Cursor-style Merkle pipeline) — start with symbol map + grep/BM25; add LanceDB only when evals demand it (B4)
2. Full code-graph database (SCIP/RepoGraph-style) — LSP on demand gets 80% of the value
3. Firecracker microVM fleet — until multi-tenant/untrusted workloads
4. Multi-agent orchestration (MAGIS-style role swarms) — coordination overhead, modest absolute gains (§A10)
5. Fine-tuned intent-clarity classifier — start with prompting + consistency check; fine-tune only with logged production data (§A3)
6. Custom agent framework — wrap OpenHands runtime or a mini-swe-agent-style loop instead

---

# Appendix — License verification ledger

| Project | License | Verification |
|---|---|---|
| tree-sitter | MIT | Fetched LICENSE from repo master |
| universal-ctags | GPL-2.0 (GPLv2+) | Fetched COPYING; confirmed by project issue #969 |
| rust-analyzer | MIT OR Apache-2.0 | Repo License section |
| pyright | MIT | Fetched LICENSE.txt |
| gopls | BSD-3-Clause | Go project convention — re-check before shipping |
| TypeScript | Apache-2.0 | Microsoft project convention — re-check before shipping |
| LanceDB | Apache-2.0 | Repo + LangChain docs + independent directories |
| Aider | Apache-2.0 | Repo LICENSE.txt (Apache text) + 3 corroborating sources |
| Continue | Apache-2.0 | THIRD_PARTY_NOTICES + ssojet comparison; note maintenance status change reported 2026 |
| Cline | Apache-2.0 | ssojet (verified 2026-06-07) + morphllm |
| Roo Code | Apache-2.0 | ssojet; note: one source reports archived in 2026 — unverified |
| OpenHands | MIT | THIRD_PARTY_NOTICES + ssojet + SourceForge |
| SWE-agent | MIT | THIRD_PARTY_NOTICES + eigent.ai |
| MCP spec/SDKs | MIT | agenticcommerceprotocol.info standards page; Linux Foundation AAIF governance (github.blog) |
| gVisor | Apache-2.0 | digitalapplied.com tier guide |
| Firecracker | Apache-2.0 | AWS project; E2B Apache-2.0 fork (digitalapplied.com) |
| Docker Engine | Apache-2.0 | docker/docker repo (widely documented) |
| bubblewrap | LGPL-2.0+ | containers/bubblewrap repo (widely documented) — dynamic linking/subprocess use only |
