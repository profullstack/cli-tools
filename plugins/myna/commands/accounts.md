---
description: See which accounts are connected, what each network accepts as a login, and what this machine is missing.
argument-hint: [network]
allowed-tools: Bash(myna:*), Read
---

## Task

Report what is connected and what it would take to connect more: `$ARGUMENTS`.

```bash
myna accounts              # connected accounts, keyed network:handle
myna accounts --json       # the same, credentials stripped
myna networks              # all 26, with login method and character limit
myna doctor                # what this machine can and cannot do
```

`myna networks` is the honest answer to "can it post to X": it prints the
current registry with each network's login method and limit, rather than a table
in a README that may have drifted. `doctor` prints the config dir, the network
and account counts, the writer's provider and readiness, and which rasterizers
were found — it takes no flags and has no `--json`.

`accounts` unlocks the vault, so on a passphrase vault it prompts unless
`MYNA_PASSPHRASE` is set; `networks` and `doctor` do not.

## Logging in is the user's to do

**Never run `myna login` for someone, and never ask for the credential to pass
along.** It cannot be scripted anyway: it prompts field by field on the
terminal, there is no flag or environment variable for any credential, and the
OAuth networks open a browser. What it writes is a live token into the encrypted
vault at `~/.config/myna/vault.json`.

What is useful is telling them what that network will ask for, because the cases
genuinely differ:

| How you log in | Networks |
| --- | --- |
| Username and password | Bluesky (app password), Lemmy, Matrix, Mattermost, WordPress (application password), Reddit (script app) |
| A token you paste | Telegram, Discord, Slack, Misskey, Nostr, dev.to, Hashnode, Ghost, Micro.blog |
| A short code you approve | tsbb (device flow) |
| One click in a browser | Mastodon, Pleroma, Akkoma, GoToSocial, Pixelfed — myna registers itself on the instance, so there is no developer account to make |
| App keys | Tumblr |
| Browser OAuth, with an app registered first | X, Facebook, Instagram, Threads, LinkedIn, Pinterest, TikTok |

Network names take aliases, so `twitter`, `bsky`, `fb`, `ig`, `li`, `masto`,
`tg`, `wp` and friends resolve to the real id.

## The failures that look like bugs

- **Mastodon no longer accepts a password at all.** `grant_type=password` was
  removed; a current server answers `unsupported_grant_type`. Use the browser
  flow.
- **Reddit script apps do not work on an account with 2FA**, and a Mastodon
  password grant is refused by instances with 2FA. Both fall back to a token.
- **Facebook and Instagram cannot post to a personal profile**, at all. Facebook
  needs a Page you administer; Instagram needs a Business or Creator account
  linked to one, and it fetches images only from a public URL.

## Disconnecting takes more than it says

`myna logout <account>` matches an **account id or a whole network**, so
`myna logout bluesky` removes every Bluesky account rather than one. There is no
confirmation. Pass the full `network:handle` id, from `myna accounts`, when the
user means one account.

It drops the stored token; it does not revoke anything upstream. A credential
that leaked has to be revoked in that network's own settings.
