---
description: Store the API keys the cli-tools commands need, and see which source is winning.
allowed-tools: Bash(cli-tools:*), Read
---

## Task

Set up, inspect or clear the API keys `cli-tools` commands use.

```bash
cli-tools config                  # what is set, and where each key came from
cli-tools config pull             # import from the logicsrc team vault
cli-tools config set openai       # or by hand; prompts, never echoed
cli-tools config unset openai
cli-tools config --json           # machine-readable, still masked
```

## From the team vault

`cli-tools config pull` is the normal way to set a machine up, and the way a
rotated key reaches one:

```bash
cli-tools config pull
```

It decrypts `profullstack/profullstack-sharable-keys--prod` and imports the keys
these commands use. Override the target with `CLI_TOOLS_VAULT_TEAM`,
`CLI_TOOLS_VAULT_PROJECT`, `CLI_TOOLS_VAULT_ENV`.

Needs the `logicsrc` CLI and a login — `moshcode install secrets`, then
`logicsrc login`. A missing CLI is reported as such rather than as a generic
failure.

**Only the keys these commands read are imported; the rest stay in the vault.**
Pulling a whole vault down would leave a second copy of every team secret on the
machine, drifting from the vault that is supposed to be the authority. This is a
cache of the handful of keys these commands read, not a mirror.

The decrypted `.env` logicsrc writes lives in a `0700` temp directory for the
length of one read and is removed in a `finally`, including on failure.

Keys live in `~/.config/cli-tools/credentials.json`, written `0600` inside a
`0700` directory. `$CLI_TOOLS_CREDENTIALS` overrides the path.

| Key | Variable | Used by |
| --- | --- | --- |
| `openai` | `OPENAI_API_KEY` | `generate-names` |
| `anthropic` | `ANTHROPIC_API_KEY` | `generate-names` |
| `perplexity` | `PERPLEXITY_API_KEY` | `ask-web` |
| `elevenlabs` | `ELEVENLABS_API_KEY` | `tts` |

A key earns a row by being read by a command here, not by being a key the team
owns.

## Never print a key

Nothing here prints a whole key, and neither should you. `config` shows a masked
preview and a character count — enough to tell two keys apart, not enough to use
one — and `--json` carries the same previews rather than the values.

If someone needs the real value, it is in the file; read it deliberately rather
than by running a command that dumps it into a transcript.

## The environment wins

An exported `OPENAI_API_KEY` overrides a stored one, so a one-off
`OPENAI_API_KEY=… generate-names …` and a CI-injected key both still work.

That precedence is the thing that confuses people: you store a key, and the old
one keeps being used, with nothing on screen to say why. So `config` reports the
**source** of each key — `environment (overrides the file)`, `stored`, or
`not set` — and states plainly when a stored value is being shadowed. If a key
looks stored but is not taking effect, that line is the answer; unset the
variable.

## Setting one non-interactively

```bash
printf '%s' "$KEY" | cli-tools config set openai     # piped, no TTY needed
cli-tools config set openai sk-…                     # inline — see below
```

Prefer the pipe. An inline value lands in shell history and is visible in `ps`
to every process on the box for as long as the command runs, which is why the
command warns about it when used interactively.

## What this is not

A machine-local credential store, the same kind of thing as `~/.aws/credentials`
or `gh auth` — one machine's own copy. It is not a `.env`: nothing loads it into
an environment wholesale, nothing syncs it, and it is not how a key travels
between machines. A secret a deployed service needs belongs on that service,
with the vault as the record.
