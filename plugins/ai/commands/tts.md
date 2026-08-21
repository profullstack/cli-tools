---
description: Read text aloud in a named voice and keep the audio file.
allowed-tools: Bash(tts:*), Read
---

## Task

Turn text into speech and keep the audio.

```bash
tts "the deploy finished"                      # → the-deploy-finished.mp3
mpv "$(tts 'build is green')"                  # the path is the stdout
cat post.md | tts --voice George --out post.mp3
tts --voices                                   # names and IDs in this account
tts "…" --out -                                # audio to stdout, for piping
```

The written path goes to stdout and the byte count to stderr, so `tts` composes
into a shell pipeline without a banner getting in the way.

## Naming a voice

Give a voice as an ID, its full label, or just the human part — the account's
voices are called things like `River - Relaxed, Neutral, Informative`, and
`--voice River` is enough. An ambiguous prefix fails and names the candidates
rather than picking one, because a silent pick would change narrator the day the
account gains a voice.

Run `/ai:tts --voices` first if you are choosing one; the descriptions in the
labels are the only guide to what each sounds like.

## It spends a shared quota

Synthesis bills characters against the team's ElevenLabs account, so:

- **Synthesise once.** Nothing here retries, which means a failed call costs
  nothing twice — but re-running a successful one bills again. Keep the file.
- **Check the text before sending it**, not after. A typo costs the whole
  passage a second time.
- **Do not loop this over a directory** without deciding to out loud first.

`--stability`, `--similarity` and `--style` take 0–1 and are omitted unless
asked for, so the voice keeps whatever it was tuned with in the dashboard.
Leave them alone unless you have a reason: they are account-visible settings,
not per-call preferences.

## Formats

`mp3_44100_128` by default, which anything will play. `--format pcm_24000` and
friends exist for feeding another tool, and the file extension follows the
format so a PCM request never lands in a `.mp3` that nothing can open.

Needs an ElevenLabs key: `cli-tools config set elevenlabs`, or
`cli-tools config pull` from the team vault.
