---
description: Regenerate feed.xml from the posts on disk.
allowed-tools: Bash(blog-post:*), Bash(node:*)
---

## Task

Rebuild the RSS feed.

```bash
blog-post feed
```

This runs the blog's own `build-feed.mjs`, which is the single source of truth
for the feed's shape. It keeps the **10 most recent** posts and trims the rest,
and warns about any post dated in the future.

Run it after editing a post's title, date or description by hand —
`/blog:post` already does it for you when creating one.

The feed is served straight off disk, so it is live the moment the file is
written. There is nothing to deploy.
