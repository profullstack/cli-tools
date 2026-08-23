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
| [`blog-post`](#blog-post) | Publish to a plain-HTML blog without breaking the feed |
| [`ask-web`](#ask-web) | Answer a question from the live web, with its sources |
| [`tts`](#tts) | Read text aloud and keep the audio |
| [`affiliate`](#affiliate) | Work through a list of programs you mean to sign up for |
| [`genrewatch`](#genrewatch) | What is coming out, and whether it exists at all |
| [`img`](#img) | Resize, convert and inspect images, with sharp or ImageMagick |
| [`vid`](#vid) | Inspect, thumbnail, clip and shrink video, through ffmpeg |
| [`codeburn`](#codeburn) | See where your AI spend goes, by task, tool, model and project |

## Requirements

- **Node 20+**
- **[`gh`](https://cli.github.com/)**, authenticated (`gh auth status`) — every
  `gh-prs*` command shells out to it
- **`dig`** at `/usr/bin/dig` — `domainjson` only
- **[OpenRDAP](https://github.com/openrdap/rdap)** (`rdap` on `PATH`, or
  `~/go/bin/rdap`) — `domainjson` only, and it degrades to DNS-only without it
- **`ffmpeg`** — `vid` only, and it is a hard requirement rather than a
  degradation: nothing on npm decodes video the way sharp handles images
- **ImageMagick** (`magick`) — `img` only, and only for what sharp cannot do
  (PDF, PSD, animated GIF); sharp ships with this repo as an optional dependency
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

With moshcode on the box, the same thing:

```sh
moshcode install cli-tools     # then /cli-tools … in the pit
```

Check what landed, and wire up the pit aliases:

```sh
cli-tools list                 # * runs from here, ! is shadowed by another copy
cli-tools aliases --install    # /aff /blog /free /merge /prs /speak /web /whois
cli-tools config               # API keys: what is set, and where it came from
cli-tools update               # git pull, reinstall, relink
cli-tools autoupdate --install # …or have a timer do that daily
```

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

Four commands here call a paid API: `generate-names` (OpenAI or Anthropic),
`ask-web` (Perplexity) and `tts` (ElevenLabs). Store the keys once, and nothing
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
| `openai` | `OPENAI_API_KEY` | `generate-names` |
| `anthropic` | `ANTHROPIC_API_KEY` | `generate-names` |
| `perplexity` | `PERPLEXITY_API_KEY` | `ask-web` |
| `elevenlabs` | `ELEVENLABS_API_KEY` | `tts` |

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
img icons logo.png --out public/      # the favicon/PWA set
```

**It never enlarges by default.** Scaling a 96px mark up to 512 produces a
blurry file that looks like a bug in whatever renders it, so that needs
`--force`.

Two engines: `sharp` arrives with this repo as an optional dependency and is
fast; ImageMagick is a system binary and handles PDF, PSD and animated GIF,
which sharp does not. `--engine` picks.

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
