# jobs

Find remote roles worth applying to, and apply through a browser — never twice.

`/jobs:discover` reads a list of companies, finds each one's public job board
on Ashby, Greenhouse, Lever or Workable, and ranks what passes the profile's
filters. `/jobs:apply` fills the queued forms through TronBrowser, dry run
first, and submits only once the user has seen the queue. `/jobs:run` starts,
stops and resumes runs in the background. `/jobs:status` and
`/jobs:history` say where things stand and what happened. `/jobs:profile`
manages who is applying; `/jobs:config` what they are looking for.

The command is `jobhunt`, not `jobs`: `jobs` is a builtin in every POSIX
shell, and a builtin beats `PATH`.

## Install

```bash
moshcode plugin marketplace add profullstack/cli-tools
moshcode plugin install jobs@cli-tools
```

Or install the command directly, without the plugin:

```bash
curl -fsSL https://raw.githubusercontent.com/profullstack/cli-tools/master/install.sh | sh
jobhunt profile add me firstName=… lastName=… email=… resume=~/cv.pdf
jobhunt discover
```

Applying needs [TronBrowser](https://tronbrowser.dev) with `browser_upload`
(`TRON_AUTOMATE_BIN` points at a build until a release has it).

## The thing worth knowing

**It stops rather than guesses.** A required question no rule answers, a
résumé the page does not show as attached, or a required consent or
arbitration box ends the job as `needs-human-review` with the fields named.
Agreeing to terms is the applicant's call, never the tool's.

**Nothing is sent twice.** Every submitted, unverified or skipped posting goes
on one list shared by all profiles, keyed by the job's id rather than its URL,
so the Greenhouse board page, its embed form and a company careers page with
`?gh_jid=` are one job. A run that crashed after its final submit counts that
job as sent.

**Nothing here names a person.** Profiles live in
`~/.config/cli-tools/jobs.json` (0600); the repo ships empty defaults and a
search (remote, US, engineering titles) with no identity in it.
