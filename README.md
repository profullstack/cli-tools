# cli-tools

Command-line tools for working across a lot of repositories at once, in
TypeScript, installed as executables on `PATH`.

| Command | What it does |
| --- | --- |
| [`cli-tools`](#install) | The dispatcher: list, update, link, and the pit aliases |
| [`gh-prs`](#gh-prs) | List every open PR across the owners you name |
| [`gh-prs-merge`](#gh-prs-merge) | Squash-merge the PRs that are genuinely ready |
| [`gh-prs-fix-all`](#gh-prs-fix-all) | Fix the open threatcrush-scan PRs that are broken because of us |
| [`tcfeed`](#tcfeed) | Find repositories worth scanning, scan them, print a shortlist |
| [`domainjson`](#domainjson) | whois-style, JSON-first name lookup |
| [`domainfree`](#domainfree) | Which of these domains you can actually register |
| [`free-names`](#free-names) | Name ideas nobody has registered yet, in one command |
| [`blog-post`](#blog-post) | Publish to a plain-HTML blog without breaking the feed |
| [`ask-web`](#ask-web) | Answer a question from the live web, with its sources |
| [`tts`](#tts) | Read text aloud and keep the audio |
| [`affiliate`](#affiliate) | Work through a list of programs you mean to sign up for |
| [`genrewatch`](#genrewatch) | What is coming out, and whether it exists at all |
| [`img`](#img) | Resize, convert and inspect images, with sharp or ImageMagick |
| [`favicon`](#favicon) | Every icon a site links, rendered from one SVG |
| [`vid`](#vid) | Inspect, thumbnail, clip and shrink video, through ffmpeg |
| [`dl`](#dl) | Download a video, or just its audio, through yt-dlp |
| [`torrent`](#torrent) | Make a torrent out of a directory, and get it seeded |
| [`codeburn`](#codeburn) | See where your AI spend goes, by task, tool, model and project |
| [`shorten`](#shorten) | Mint a short link on the pit, and follow it from `/f/<code>` |

One thing here is not a `PATH` command and does not need Node:

| Script | What it does |
| --- | --- |
| [`root-ubuntu.sh`](#root-ubuntush) | Provision an Ubuntu/Debian server: dev environment, accounts, web, TLS |

## Requirements

- **Node 20+**
- **[`gh`](https://cli.github.com/)**, authenticated (`gh auth status`) — every
  `gh-prs*` command shells out to it
- **`dig`** at `/usr/bin/dig` — `domainjson` only
- **[OpenRDAP](https://github.com/openrdap/rdap)** (`rdap` on `PATH`, or
  `~/go/bin/rdap`) — `domainjson` only, and it degrades to DNS-only without it
- **`ffmpeg`** — `vid` and `dl`, and it is a hard requirement rather than a
  degradation: nothing on npm decodes video the way sharp handles images.
  `dl audio` cannot run without it at all; `dl` on its own falls back to the
  best single stream and says so
- **[`yt-dlp`](https://github.com/yt-dlp/yt-dlp)** — `dl` only
  (`moshcode install yt-dlp`, `pipx install yt-dlp`, `brew install yt-dlp`)
- **[`create-torrent`](https://www.npmjs.com/package/create-torrent)** — `torrent`
  only (`npm i -g create-torrent`); `torrent seed` additionally needs
  [torlnk](https://www.npmjs.com/package/torlnk) running
- **ImageMagick** (`magick`) — `img` only, and only for what sharp cannot do
  (PDF, PSD, animated GIF); sharp ships with this repo as an optional dependency
- **Network on first use** — `favicon` only: the generation is
  [`@profullstack/favicon-generator`](https://github.com/profullstack/favicon-generator),
  fetched by `npx` rather than installed here (about seven seconds the first
  time on a box, under two warm)
- **Node 22.13+ and `pnpm` or `npm`** — `codeburn` only: it is somebody else's
  npm package, installed on first use, and upstream's engine floor is higher
  than this repo's

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/profullstack/cli-tools/master/install.sh | sh
```

That clones to `~/.local/share/cli-tools`, installs dependencies, and symlinks
every command into `~/.local/bin`. `CLI_TOOLS_HOME` and `CLI_TOOLS_PREFIX`
override both. If a checkout already owns these command names, the installer
updates *that* one rather than cloning a second copy beside it.

The installer also puts the official [Stripe CLI](https://docs.stripe.com/cli)
on PATH, because the payment work needs it on every box and installing it by
hand is the setup step that never happens. It is vendored under
`~/.local/share/cli-tools/vendor/stripe` and linked into `~/.local/bin`, so the
name exists once; a `stripe` already on PATH from somewhere else is left alone.
`STRIPE_CLI_VERSION` pins a version, `CLI_TOOLS_SKIP_STRIPE=1` skips it. It
downloads the release tarball and checks the published sha256, and if any of
that fails it warns and moves on rather than failing an install that otherwise
worked. Authenticate it once with `stripe login`.

It also installs the **companions** — commands this set ships but does not
implement, because they are distributed in their own right:

| | |
| --- | --- |
| `timer` | [`@profullstack/timer`](https://github.com/profullstack/timer) — track time against projects, for people and for agents |
| `billing` | [`@profullstack/billing`](https://github.com/profullstack/billing) — clients, rates and invoices from the hours the timer tracked |
| `diskpush` | [diskpush.com](https://diskpush.com) — browse servers like FileZilla, transfer with rsync; incremental, resumable, server-to-server |

They are not `bin/*.ts` like everything else here for a reason: they run on
Windows, which this install cannot (it is symlinks into a git checkout executed
through an `npx tsx` shebang), and they are useful with no checkout at all —
under any agentic CLI, from a Dockerfile, on a box that has never heard of this
repository. Vendoring them to make one list tidier would cost them all of that.
So `cli-tools` is their front door, not their implementation.

The first two come from npm. `diskpush` comes from its own installer, which is
not a lesser arrangement: one command places a desktop application and a CLI
together and decides between them by what the machine can actually run. Here it
is installed with `--cli-only`, because a command-line toolbelt asking for a
server should not be answered with 100MB of Electron.

Both kinds are idempotent, which is what lets install, re-install and update be
the same command. `CLI_TOOLS_NO_COMPANIONS=1` skips them, and a failure warns
rather than failing the install.

With moshcode on the box, the same thing:

```sh
moshcode install cli-tools     # then /cli-tools … in the pit
```

That is now the one-liner that also gets you `/timer` and `/billing` in the
pit: moshcode hands both straight to these CLIs once they are installed.

Check what landed, and wire up the pit aliases:

```sh
cli-tools list                 # * runs from here, ! is shadowed by another copy
cli-tools companions           # the two from npm, and whether they are on PATH
cli-tools companions --install # install the missing ones (--force updates all)
cli-tools aliases --install    # /aff /blog /free /merge /names /prs /speak /web /whois
cli-tools config               # API keys: what is set, and where it came from
cli-tools update               # git pull, reinstall, relink, update companions
cli-tools autoupdate --install # …or have a timer do that daily
```

`cli-tools unlink` deliberately leaves the companions installed: they are
ordinary global npm packages that work without this checkout, so unlinking the
repository is no reason to take them off the machine.

### Keeping it current

`cli-tools autoupdate --install` writes a systemd **user** timer that runs
`cli-tools update --auto` once a day — `--hours N` to change the interval,
`--remove` to take it away, bare `autoupdate` to see when it last ran.

`update --auto` is mostly a set of reasons not to act, and deliberately so. The
install is symlinks into a working tree, so updating moves your actual checkout;
an unattended pull that discards work is much worse than a command being a day
old. It proceeds only on a clean tree, on the default branch, with nothing
unpushed, and only when genuinely behind — and names the blocker otherwise, on
stderr, which is the journal when a timer runs it:

```sh
cli-tools update --auto --force        # ignore the once-a-day stamp
journalctl --user -u cli-tools-update  # what it decided, and why
```

A checkout parked on a feature branch is therefore left alone. That is the
design rather than a failure.

The unit **carries your current `PATH`**, because a user unit otherwise starts
with roughly `/usr/bin:/bin` while every command here runs through a `npx --yes
tsx` shebang whose node is usually a version manager's shim under `$HOME`. Get
that wrong and the timer fires perfectly on schedule, fails to find node, and
nothing anywhere looks broken. Note also that **user timers stop at logout**
unless lingering is on (`loginctl enable-linger`, which needs root);
`Persistent=true` means it catches up at the next login instead.

<details>
<summary>From a clone, for development</summary>

```sh
git clone git@github.com:profullstack/cli-tools.git ~/src/profullstack/cli-tools
cd ~/src/profullstack/cli-tools
pnpm install
pnpm link:bin
```
</details>

`link:bin` symlinks every `bin/*.ts` into `~/.local/bin` without the extension,
so `gh-prs-merge` is a real command. (Not named `link` — that is a pnpm builtin,
and `pnpm link` would run pnpm's own command instead of this one.) Make sure the
directory is on `PATH`:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

### Migrating from `profullstack/scripts`

These names already exist in `~/.local/bin` pointing at `~/scripts/bin`, so a
plain `pnpm link:bin` reports them as not-ours and changes nothing. To take them
over:

```sh
node scripts/install-links.mjs --dry-run --force   # see exactly what would move
node scripts/install-links.mjs --force             # do it
```

`--force` replaces a *symlink*. A real file of the same name is still refused —
clobbering someone's actual binary to install a convenience is not a trade a
script gets to make on its own.

To go back:

```sh
pnpm unlink:bin                                               # remove ours
ln -sf ~/scripts/bin/gh-prs-merge ~/.local/bin/gh-prs-merge   # and so on
```

## API keys

Five commands here call a paid API: `generate-names` and `free-names` (OpenAI
or Anthropic), `ask-web` (Perplexity) and `tts` (ElevenLabs). Store the keys once, and nothing
has to carry them in an environment again:

```sh
cli-tools config pull              # import them from the logicsrc team vault
cli-tools config set openai        # or set one by hand; the value is never echoed
cli-tools config                   # what is set, and which source is winning
cli-tools config unset openai
```

### From the team vault

`cli-tools config pull` decrypts the shared logicsrc vault and imports the keys
these commands use — the fastest way to set a new machine up, and the way a
rotated key reaches it:

```sh
cli-tools config pull
# config: imported OPENAI_API_KEY (sk-pr…ZyAA (164 chars))
# config: imported ANTHROPIC_API_KEY (sk-an…uAAA (108 chars))
# 11 other key(s) in the vault were left there
```

It defaults to `profullstack/profullstack-sharable-keys--prod`, overridable with
`CLI_TOOLS_VAULT_TEAM`, `CLI_TOOLS_VAULT_PROJECT` and `CLI_TOOLS_VAULT_ENV`.
Needs the `logicsrc` CLI and a login (`moshcode install secrets`, then
`logicsrc login`); if it is missing, the error says so rather than failing
obscurely.

**It imports only the keys these commands read, and leaves the rest in the
vault.** Copying a whole vault down would make the local file a second copy of
every team secret that nobody remembers to invalidate — which is the thing the
vault exists to avoid. The vault stays the authority; this is a cache of the
handful of keys these commands actually read.

`logicsrc teams pull` can only write a decrypted `.env` to a path, so the
plaintext exists for the length of one read: it goes to a `0700` temporary
directory and is removed in a `finally`, including when the pull or the parse
fails.

Keys live in `~/.config/cli-tools/credentials.json`, written `0600` in a `0700`
directory (`$CLI_TOOLS_CREDENTIALS` overrides the path). Nothing prints a whole
key back — `config` shows a masked preview and a length, which is enough to tell
two keys apart and not enough to use one. `--json` is machine-readable and
carries the same masked previews, not the values.

| Key | Variable | Used by |
| --- | --- | --- |
| `openai` | `OPENAI_API_KEY` | `generate-names`, `free-names` |
| `anthropic` | `ANTHROPIC_API_KEY` | `generate-names`, `free-names` |
| `perplexity` | `PERPLEXITY_API_KEY` | `ask-web` |
| `elevenlabs` | `ELEVENLABS_API_KEY` | `tts` |
| `porkbun` | `PORKBUN_API_KEY` | `porkbun` |
| `porkbun_secret` | `PORKBUN_SECRET_API_KEY` | `porkbun` |
| `moshcode` | `MOSHCODE_API_KEY` | `shorten` |

A key earns a row here by being read by a command in this repository, not by
being a key the team owns. The vault holds more than twice as many; the rest
stay in it.

**The environment wins over the file.** A key exported in your shell or injected
by CI overrides a stored one, so a one-off `OPENAI_API_KEY=… generate-names …`
still behaves. Because that is otherwise invisible — you store a key, and the
old one keeps being used — `cli-tools config` reports the *source* of each key
rather than only whether one exists, and says so explicitly when a stored value
is being shadowed.

A value can be passed inline (`cli-tools config set openai sk-…`) for scripts,
and piped (`… | cli-tools config set openai`) when there is no TTY. Inline is
the worst of the three: it lands in shell history and in `ps`, so the command
warns when you use it interactively.

This is a machine-local credential store, the same kind of thing as
`~/.aws/credentials` — not a `.env`, not something to copy between machines, and
not where a production secret belongs. A secret that a deployed service needs
goes on that service, with your vault as the record.

## Usage

### `gh-prs`

Lists open pull requests across any number of organizations and personal
accounts, newest first, as an aligned table. In a capable terminal the PR number
and URL become clickable.

```sh
gh-prs --orgs profullstack,moshcoder,h4kr,infernetprotocol
gh-prs --users octocat
gh-prs --orgs profullstack --users octocat --limit 50
gh-prs --orgs profullstack --no-links          # plain text, for piping
```

### `gh-prs-merge`

Walks the same scopes and squash-merges every PR that qualifies, oldest first.
**Dry run by default** — nothing changes until you pass `--apply`.

```sh
gh-prs-merge --orgs profullstack                      # report only
gh-prs-merge --orgs profullstack --apply              # merge what qualifies
gh-prs-merge --orgs profullstack --apply --fix        # repair, then merge
gh-prs-merge --orgs profullstack --apply --fix --fix-wait 900
```

A PR is merged only when all of these hold:

- it is open, and not a draft (or was successfully marked ready)
- `mergeable` is `MERGEABLE` and `mergeStateStatus` is `CLEAN`
- at least one CI check exists, unless `--allow-no-checks`
- every check is `pass` or `skipping`
- the head commit has not changed when the merge is submitted

That last one is the safety property. Between reading the checks and submitting
the merge, someone can push; `--match-head-commit` means the merge lands on the
commit that was actually verified or not at all. There is deliberately no
`--admin`, so branch protections stay enforced.

#### `--fix`

A skip is not always a verdict on the PR. Two were once skipped as
`mergeStateStatus=UNSTABLE` purely because a check had not reported yet —
nothing was wrong with either, and both merged unchanged minutes later.

`--fix` repairs a repairable skip **once**, then judges the PR again against the
identical rules. It requires `--apply`, because every repair writes.

| Blocker | Repair |
| --- | --- |
| checks still running | Wait for them to settle, up to `--fix-wait` (default 600s) |
| `mergeStateStatus=BEHIND` | Ask GitHub to merge the base branch in |
| `mergeable=CONFLICTING` | Same request; succeeds when the base merely moved |

What it will not do is as much of the design:

- **A conflict GitHub declines to merge is left alone**, and the message it gave
  is printed as `FIXME`. Resolving one means choosing between two authors'
  intent, and a batch tool that guesses produces a merge nobody wrote and nobody
  reviewed.
- **A check that ran and failed is a result, not an obstacle.** Retrying until it
  passes is how a flaky suite becomes a green one that means nothing.

### `gh-prs-fix-all`

Looks at every open threatcrush-scan pull request and fixes the ones broken
because of us. Reports the rest and leaves them alone.

```sh
gh-prs-fix-all                 # fix ours, report theirs
gh-prs-fix-all --dry-run       # change nothing, just say what stands
gh-prs-fix-all owner/name ...  # only these
```

The name says fix-all and it will not fix all, deliberately. Pushing to a fork
sets off whatever the upstream repo runs on push, so their suite goes red
against a commit that only added files under `.github/`. Those are reported,
never touched.

### `tcfeed`

```sh
tcfeed                              # the 50 newest posts
tcfeed 100                          # more of them
tcfeed --forget                     # look at everything again next time
tcfeed pr owner/name [--dry-run]    # install the scan workflow
tcfeed check [--fix]                # how are the open requests doing
```

The scanner itself lives in the threatcrush checkout, so this is a launcher.
Point it elsewhere with `TCFEED_REPO`; every other `TCFEED_*` variable is read
by the script it launches and works unchanged.

### `generate-names`

Turn a sentence describing a product into a long list of candidate names, ready
to pipe into `domainfree`.

```sh
generate-names "a registry that checks whether Lean proofs actually compile"
generate-names "a tool that finds dead states in agent graphs" -n 1000 --tld dev
generate-names "an open directory of independent blogs" | domainfree
```

**It asks the model for vocabulary, not for a thousand names.** One cheap call
returns ~40 head words and ~40 modifiers; the cross product is expanded locally
and shuffled. Asking a model for 1,000 names directly repeats itself within a
few hundred, drifts off-brief, and costs far more — and the call count here is
the same whether you ask for 10 names or 10,000.

Needs a key — `cli-tools config set openai` stores one (see [API
keys](#api-keys)), and `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` still work and
take precedence. Whichever provider has a key is used; OpenAI wins if both do.
Defaults are the frontier tier on each side (`gpt-5.6-sol` / `claude-fable-5`)
and are overridable with `--model`.

| Flag | Effect |
| --- | --- |
| `-n, --count N` | how many names to print, default 1000 |
| `--tld TLD` | extension to append, default `com` |
| `--words N` | 1 or 2 English words per name, default 2 |
| `--provider P` | `openai` or `anthropic`, default whichever key is set |
| `--model M` | override the model |
| `--seed N` | shuffle seed; the same seed reproduces the same list |
| `--timeout MS` | API timeout, default 60000 |

Names go to stdout and the summary to stderr, so the output pipes cleanly.

### `free-names`

`generate-names "..." | domainfree` as one command: describe the thing, get back
only the names nobody has registered.

```sh
free-names "a desktop app that syncs over rsync, --partial and --archive"
free-names "an open directory of independent blogs" -n 200 --words 1
free-names "a registry that checks Lean proofs" --tld dev --all
```

It exists because a pipe cannot be aliased. A moshcode pit alias appends what
you typed to the end of its expansion, so `/names "a desktop app"` against
`generate-names -n 100 | domainfree` would put the description *after*
`domainfree`. The only workarounds are a shell function stored in a config file,
which is the thing this repository exists to avoid — so the composition became a
command, and `/names` stays a thin alias pointing at it.

The default count is **100**, not `generate-names`' 1000: every candidate here
costs a registry lookup rather than a line of output, and a thousand RDAP
lookups against rate-limited servers turns a ten-second command into a
multi-minute one. Both halves behave exactly as they do separately — one small
API call for vocabulary, availability read from RDAP — and an indeterminate
lookup is never reported as available.

It takes the flags of both, with `--timeout` kept for the registry (matching
`domainfree`) and `--api-timeout` for the model.

### `domainfree`

Bulk domain availability, straight from the registry. Prints only the names you
can actually buy, one per line, so it pipes into anything.

```sh
domainfree sorrycheck.com sinkstate.com
domainfree --file candidates.txt
generate-names "a registry that checks Lean proofs" | domainfree --jobs 24
printf '%s\n' sorry{check,lint,scan}.com | domainfree
domainfree --all example.com          # show TAKEN rows too
```

Availability is read from **RDAP, never inferred from DNS**, because DNS cannot
tell registration apart from configuration:

- a parked domain resolves fine and is taken;
- a domain registered with no nameservers returns `NXDOMAIN` — identical to a
  name nobody owns.

Measured over 8,513 generated candidates, the DNS shortcut
(`dig NAME | grep "ANSWER: 0"`) reported 20 registered domains as free while
missing none that were genuinely free. `oubliette.com` is the instructive one:
registered in 1996, paid through 2034, three nameservers, no `A` record — so
`dig` says `ANSWER: 0` and it reads as available. Fine as a cheap prefilter,
useless as a buy signal.

Lookups run through a fixed-size pool (16 by default; about 8,500 names in 45
seconds). Anything indeterminate — a 429, a 5xx, a timeout — is retried once
and then reported as `ERR:<code>`, never as available, and the exit status is
`2` so an unknown cannot be mistaken for a free name.

| Flag | Effect |
| --- | --- |
| `-f, --file FILE` | read names from FILE, one per line (`-` for stdin) |
| `-j, --jobs N` | parallel lookups, default 16 |
| `-t, --timeout MS` | per-lookup timeout, default 20000 |
| `-a, --all` | print every name as `STATUS domain`, not just the free ones |
| `-q, --quiet` | suppress the summary, which is written to stderr |

The summary goes to stderr and the names to stdout, so `domainfree -f in.txt |
wc -l` counts what you can buy. For a deep look at one name rather than a
verdict across thousands, use `domainjson`.

### `domainjson`

One JSON object on stdout: `{ name, rdap | moshpit, dns }`.

```sh
domainjson example.com
domainjson --name example.com
domainjson --registry https://pit.moshcode.sh --timeout 4000 example.hacker
domainjson -s https://rdap.example example.com     # OpenRDAP flags pass through
```

Names ending in a Moshpit TLD are served from the registry API; everything else
goes through OpenRDAP. Either way `dig` adds records, hosts, reverse lookups and
per-nameserver AXFR attempts. Errors are JSON too — a tool whose output gets
parsed should not change shape when it fails.

### `porkbun`

Domains and DNS at Porkbun, without the dashboard.

```sh
porkbun ls example.com                                   # the zone, apex first
porkbun ls example.com --type TXT                        # one type
porkbun set example.com www CNAME app.up.railway.app     # create, or edit in place
porkbun set example.com @ ALIAS app.up.railway.app       # apex, via Porkbun's ALIAS
porkbun rm example.com www --type CNAME --yes
porkbun unpark example.com                               # stop the parking page winning
porkbun domains                                          # everything on the account
porkbun check example.com                                # available? at what price?
porkbun register example.com --max-price 20              # buy it
```

Write the host the way you would say it. `@`, an empty value and the bare domain
all mean the apex; `www` and `www.example.com` are the same record. Getting this
wrong is how you end up with `www.example.com.example.com`, so all four forms are
accepted and normalised.

`set` is an upsert: it creates the record, or edits the existing one **in place**,
keeping its id. The obvious alternative — delete then create — has a window where
the name does not resolve at all. When the value already matches it reports
`unchanged` and sends no write. If several records share a name and type (two TXT
values, a set of A records) it refuses rather than guessing which to overwrite.

`unpark` is the one worth knowing about. A domain you bought and left alone answers
with an `ALIAS` at the apex and a wildcard `CNAME`, both pointing at a
`*.porkbun.com` host — and **those records belong to a URL forwarding rule** rather
than standing on their own. So adding your own ALIAS beside them changes nothing:
the forward keeps winning, the new host never sees a request, and it looks exactly
like a broken deploy rather than a DNS problem. `unpark` deletes the forward, which
takes its records with it, then removes anything that survived. `--dry-run` prints
the plan first.

It is deliberately narrow about what counts as parking: only `ALIAS` and `CNAME`
records pointing at `porkbun.com`. The `MX` records at `fwd1.porkbun.com` are
Porkbun's *email forwarding* and the `NS` records are the zone's delegation —
sweeping either up would break mail or take the domain off the internet.

`register` spends real money, so it is built to make that hard to do by accident.
It resolves one plan — the TLD's rules, then availability and price — prints it,
and asks; the number in the prompt is the number sent to the registrar, because
it is the same number. `--dry-run` prices it and stops, `--max-price` refuses
anything dearer (a premium name can be hundreds), and a promotional first year is
called out because it is not what you will pay next year. WHOIS privacy is on
unless you pass `--no-whois-privacy`, and a TLD that cannot do privacy is refused
rather than quietly publishing your address.

**It spends prepaid Porkbun credit, and there is no card behind it.** A zero
balance cannot register anything, however valid the request, so `register` stops
on short funds and says how much is missing rather than reporting a vague
refusal. Porkbun gates API registration behind three further account facts, none
of which any read endpoint exposes: a verified email *and* phone, at least one
registration placed previously, and the name not being premium — premium is
website-only at any price.

Before charging anything it runs Porkbun's **own** pre-flight (`dryRun`), which is
the only way to see the account-level gates — funds, the monthly API spend cap and
whether the account is verified at all. No read endpoint reports those, so a local
check cannot substitute. `--dry-run` stops after it. The real purchase carries an
`Idempotency-Key`, because a create that times out has probably still registered
the domain and the natural retry would buy a second year.

Refusals keep Porkbun's structured `code`, `hint` and `next_action.url`, so
`VERIFICATION_REQUIRED` prints what would clear it, where, and that retrying will
not help — rather than one sentence that reads like a transient and invites six
more attempts.

Two things about it. Availability is **rate limited to one check per ten seconds**,
which is why the price is fetched once and carried rather than re-checked just
before buying. And prices are quoted as dollar strings while `/domain/create`
wants integer cents that match the quote exactly — `parseFloat('11.08') * 100` is
`1107.9999999999998`, so the conversion is done as text and never becomes a float.

Two Porkbun-specific traps the errors call out by name. Every call is a `POST`
with the credentials in the body, and **`status` is a field rather than the HTTP
code**: a bad key, an unknown domain and a malformed record all return `200 OK`
with `{"status":"ERROR"}`, so checking the response code reports success for all
three. And API access is **off per domain** until you switch it on in that
domain's settings — a key that pings fine still gets `Invalid domain` until you do.

### `blog-post`

Publishes to the plain-HTML blog at `~/public_html/blog`. That blog has no build
step and no CMS: writing a file *is* publishing. This exists because nothing
else catches a mistake before it is live.

```sh
blog-post new "A title" --description "The one-line feed summary"
blog-post new "A title" --description "..." --body draft.html
blog-post check          # posts that will break the feed
blog-post list           # every post with its date
blog-post feed           # regenerate feed.xml
blog-post config         # where your identity is read from, and what is in effect
```

`new` picks the next `NNN-post.html`, renders the smolweb-valid template,
splices the entry into the hand-maintained `index.html`, and runs the blog's own
`build-feed.mjs`. Point it elsewhere with `--dir` or `$BLOG_DIR`.

#### Your identity is configuration, not code

Nothing about *you* is baked into this repository. The byline, the site name,
the `rel="me"` links and any analytics or ad ids come from a config file, and
with none present a post renders with no byline, no identity links and **no
third-party scripts at all** — which is the only fully smolweb-valid output.

Copy [`blog.config.example.json`](blog.config.example.json) to whichever of
these suits, most specific first:

| Path | Use it for |
| --- | --- |
| `$BLOG_CONFIG` | a one-off, or CI |
| `<blog dir>/blog.config.json` | a second blog with its own identity |
| `~/.config/cli-tools/blog.json` | your own blog — the usual answer |

```json
{
  "siteTitle": "Your Blog",
  "author": "Your Name",
  "disclosure": "<strong>How this was written:</strong> drafted with an AI assistant, then edited by me.",
  "links": [{ "label": "Mastodon", "href": "https://example.social/@you" }],
  "trackerSiteId": null,
  "adSlotId": null
}
```

`BLOG_SITE_TITLE`, `BLOG_AUTHOR`, `BLOG_DISCLOSURE`, `CRAWLPROOF_SITE_ID`,
`CRAWLPROOF_AD_SLOT` and `CRAWLPROOF_AD_FORMAT` override the file. `links` is
the only field with no environment equivalent.

`trackerSiteId` and `adSlotId` are **accounts, not settings**: leave them null
unless they are yours. A shared id would meter your readers' pageviews and your
ad impressions into somebody else's account, which is why they are not defaults.

Run `blog-post config` to see which file was picked up and what it resolved to.

What it refuses to do:

- **Date a post in the future.** Such a post sorts above every real post, and
  readers that filter future items drop it entirely — so the feed looks like it
  stopped updating while the files on disk look perfect. This has happened:
  three posts sat 7–10 hours ahead and did exactly that. `--allow-future` is
  there if you genuinely mean to schedule.
- **Overwrite a post.** Two concurrent runs read the directory before either
  writes, so both pick the same number; the write uses `wx` and the loser fails
  loudly rather than silently replacing a post.
- **Skip the description.** It is the entire RSS summary.

`check` reports missing, unparseable and future dates, empty descriptions and a
missing `<h1>`, and exits non-zero, so it works as a pre-publish gate.

### `ask-web`

Answers a question from a live web search and prints the pages the answer came
from, numbered to match the `[n]` markers in the text:

```sh
ask-web "what is the latest Node LTS" --recency month
# The latest stable Node.js LTS version is v24.19.0.[3][5]
#
# Sources:
#   [1] Node.js — https://endoflife.date/nodejs (2026-08-06)
#   [3] Node.js 24.19.0 (LTS) — https://nodejs.org/en/blog/release/v24.19.0 (2026-08-03)
```

```sh
ask-web "…" --domains nodejs.org,github.com   # only these hosts
ask-web "…" --model sonar-pro                 # search wider
ask-web "…" --bare                            # prose only, for piping
ask-web "…" --json                            # answer and sources as JSON
```

It is not named `ask` because that name is already taken on `PATH` here, and a
command that shadows another one silently is worse than a longer name.

**The sources are the feature.** An answer whose `[1]` resolves to nothing is
indistinguishable from an answer that was invented, so two fields of the
response are treated differently on purpose: `citations` is a positional URL
list whose order *is* the numbering, while `search_results` carries the titles in
whatever order it likes and is joined on by URL. Numbering from `search_results`
would mislabel every source. When the answer cites a marker no source backs,
that is reported on stderr rather than dropped.

Answers go to stdout and status to stderr, so `ask-web … | pbcopy` gets prose.

### `tts`

Reads text aloud with ElevenLabs and keeps the audio, printing the path it
wrote:

```sh
tts "the deploy finished"          # → the-deploy-finished.mp3
mpv "$(tts 'build is green')"
cat post.md | tts --voice George --out post.mp3
tts --voices                       # the account's voices, by name and ID
```

The file is named after the text rather than a timestamp, because a directory of
`speech-1755794400.mp3` tells you nothing about which one it was.

A voice can be given as an ID, a full label, or just the human part of it —
the account's are called things like `River - Relaxed, Neutral, Informative`,
which nobody is going to type. An ambiguous prefix is an error naming the
candidates rather than a pick of the first match: choosing one would be a coin
flip that changes narrator the day the account gains a voice, with nothing on
screen to explain why. A voice given as an ID skips the lookup entirely, so
`--voice <id>` works on a key whose plan cannot list voices.

`--stability`, `--similarity` and `--style` take 0–1. Nothing is sent unless you
ask: a full settings object would override whatever the voice was tuned with in
the dashboard, on an account other people share. Synthesis spends characters from
that shared quota, and nothing here retries, so a failed call never costs twice.

### `affiliate`

Walks a list of signup pages one at a time, remembers which you have dealt
with, and keeps the referral link each one hands back:

```sh
affiliate list --file programs.md
affiliate next --open                  # open the next one you have not done
affiliate join elevenlabs https://try.elevenlabs.io/abc123
affiliate skip notion --note "closed to new affiliates"
affiliate links --format markdown      # → - [ElevenLabs](https://try.…)
```

**The list is any text with links in it.** A bare column of URLs, a markdown
table, a bullet list, a CSV someone exported — the first URL on a line is the
program and whatever precedes it is the name. Rather than asking which format it
is, it takes the first URL and works out the name from context: the bracketed
text of a markdown link, the first cell of a table row, or the host when there
is nothing else. A line with no URL is a heading, not an error.

Two entries that differ only by `utm_*` are one program, so the same page shared
from a newsletter and from a tweet does not ask you to sign up twice.

Progress lives in `~/.config/cli-tools/affiliates.json` and the application
answers in `affiliate-profile.json`, both `0600` in a `0700` directory. **An
entry you have joined survives being removed from the list** — it moves to the
end rather than disappearing, because losing a referral link to somebody tidying
the source file would be the worst thing this could do.

The contact address resolves from `--email`, then `$AFFILIATE_EMAIL`, then the
profile file, then whoever `moshcode whoami` reports. The account is last on
purpose: it is the one you cannot override in the moment, and signing up as the
wrong identity is not undone by re-running the command.

```sh
affiliate profile --site https://profullstack.com --audience "…"
affiliate answers        # the four things every application asks, ready to paste
```

`answers` prints gaps as `(not set)` rather than filling them in. A form that
asks for audience size and receives a number nobody checked is the fastest way
to lose the account it was meant to open.

**It never submits anything.** Signing up accepts terms and hands over payout
identity as a named person, which is not something a script should do on
someone's behalf — and every one of these is behind an email-verification loop
regardless, so a form-filler would stop at the same wall with one more moving
part.

### `genrewatch`

What is coming out, and whether a thing exists at all:

```sh
genrewatch search blade runner        # back catalogue as well as the calendar
genrewatch upcoming -c film -n 10
genrewatch categories                 # tv | film | anime | music | space
genrewatch upcoming -g drama-tv --json
```

Search reaches the back catalogue, so a film from 1999 is a valid answer, and
anything the site does not already hold is looked up live. `--base` points at
another deployment.

A date with no time prints as a date. The API says which is which, and a release
genuinely has no hour — printing one would be inventing it.

### `img`

Image work without opening an editor:

```sh
img info logo.png                     # dimensions, format, size
img resize hero.jpg -w 1200 -o hero@2x.jpg
img convert shot.png --to webp
img icons logo.png --out public/      # a quick PWA-sized set; see `favicon`
```

**It never enlarges by default.** Scaling a 96px mark up to 512 produces a
blurry file that looks like a bug in whatever renders it, so that needs
`--force`.

Two engines: `sharp` arrives with this repo as an optional dependency and is
fast; ImageMagick is a system binary and handles PDF, PSD and animated GIF,
which sharp does not. `--engine` picks.

### `favicon`

Every icon a site links, rendered from one SVG:

```sh
favicon logo.svg                          # -> ./icons
favicon logo.svg --out public/icons
favicon mark.svg --out public --quality 90 --no-favicons
favicon logo.svg --dry-run                # print the command, run nothing
```

It writes `icon-16` through `icon-512`, an `apple-touch-icon` at every size iOS
has ever asked for, `favicon.png` / `.svg` / `.ico`, and the `manifest.json`,
`browserconfig.xml` and `<link>` tags that reference them. A PNG source works;
an SVG is better, because each size is then rendered from the vector rather
than resampled from one raster.

**Not the same tool as `img icons`.** That one resamples a raster into the nine
sizes a manifest normally asks for, with whichever engine the box has. This is
the full iOS and PWA set, plus the markup.

The generation is [`@profullstack/favicon-generator`](https://github.com/profullstack/favicon-generator),
run through `npx` rather than installed here — it brings its own `sharp` and a
postinstall that shells out, neither of which the other fifteen tools should
pay for at install time. What lives in this repo is the command name, the
argument handling and the refusal to prompt: upstream's CLI ignores a
positional file and an unrecognised flag, and with nothing left to go on drops
into an interactive prompt, which in a script with no TTY dies with `User force
closed the prompt`. Here the file is a positional, unknown flags are an error,
and `-i`/`-o` are always passed on, so that prompt is unreachable.

`FAVICON_SPEC` is what `npx` runs. Pin it (`@profullstack/favicon-generator@1.2.1`)
when a release breaks you, or point it at a checkout while working on the
generator itself.

### `vid`

The four things anybody actually needs ffmpeg for:

```sh
vid info clip.mp4                     # duration, streams, size
vid thumb talk.mp4 --at 00:01:30
vid clip talk.mp4 --from 00:01:00 --to 00:02:00
vid shrink talk.mp4 --height 720      # --crf 28 by default
vid audio talk.mp4                    # → talk.m4a
```

`clip` copies streams rather than re-encoding, so it is nearly instant and cuts
at the nearest keyframe — which can be a second or two off what you asked for.
That is the trade: re-encoding to hit an exact frame takes as long as the clip.

Needs `ffmpeg` on `PATH`. There is no bundled fallback — nothing on npm decodes
video the way sharp handles images.

### `dl`

A thin front for [yt-dlp](https://github.com/yt-dlp/yt-dlp), in the same shape
`vid` is a thin front for ffmpeg:

```sh
dl https://example.com/watch?v=abc          # the video
dl --height 720 https://example.com/v/abc   # capped
dl audio https://example.com/watch?v=abc    # → .m4a, --format mp3 for anything else
dl info https://example.com/watch?v=abc     # title, uploader, duration; nothing downloaded
dl formats https://example.com/watch?v=abc  # everything yt-dlp will give you
dl --to ~/Downloads https://a/1 https://b/2 # several at once
```

**One entry, not the list.** A YouTube link copied from the browser while a mix
is playing carries `list=`, and yt-dlp reads that as "download all of it" — the
difference between one file and two hundred, on a command whose entire input is
a pasted URL. So `--no-playlist` is the default here and `--playlist` is how you
ask for the rest.

**ffmpeg is the other half.** Above about 720p the picture and the sound arrive
as separate streams that have to be muxed, so without ffmpeg on `PATH` `dl`
restricts itself to the best single stream and warns that it did — rather than
picking a format it cannot finish, downloading both halves, and failing at the
merge. `dl audio` is `-x`, which *is* ffmpeg, so there it is a hard requirement.

A URL that fails does not stop the ones after it; the exit code still reports
the failure.

### `torrent`

Turn a directory into a torrent, and get it seeded:

```sh
torrent create ./album              # writes album.torrent, prints the magnet
torrent seed ./album                # …and hands the magnet to torlnk
torrent magnet album.torrent        # the magnet for one you already have
torrent info album.torrent          # name, info hash, magnet
```

`create-torrent` writes a .torrent and never prints a hash; torlnk takes a
magnet rather than a file. So the two do not actually meet without something in
between, and that is what this is. The info hash is computed here — a SHA-1 over
the bencoded `info` dictionary, read out of the file verbatim — rather than by
adding a bencode parser as a dependency for forty lines.

**Trackers matter more than they look.** A browser can only ever be a WebRTC
peer, so a torrent with no `wss://` tracker is invisible to every web player:
it is on the DHT, desktop clients find it, and the browser sees a torrent with
no peers — which reads as a dead torrent rather than as a missing tracker. The
default list carries both kinds, and every entry was checked rather than copied.
The announce list the WebTorrent tooling ships by default still names
`tracker.leechers-paradise.org` (no DNS at all), `coppersurfer.tk` and
`empire-js.us` (both time out on a UDP connect), and `tracker.btorrent.xyz`
(a self-signed certificate, which a browser refuses outright). Override the lot
with `--tracker`.

`--private` exists and is opt-in, because a private torrent is excluded from the
DHT by every client that honours the flag — the opposite of the reason to make
one here.

**From a URL rather than a seeding process.** `--webseed` embeds HTTP URLs that
already serve the same bytes (BEP 19), so the torrent is downloadable the moment
it exists — before any peer has it, and without anything staying running:

```sh
torrent create ./album --webseed https://files.example.com/album
```

The URL has to serve the *exact* bytes the torrent was made from. A redirect to
a re-encoded or recompressed copy is a torrent that fails its hash check, which
looks like corruption rather than like a misconfigured seed.

`seed` hands the magnet to torlnk, which is the process that stays running:
its serve API by default (`--api`, `$TORLINK_API`, `$TORLINK_API_TOKEN`), or a
watch directory (`--watch`, `$TORLINK_WATCH`) as the offline handoff. How long
it seeds for is a torlnk daemon setting (`--seed-time`), not a per-torrent one;
left alone, it seeds indefinitely.

### `codeburn`

Where your AI spend actually went — [codeburn](https://www.npmjs.com/package/codeburn),
wrapped so it is a command rather than something you `npx`:

```sh
codeburn                              # the dashboard, last 7 days; q quits
codeburn overview -p all              # last 6 months, copy-pasteable
codeburn optimize --provider claude   # what is wasting tokens, and the fix
codeburn --help                       # it is upstream's CLI: upstream's flags
```

Everything is handed through untouched, so upstream's docs are the docs. Two
flags are ours, spelled `--self-*` because every plain word belongs to them:

```sh
codeburn --self-update                # reinstall the latest release
codeburn --self-where                 # which copy runs, and from where
```

**The first run installs it**, with `pnpm` and with `npm` when pnpm is absent or
fails — the same order `install.sh` uses. It lands in
`~/.local/share/cli-tools/vendor/codeburn`, not globally, and that is the whole
point: a global install would put a second executable called `codeburn` on
`PATH` beside this repo's own link to this wrapper, and which one won would come
down to the order of two directories. Ours would then shell out to whatever
`codeburn` resolves to, which is ours. A private prefix means the name exists
once. `CODEBURN_BIN` points at a copy you would rather run.

Installed rather than `pnpm dlx`-ed each time because dlx checks the registry
before every launch, which is fine for a one-shot and wrong for a dashboard you
open twenty times a day. Upstream wants **Node 22.13+**; on an older one it says
so and tries anyway, since that floor is theirs to move.

### `shorten`

Mints a short link on the Moshpit registry and prints it. `/f/<code>` answers a
`302` to wherever it points, from anywhere — no resolver, no extension, nothing
installed on the other end.

```sh
shorten https://pit.moshcode.sh/n/blue.eggs/the-post-i-wrote-on-tuesday
#      → https://pit.moshcode.sh/f/k7mq2xd

shorten https://example.com/x --name blue.eggs   # file it under a name you hold
shorten list                                     # yours, with hit counts
shorten rm k7mq2xd                               # it stops resolving
shorten https://example.com/x --bare | pbcopy    # just the url
```

**Nothing to configure on a machine where the pit works.** The token
`moshcode login` already wrote is picked up from `~/.moshcode/credentials.json`;
`cli-tools config set moshcode` and `MOSHCODE_API_KEY` are for a box that has the
key but not moshcode.

Minting is authenticated because an anonymous shortener is an open redirector
with a database attached. It is also idempotent per account — the same url twice
returns the same code — so this is safe to retry and cannot quietly split one
destination's hits across two codes.

The registry owns what may be shortened (`http(s)` only, and a short link may
not point at itself), and this passes its refusals through verbatim rather than
keeping a second, looser copy of those rules that would drift. The short url is
the only thing on stdout, so it pipes.

The same thing lives inside moshcode as `/shorten`; this is the copy that pipes.

### `root-ubuntu.sh`

Sets up a server the way we like them, and keeps it that way. It is the odd one
out in this repository: a single bash script rather than a TypeScript command,
because it has to run on a machine where nothing is installed yet — including
Node. Nothing links it onto `PATH`; you curl it onto the box.

```sh
# on the server, as root
curl -fsSL https://raw.githubusercontent.com/profullstack/cli-tools/master/root-ubuntu.sh \
  | bash -s -- --refresh
```

**`bash`, not `sh`.** `/bin/sh` on Ubuntu is dash and this script is bash
throughout. Piping it into `sh` stops with one sentence telling you so rather
than a syntax error on a line you never typed.

A pipe has no terminal on stdin, so that form is always non-interactive: it
takes defaults instead of reading answers out of its own source. To be asked the
questions, download it first:

```sh
curl -fsSLO https://raw.githubusercontent.com/profullstack/cli-tools/master/root-ubuntu.sh
chmod +x root-ubuntu.sh
./root-ubuntu.sh                    # as root
./root-ubuntu.sh alice bob          # ...and provision two accounts
./root-ubuntu.sh alice --groups sudo,docker
```

What a run does:

- apt update/upgrade, base packages, unattended security updates
- `ufw`, with ssh opened *before* the firewall is enabled
- accounts and groups — created, or refreshed if an earlier run made them
- zsh + oh-my-zsh, oh-my-tmux, mise, moshcode, chawan
- nginx: `~/public_html` at `/~user` and `user.$WEB_DOMAIN`, plus per-user dev
  apps at `<app>.<user>.$WEB_DOMAIN`, static or reverse-proxied
- Let's Encrypt, wildcard via DNS-01 where credentials allow it

**Re-running is the update path.** Every step converges rather than assuming a
blank machine: files it owns are rewritten only when the content really changed,
so nginx is not reloaded for nothing; files a user has since edited are never
clobbered, and the new version is left beside them as `.new`; and a lock file
makes two concurrent runs impossible. On a settled box a re-run reports that
nothing changed, which is the point.

#### Accounts and groups

New accounts land in `DEFAULT_GROUPS` (`sudo,admin` unless configured) when
`--groups` is not passed. An unattended run — `--refresh`, or anything piped
into bash — never reaches the group prompt, so that default is what *every*
account it creates gets; set the key in `server.conf` on a box where new people
should not be root-equivalent.

A full run is the wrong tool for a one-line change — putting somebody in
`docker` should not drag an apt upgrade and a possible reboot behind it — and
`--groups` could only ever *add*. `groups` is the rest of it:

```sh
./root-ubuntu.sh groups                          # every account, and its groups
./root-ubuntu.sh groups alice                    # just this one
./root-ubuntu.sh groups add alice docker,users   # as root
./root-ubuntu.sh groups rm alice docker          # as root
./root-ubuntu.sh groups set alice sudo,admin     # exactly these, drop the rest
./root-ubuntu.sh groups create|delete|members deploy
```

Listing needs no privilege; everything that changes something needs root. Each
verb is a thin wrapper over the tool that already does the job — `gpasswd -a`,
`gpasswd -d`, `usermod -G`, `groupadd`, `groupdel` — so nothing here has its own
idea of what `/etc/group` looks like.

`rm` and `delete` are one word apart and one of them is destructive, so they are
told apart by what their first argument *is*: `rm` takes a login and refuses
anything else, `delete` takes group names and refuses anything else. `groups rm
docker` is *"no such user: docker"*, not a deleted `docker` group.

Two refusals, both liftable with `--force`: taking the **last** member out of
`sudo`/`admin`/`wheel`, which locks the box out of root with no way back in from
the box itself, and deleting a group below gid 1000, which is the system's and
cannot be recreated on the same gid.

#### Shared volumes

`share` opens a mounted volume to the `users` group — `2775 root:users`,
setgid, so the first writer does not lock everyone else out. A
provider-attached block volume arrives `root:root 0755` and needs it applied
after the fact:

```sh
./root-ubuntu.sh share /mnt/volume_example -R
```

A directory has exactly one group, so a volume that **both people and a daemon**
write to cannot be said in a mode at all. `--group` adds the second one as a
POSIX ACL — the grant plus the inherited default, so files created later are
covered too:

```sh
./root-ubuntu.sh share /mnt/volume_example --group www-data -R
```

That needs the `acl` package (a run installs it) and a filesystem mounted with
ACL support; `ls -l` then shows a trailing `+` and `getfacl` shows the rest.
`--private` puts a share back to `0700` and strips the ACL with it, because a
mode that says private while a leftover entry still hands the directory to a
daemon is worse than no lock at all.

#### Configuring it

Read from the environment first, then `$SERVER_CONFIG`, then
`/etc/cli-tools/server.conf`. Copy [`server.conf.example`](server.conf.example),
which documents every value:

```sh
install -d -m 0755 /etc/cli-tools
install -m 0600 server.conf.example /etc/cli-tools/server.conf
```

`KEY=value`, one per line, `#` for comments. The file is **read, not sourced**:
nothing in it executes, so `$(…)` in a config file stays literal text instead of
running as root, and the environment still wins over the file. It is not JSON
either — the script runs before apt has put `jq` on the box, and a bootstrap
that cannot read its own config until it has installed a parser has a hole in
it.

**Dotfiles are optional and are not in this repository.** They cannot be: a
dotfiles tree carries ssh config, `known_hosts` and sometimes keys, and this
repo is public. Point `DOTFILES_REPO` at your own and the script clones it;
leave it unset and the box still gets everything else, with each account keeping
whatever dotfiles it already had. Running the script from inside a dotfiles
checkout also works — it recognises one by its content, not its name.

**No credentials, ever, in the file itself.** `ACME_EMAIL` has no default,
because a public script must not ship somebody's address and a made-up one sends
a stranger's certificate warnings into a black hole. There is no default ad slot
for the same shape of reason: a slot id is an account, so shipping one would bill
every box that ever ran this to whoever owned it.

## As a moshcode plugin

This repo is also a plugin marketplace:

```sh
moshcode plugin marketplace add profullstack/cli-tools
moshcode plugin install tools@cli-tools     # /tools:install, /tools:list
moshcode plugin install blog@cli-tools      # /blog:post, :check, :list, :feed
moshcode plugin install domain@cli-tools    # /domain:free, /domain:lookup
moshcode plugin install bo@cli-tools        # /bo:capture, :search, :read, :ask
```

See [plugins/tools](plugins/tools/README.md), [plugins/blog](plugins/blog/README.md),
[plugins/domain](plugins/domain/README.md) and [plugins/bo](plugins/bo/README.md).

`bo` is the one that fronts a command this repo does **not** install.
[BufferOverride](https://bufferoverride.com/docs/cli) ships its own npm package
(`npm i -g @profullstack/bufferoverride`, or `moshcode install bo`) and updates
on its own release cycle, so shipping a second executable of that name from here
would put two implementations on `PATH` and let them drift — the failure `cli-tools
list` marks with `!`. The plugin adds the part an agent needs instead: when to
reach for it, which flag keeps a capture off the internet, and how to read an
answer's version range before repeating it to somebody.

`cli-tools` is also a moshcode workflow tool, so the whole set installs and
updates through moshcode itself:

```sh
moshcode install cli-tools     # then /cli-tools list, /cli-tools update
```

## Aliases

Pit aliases live in `~/.moshcode/aliases.json`. `cli-tools aliases --install`
writes a thin default set, merging rather than replacing — an alias you bound
yourself is kept and the collision is reported. `cli-tools aliases` prints them
without writing anything.

| Alias | Expands to |
| --- | --- |
| `/aff` | `affiliate` |
| `/blog` | `blog-post` |
| `/free` | `domainfree` |
| `/merge` | `gh-prs-merge --apply` |
| `/names` | `free-names` |
| `/prs` | `gh-prs` |
| `/speak` | `tts` |
| `/web` | `ask-web` |
| `/whois` | `domainjson` |

Three of those are named around a collision rather than for elegance. `/ask` and
`/say` are the words you would reach for, and both already resolve to something
else on a normal box; because a pit alias beats `PATH`, binding them would
shadow those programs *from inside the pit only*, which is about the most
confusing failure available. `/tts` would be worse — it would shadow our own
command. Hence `/web`, `/speak` and `/aff`.

`/names` is the one alias that exists because a pipe cannot be aliased at all.
An alias appends what you typed to the end of its expansion, so binding it to
`generate-names -n 100 | domainfree` would put your description after
`domainfree`. That is what [`free-names`](#free-names) is for: the composition
became a command, so the alias could stay thin. It is `/names` and not
`/free-names` because no alias may share a name with a command — a shell
function beats `PATH`, and the two would drift apart.

To manage them by hand:

```
/alias set prs        "gh-prs --orgs profullstack"
/alias set merge      "gh-prs-merge --orgs profullstack --apply --fix"
/alias set merge-dry  "gh-prs-merge --orgs profullstack"
/alias set fixprs     "gh-prs-fix-all"
/alias set feed       "tcfeed"
/alias set whoisj     "domainjson"
/alias set blog       "blog-post"

/alias                # list
/alias get merge      # show one
/alias rm merge       # forget one
```

Arguments append rather than substitute, so `/merge --limit 5` works.

### Why these are files on `PATH`

The older tools carry a comment saying it is because the moshcode pit runs
aliases with `zsh -c`, a non-interactive shell that reads neither `~/.zshrc` nor
`~/.zsh_aliases`. **That is no longer true** — current moshcode runs
`$SHELL -ic`, which is interactive and does source them:

```console
$ zsh -ic 'gh-prs-all --help'   # works — the pit's actual path
$ zsh -c  'gh-prs-all --help'   # zsh:1: command not found
```

The reason to stay on `PATH` is the weaker but sufficient one: a file works from
every caller — an interactive shell, `zsh -c`, a systemd unit, a CI step —
without anything having been sourced first.

Nothing should alias *to* these either. A function beats `PATH`, so a wrapper of
the same name silently shadows the file and the two drift apart.

## Development

```sh
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
```

Tests stub the subprocess layer rather than the network, so `gh` is never
invoked. The suite runs in well under a second; if it starts taking longer,
something is reaching the network that should not be.

**Nothing under `bin/` does work at import time.** Every entry point guards its
side effects with `isMain(import.meta.url)`, and anything worth testing lives in
`src/`. That is not decorative: a test that imported `bin/gh-prs-fix-all.ts` to
reach one pure function *ran the tool*, taking the suite from 60ms to 93 seconds
and sweeping live pull requests with `--fix` implied.

`isMain` resolves the realpath first, because these install as symlinks —
`process.argv[1]` is the link while `import.meta.url` is its target, and
comparing them raw reports "imported" for every installed command at once.

## Why TypeScript

Ported from the bash and JavaScript originals in
[`profullstack/scripts`](https://github.com/profullstack/scripts). The point was
not the language. It was the two things bash was making expensive:

- **Typed, validated responses.** Every `gh` call went through `jq -r` into a
  string compare. `jq -r '.mergeable'` on a response that never had the field
  prints the four characters `null`, which is not `MERGEABLE` — so a perfectly
  mergeable PR read as ineligible *for a reason nobody wrote*, indistinguishable
  from a real verdict. An unrecognised field is now named in an error.
- **Tests.** The originals had none, so verifying a change meant running it
  against live pull requests.

## Differences from the originals

- `gh-prs` prints `No open PRs found.` instead of a bare header row.
- `gh-prs-merge` adds `fixed=` to its summary line.
- `domainjson` is unchanged in structure. DNS answers arrive round-robin, so
  array ordering varies between runs of either version.
