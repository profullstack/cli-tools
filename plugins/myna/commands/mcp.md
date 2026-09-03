---
description: Give an agent the same vault over MCP — ten tools, and deliberately no login.
argument-hint: [claude|json]
allowed-tools: Bash(myna:*), Read, Write
---

## Task

Point an agent at myna over MCP.

```json
{ "mcpServers": { "myna": { "command": "bunx", "args": ["@profullstack/myna-mcp"] } } }
```

**There is no `mcp` subcommand on the `myna` binary** — `myna mcp` exits with
`Unknown command "mcp"`. The server is its own package,
`@profullstack/myna-mcp`, and its bin is a TypeScript file with a `bun` shebang,
so **Bun is required for this** even though the CLI itself is a compiled binary
that needs nothing.

It reads the same vault at `~/.config/myna` that the CLI, the TUI and the
desktop app read, so an account connected in any of them works in all of them
and there is nothing to connect twice.

## Ten tools, and the ones that are missing

`myna_accounts`, `myna_networks`, `myna_preview`, `myna_post`, `myna_schedule`,
`myna_queue`, `myna_cancel`, `myna_history`, `myna_draft`, `myna_timeline`.

There is no `myna_login`, no `myna_logout` and no `myna_delete`. The login
omission is the deliberate one: connecting an account means typing a password or
completing a browser flow, and that belongs to a person. An agent that could log
in could be talked into logging in somewhere else.

## What to tell the agent about `myna_post`

It publishes immediately, and on most of these networks it cannot be undone. Its
description says so. `myna_preview` is the tool that shows the targets and the
per-network tailoring first, and it is the better one here than the CLI's
`--dry-run`, which only resolves targets and does no per-network rendering at
all.

Worth stating explicitly in whatever prompt drives it:

- Name targets. The default is every connected account, on all 26 networks.
- `myna_preview` before `myna_post`, every time.
- A draft is text for a human to approve, not a post that is one call away.

## Before handing it to something unattended

This is a credential-holding server: the vault behind it has a live token for
every connected account. The config that launches it belongs on the machine that
owns that vault — not in a repo, a screenshot or an issue.

The same tools are served over HTTP by myna's own API app, where writes are
refused outright without `MYNA_API_TOKEN` rather than left unauthenticated. If
what you want is cron rather than an agent, that is the door.
