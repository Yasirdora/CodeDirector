# Code Director + Gemini CLI

Two hooks make Gemini CLI follow the Code Director workflow: the MCP server
(gives it the tools) and a context file (tells it the rules). Use both.

## 1. Register the MCP server

From any project directory where you want the guardrails:

```sh
gemini mcp add codedirector cdir -- mcp
```

This writes to the project config `.gemini/settings.json` by default. To make
it available in every project, use user scope:

```sh
gemini mcp add codedirector -s user cdir -- mcp
```

Verify inside a Gemini session with `/mcp` — `codedirector` should appear
with its eight tools (`repo_map`, `blast_radius`, `lock_draft`, `lock_check`,
`lock_activate`, `run_locked`, `report`, `undo`).

Notes:

- Leave `trust` off (the default). Tool-call confirmations are a feature:
  you see each scope-related action as it happens. Add `--trust` only if the
  prompts get in your way — the server is local and read-only except for the
  files a run touches.
- The equivalent hand-edited config block, if you prefer editing
  `settings.json` yourself:

  ```json
  {
    "mcpServers": {
      "codedirector": {
        "command": "cdir",
        "args": ["mcp"]
      }
    }
  }
  ```

## 2. Drop in the context file

Gemini CLI reads `GEMINI.md` at the project root as standing instructions.
Copy [GEMINI.md](GEMINI.md) from this directory into your project root (or
merge its contents into your existing one). It states the workflow: draft
the scope, wait for approval, work inside the fence, report from evidence.

## 3. Prove it works — the before/after test

Same engine, same vague prompt, twice:

1. **Without the hooks** (fresh project, no MCP, no GEMINI.md): ask for
   something vague — "create something better than AnkiMobile". Watch it
   choose a stack, scaffold, and start services without asking.
2. **With the hooks** (MCP registered + GEMINI.md in place): same prompt.
   It should draft a Vibe Check, show you goal/budget/deny list, and wait
   for your yes before touching a file. Afterwards, `cdir report IL-0001`
   gives you the receipt.

If step 2 still sprints off without drafting the lock, run `/mcp` to confirm
the server is connected and check that `GEMINI.md` sits at the project root
you launched `gemini` from.
