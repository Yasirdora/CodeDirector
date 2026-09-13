# Code Director + Grok Build (official xAI CLI)

This guide is for the **official Grok CLI** from xAI (the `grok` binary,
docs under `~/.grok/docs/`). If you use the community-built
`superagent-ai/grok-cli` instead, see [../grok](../grok/README.md).

Grok Build has every extension point Code Director needs: MCP servers,
SKILL.md skills, and PreToolUse hooks that read a JSON decision from
stdout — the same contract `cdir hook` speaks. This is wiring only, no
code changes.

Prerequisite: the `cdir` CLI v0.3.0+ installed and on your PATH
(`cdir --version` to check).

## 1. MCP server (the tools)

```sh
grok mcp add codedirector -- cdir mcp
```

Verify with `grok mcp list`. In a session, `/mcps` shows it too.

## 2. Skill (the rulebook)

```sh
mkdir -p ~/.grok/skills
cp -r <path-to-this-repo>/codedirector/skills/codedirector ~/.grok/skills/
```

User-level skills in `~/.grok/skills/` are always trusted and load in
every project. (Project-level `.grok/skills/` also works, but repo-local
hooks, skills, and MCP servers need trust via `/hooks-trust` first.)

## 3. Hook (the fence)

```sh
mkdir -p ~/.grok/hooks
cat > ~/.grok/hooks/codedirector.json <<'EOF'
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          { "type": "command", "command": "cdir hook", "timeout": 10 }
        ]
      }
    ]
  }
}
EOF
```

No `matcher` on purpose: an omitted matcher fires on every tool call,
and `cdir hook` self-filters — non-edit tools pass through instantly and
any error fails open, so it can never brick a session. Global hooks in
`~/.grok/hooks/` are always trusted.

## 4. Verify

1. Run `grok inspect` in a scratch git project — it should list the
   codedirector MCP server, the skill, and the hook.
2. In that project, ask for something vague ("make the preview feel
   instant"). Pass: the agent drafts a Vibe Check and waits for your
   approval before editing.
3. After approving, ask for a change outside the approved files. Pass:
   the edit is blocked and the agent sees the reason.

## Notes

- On a block, Grok Build shows the deny reason to the model, so the
  agent can pick an in-scope alternative on its own.
- The "no active Vibe Check" reminder is delivered as `additionalContext`,
  which Grok Build shows to the model *after* the tool call, not before.
  The fence still holds — anything out of scope is denied outright — but
  on a fresh project with no Lock, expect the reminder to land right
  after the first edit rather than ahead of it.
- For the primary engine we recommend Agent CLI (see
  [../agent](../agent/README.md)); this integration exists so the same
  workflow follows you into Grok Build sessions.
