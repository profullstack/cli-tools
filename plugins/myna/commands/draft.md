---
description: Draft a post from a topic or a link. The writer drafts; it never publishes.
argument-hint: <topic or url>
allowed-tools: Bash(myna:*), Read
---

## Task

Draft copy for `$ARGUMENTS`.

```bash
myna draft "the new release"                    # `write` is the same command
myna draft "the new release" --to bluesky --json
myna link https://example.com/post              # fetch the page, draft from it
myna link https://example.com/post --to all
```

`draft` works from a topic or from stdin, `link` from a URL it fetches and
reads. **Neither posts, and neither has a flag that would.** Publishing is
always a separate `/myna:post`.

`--to` here does not choose where anything goes — it narrows which networks are
drafted *for*, so the copy is shaped to their limits and conventions.

## Off unless configured

The writer needs a provider and the user's own key:

```bash
myna config ai.provider anthropic     # or openai, or ollama
myna config ai.model claude-opus-5
myna config ai.voice "Plain, specific, no hype."
myna config ai.maxHashtags 3
```

Anthropic is the default and reads `ANTHROPIC_API_KEY` (or
`ANTHROPIC_AUTH_TOKEN`); OpenAI reads `OPENAI_API_KEY`; Ollama needs no key and
talks to `OLLAMA_HOST`. Without one of those the command refuses rather than
drafting something generic. `myna doctor` says which provider is configured and
whether it is ready.

`ai.voice` is worth setting once. It is the difference between copy that sounds
like the user and copy that sounds like a product launch.

## It drafts, you decide

Show the user the draft and let them edit it. Do not chain `draft` into `post`
in one breath: a model that can both write a post and send it will eventually
send one nobody read, and on most of these networks that cannot be taken back.

A drafted post is also the most likely thing to read as machine-written — the
hashtag pile, the opening rhetorical question, the em dash the user does not
use. Read it as their audience would before offering it.
