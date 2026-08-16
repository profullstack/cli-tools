# blog — publish to the plain-HTML blog 📝

Slash commands wrapping the `blog-post` CLI. The blog at
`~/public_html/blog` has no build step and no CMS: writing a file *is*
publishing. That is the appeal and also the hazard, because nothing catches a
mistake before it is live.

| command | what it does |
| --- | --- |
| `/blog:post <title>` | draft, create and publish a post, then rebuild the feed |
| `/blog:check` | find posts that will break the feed |
| `/blog:list` | every post with its date |
| `/blog:feed` | regenerate `feed.xml` |

## What this stops you doing

**Dating a post in the future.** It sorts above everything real, and readers
that filter future items drop it, so the feed looks like it stopped updating
while every file on disk looks perfect. Three posts once sat 7–10 hours ahead
and did exactly that. `blog-post` refuses a future date unless you insist.

**Omitting `<meta name="date">`.** `build-feed.mjs` skips the post without
saying anything useful.

**Breaking smolweb validity.** The generated template uses an explicit
`<html lang>`, `<meta http-equiv="Content-Type">` rather than a bare
`<meta charset>`, and closes everything.

**Forgetting the AI-drafting acknowledgment.** It goes in every post; Kagi
Small Web and others require disclosure, and the index states the policy.

## Install

```bash
moshcode plugin marketplace add profullstack/cli-tools
moshcode plugin install blog@cli-tools
```

The commands shell out to `blog-post`, which comes from this same repo. It is
not published to npm — clone and link it onto `PATH`:

```sh
git clone git@github.com:profullstack/cli-tools.git ~/src/profullstack/cli-tools
cd ~/src/profullstack/cli-tools
pnpm install
pnpm link:bin
```

Point it at a different blog with `--dir` or `$BLOG_DIR`.
