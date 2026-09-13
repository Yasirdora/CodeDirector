# Code Director + Grok CLI (community, superagent-ai)

Grok CLI's extension points match Code Director's contracts one-to-one:
MCP servers via settings, SKILL.md skills, and lifecycle hooks that read
JSON on stdin with exit 0 = allow / exit 2 = block — exactly what
`cdir hook` speaks. No code changes needed; this is wiring only.

Prerequisite: the `cdir` CLI v0.3.0+ installed and on your PATH.

## 1. MCP server (the tools)

Edit `.grok/settings.json` in your project (or configure interactively
with `/mcps` in the TUI):

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

## 2. Skill (the rulebook)

Grok CLI reads skills from `~/.agents/skills/` (user level) or
`.agents/skills/` (project level):

```sh
mkdir -p ~/.agents/skills
cp -r <path-to-this-repo>/codedirector/skills/codedirector ~/.agents/skills/
```

Verify with `/skills` in the TUI.

## 3. Hook (the fence)

Edit `~/.grok/user-settings.json` and add a PreToolUse hook. Omitting
`matcher` fires it on every tool call — `cdir hook` self-filters non-edit
tools and always fails open, so this is safe:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "cdir hook",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

## 4. Verify

In a scratch git project, ask for something vague. Pass: the agent drafts
a Vibe Check and waits for approval; an out-of-budget edit gets blocked
with a reason; `/codedirector`-style workflow ends in a Change Report.

## Notes

- Grok CLI is community-built and unaffiliated with xAI; "Grok" is xAI's
  trademark. It also requires a paid Grok API key. For the primary engine
  we recommend Agent CLI (see [../agent](../agent/README.md)); this
  integration exists because the contracts happened to align.
- Grok CLI also merges `AGENTS.md` from the repo root — a viable
  alternative to the skill for project-level rules.
