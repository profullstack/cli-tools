# ai

Two paid APIs that earn a command: a web answer you can check, and speech you
can keep.

`/ai:ask` answers a question from a live web search and prints the pages it
used, numbered to match the `[n]` markers in the answer. `/ai:tts` reads text
aloud in a named voice and writes the audio.

## Install

```bash
moshcode plugin marketplace add profullstack/cli-tools
moshcode plugin install ai@cli-tools
```

Or install the commands directly, without the plugin:

```bash
curl -fsSL https://raw.githubusercontent.com/profullstack/cli-tools/master/install.sh | sh
cli-tools config pull        # imports the Perplexity and ElevenLabs keys
```

## The thing worth knowing

**The citations are the product, and they are only useful if you open them.**
An answer whose `[1]` resolves to nothing is indistinguishable from an answer
that was invented, so `ask-web` numbers the printed list from the response's
positional `citations` field — the one whose order *is* the numbering — and
joins titles on by URL from `search_results`, which arrives in whatever order it
likes. Numbering from the titles would mislabel every source, quietly. When the
answer cites a marker no source backs, that is a warning on stderr rather than a
line silently dropped.

A grounded answer is still a summary of pages that may be wrong or stale. The
citation tells you which page to blame; it is not evidence the page was right.

**`tts` bills a shared account.** Characters come out of the team's ElevenLabs
quota, nothing retries, and a re-run of a successful call bills again — so keep
the file rather than re-synthesising, and do not loop it over a directory
without deciding to.

Both commands read their key from `~/.config/cli-tools/credentials.json`
(`cli-tools config`), and an exported `PERPLEXITY_API_KEY` or
`ELEVENLABS_API_KEY` overrides the stored one.
