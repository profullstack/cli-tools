# myna

[myna](https://mynaposter.com) from the terminal, as slash commands. One vault,
26 social networks: write once, send it or queue it, and read back what landed
and what failed.

| Command | Does |
| --- | --- |
| `/myna:post` | Send a post to one network, several, or every connected account. |
| `/myna:schedule` | Queue a post for later, and run the sender that delivers it. |
| `/myna:queue` | Read the queue and cancel something before it goes. |
| `/myna:accounts` | See what is connected, what each network accepts, and what is wrong. |
| `/myna:feed` | Read a timeline, the history of what was sent, and the engagement. |
| `/myna:draft` | Draft copy from a topic or a link. It never posts on its own. |
| `/myna:infographic` | Render a graphic whose text is exactly the copy chosen for it. |
| `/myna:mcp` | Give an agent the same vault over MCP, without a login tool. |

## Install

```sh
moshcode plugin marketplace add profullstack/cli-tools
moshcode plugin install myna@cli-tools
```

The `myna` binary itself is a [companion](../../README.md#install) of this set,
so `cli-tools link` already put it on PATH. On a box without the checkout:

```sh
curl -fsSL https://mynaposter.com/install.sh | sh
```

One compiled binary with its runtime inside — no Node, no Bun, nothing to
install first. Then connect an account yourself, once: `myna login <network>`.

## Why this is a plugin and not a command here

`cli-tools` installs `myna` but does not implement it, and this plugin does not
change that. myna ships from
[profullstack/mynaposter](https://github.com/profullstack/mynaposter) on its own
release cycle as a compiled binary; a second executable of that name from this
repo would be two implementations on `PATH` drifting apart — the state
`cli-tools list` marks with `!`.

What the plugin adds is the judgement a posting tool needs when an agent is
holding it: what to check before something goes out in public, which parts are
the user's to do, and which reads cost nothing.

## The three things worth knowing

**The default target is every account you have.** `settings.defaultTargets`
ships as `all`, so a `myna post` whose target does not resolve does not fail —
it posts to all 26 networks at once. And target detection is easy to miss:
a comma list works only after `--to`, so the `myna post bluesky,mastodon "text"`
form that myna's own help shows sends the literal string `bluesky,mastodon` as
the post, to everything. Always pass `--to`, and pass it a spec you read off
`myna accounts`.

**A post is public, instant and unconfirmed.** There is no prompt and no `--yes`
gate; some networks cannot delete at all, and none can un-notify. `--dry-run`
resolves the targets and stops, which is the check worth running — but it is
only a target check: it does not tailor per network, does not count characters
and does not load media. The real per-network rendering (X bills every URL at 23
characters, threads exist on some networks and not others, a title is a field
only on the long-form ones) is in the TUI compose screen and in `myna_preview`
over MCP. Do not report a `--dry-run` as proof that a post fits.

**Logging in is the user's, not yours.** `myna login` types a password,
approves a device code, or completes a browser flow, and it writes a live token
for that account into an encrypted vault under `~/.config/myna`. It cannot be
scripted in any case — every field is a terminal prompt, with no flag and no
environment variable behind it. Never ask for the password to pass along, and
never read the vault. Nothing about an account lives in this repo; that
separation is why `cli-tools` installs myna without ever touching a credential.

One related edge: `myna logout <account>` also matches a bare network name, so
`myna logout bluesky` disconnects *every* Bluesky account, without confirmation.
Pass the full `network:handle`.

## Where the state is

```
~/.config/myna/
  vault.json      accounts and credentials, AES-256-GCM
  vault.key       the local key (0600)
  queue.json      scheduled posts
  history.json    what was sent
  settings.json   preferences
```

`myna save` / `myna load` move that between machines as one bundle, always
sealed with a passphrase the user types. There is no plaintext export, because
the file holds a live token for every connected account.
