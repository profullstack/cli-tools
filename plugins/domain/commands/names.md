---
description: Turn a sentence about your product into a thousand candidate names.
allowed-tools: Bash(generate-names:*), Bash(domainfree:*), Write
---

## Task

Generate candidate names from a description, then keep only the ones that can
actually be registered.

```bash
generate-names "a registry that checks whether Lean proofs actually compile" | domainfree
```

Save the survivors when there are many:

```bash
generate-names "a tool that finds dead states in agent graphs" -n 1000 \
  | domainfree > free.txt
```

## How it works, and why it matters

The model is asked for **vocabulary**, not for a thousand names: roughly 40
head words and 40 modifiers, expanded locally into the cross product and
shuffled. That is one cheap API call whether you want 10 names or 10,000.

Asking a model for a thousand names directly is the obvious approach and the
wrong one — it repeats itself within a few hundred, drifts off the brief, and
costs far more for a worse list.

## Choosing well from the output

The generator is deliberately high-volume and low-precision; `domainfree` is
the filter, and you are the judge. Expect most combinations to be noise and a
handful to be good. Worth weighing:

- Does the name say what the thing does, or only gesture at it?
- Would the intended audience recognise the vocabulary? Insider terms are an
  asset with practitioners and a wall with everyone else.
- Read it aloud. If it needs spelling out, it will need spelling out forever.

## Options worth knowing

- `-n 1000` — how many to print. Default is already 1000.
- `--tld dev` — any extension, not just `.com`.
- `--words 1` — single-word names instead of two-word compounds.
- `--seed 42` — the same seed reproduces the same list from the same vocabulary.
- `--provider anthropic` — force a provider; by default it uses whichever of
  `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` is set.

Availability is checked by `/domain:free`, which reads the registry over RDAP
rather than guessing from DNS. Re-check immediately before buying.
