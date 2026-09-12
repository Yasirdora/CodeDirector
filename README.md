<div align="center">
  <h1>Code Director</h1>
  <p><strong>Human Intent → Verified Execution</strong></p>
</div>

<br />

> **Code Director** is a research and product blueprint for an vibe-checked AI agent system. It shifts the paradigm from *generating more code* to *trusting generated code*. 

Every agent on the market is racing to produce more change per minute. The binding constraint, however, is **how much change a human can afford to trust per minute.** Code Director raises the second number by mechanically discharging most of the reviewer's obligation and honestly naming the remainder.

---

## 🧭 The Core Thesis

Code Director operates on two foundational layers:

1. **The Intent Layer**: Formally detects ambiguity before acting and budgets the human's attention. The system establishes whether it actually understood what the human said *before* it writes a single line of code.
2. **The Verification Layer**: Compiles intent into an enforceable contract — an **Vibe Check** — and reports every outcome with typed evidence. 

The human states what must be true. The system finds out whether it is. Every change is reported with explicit, typed evidence: what was **Measured**, what was **Proven**, what is merely **Asserted**, and what remains **Unchecked**.

## 🏗️ Repository Architecture

This monorepo contains the three pillars of the Code Director ecosystem, alongside the definitive product blueprints.

### 📦 Components

* 🛡️ **[`codedirector/`](./codedirector/)**: The core CLI package. This contains the scope enforcement mechanisms, the verification engine, and the Vibe Check model.
* 🔬 **[`intent-experiment/`](./intent-experiment/)**: The testbed and evaluation harness. This environment runs the experimental loops for intent clarification, measuring how well the system detects ambiguity and asks clarifying questions.
* 📚 **[`research/`](./research/)**: The foundational research dossiers. Includes a deep market landscape study of 16 existing tools and comprehensive academic/open-source technical surveys.

### 📜 Blueprints

The theoretical and architectural foundations of this project are detailed in the following documents. Every factual claim carries a citation to a source URL.

* 📖 **[CODE-DIRECTOR-v0.2.md](./CODE-DIRECTOR-v0.2.md)**: The definitive v0.2 product blueprint. Merges the intent layer (doc A) with the verification layer (doc B).
* 📄 **[CODE-DIRECTOR.md](./CODE-DIRECTOR.md)**: The original v0.1 research and product blueprint.

---

## 📐 Core Principles

1. **Evidence over assertion.** Never claim a behavioral outcome without naming how it was checked.
2. **The negative space is the contract.** Every task carries an explicit `KEEP` set — what must *not* change. This is enforced, not encouraged.
3. **Format must not manufacture content.** No output contract may require a field the evidence cannot fill.
4. **Attention is a finite resource.** Optimize for confident decisions per unit of human attention.

<br />

*For detailed instructions on running the tools, reproducing the experiments, or reviewing the market studies, please navigate to the specific `README.md` files located inside each sub-directory.*
