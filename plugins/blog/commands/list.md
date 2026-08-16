---
description: Every blog post with its publish date, oldest first.
allowed-tools: Bash(blog-post:*)
---

## Task

List the posts on the blog.

```bash
blog-post list
```

Each line is the filename, the `<meta name="date">` value, and the `<h1>`.
`NO-DATE` means `build-feed.mjs` skips that post entirely — run
`/blog:check` for the full diagnosis.

Useful before writing: it shows the next post number, what has been covered
recently, and whether the numbering has a gap.
