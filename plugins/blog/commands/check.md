---
description: Find posts that will break the RSS feed — missing dates, future dates, empty summaries.
allowed-tools: Bash(blog-post:*), Read, Edit
---

## Task

Check the blog for posts that will not appear correctly in the feed.

```bash
blog-post check
```

## What it looks for

- **A date in the future.** The important one. Such a post sorts above every
  real post and is dropped entirely by readers that hide future items, so the
  feed appears to have stopped updating while everything looks fine on disk.
  Three posts once sat 7&ndash;10 hours ahead and did exactly that.
- **No `<meta name="date">`.** `build-feed.mjs` skips the post silently.
- **An unparseable date.** Same outcome, also silent.
- **No `<meta name="description">`.** The item ships with an empty summary.
- **No `<h1>`.** The feed title falls back to `<title>`, which carries the
  site-name suffix.

## Fixing

Edit the offending `<meta>` in the post, then rebuild:

```bash
blog-post feed
```

For a wrong date, prefer the file's real modification time over inventing one —
that is the best evidence of when the post was actually written.

Exit status is non-zero when anything is wrong, so this is usable as a gate.
