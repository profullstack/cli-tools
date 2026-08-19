---
description: Draft and publish a new blog post, then regenerate the feed.
argument-hint: <title>
allowed-tools: Bash(blog-post:*), Bash(node:*), Read, Write, Edit
---

## Task

Write and publish a post titled `$ARGUMENTS` on the plain-HTML blog.

The blog has **no build step** — writing the file *is* publishing — so get it
right the first time rather than fixing it live.

## Steps

1. **Draft the body first**, as a fragment: `<h2>` sections and closed `<p>`
   elements only. No `<html>`, `<head>` or `<body>` — the tool wraps it. Write
   it to a scratch file.

2. **Write a one-line description.** It becomes the RSS summary and the
   `<meta name="description">`, so it has to stand alone in a reader with no
   surrounding page. One sentence, concrete, no "in this post I".

3. **Create the post:**

   ```bash
   blog-post new "$ARGUMENTS" -d "<the one-line description>" --body /path/to/body.html
   ```

   That picks the next `NNN-post.html`, renders the template, splices the entry
   into `index.html`, and runs `build-feed.mjs`.

4. **Verify:**

   ```bash
   blog-post check
   ```

## Rules

- **Never pass `--date` in the future.** A future-dated post pins itself above
  every real post and is hidden outright by readers that filter future items —
  the feed looks dead while the files on disk look perfect. This has already
  happened once. `blog-post` refuses it unless you pass `--allow-future`, and
  you almost never mean to.
- **Keep the AI-drafting acknowledgment** the template inserts. Kagi Small Web
  and others require disclosure of heavy LLM use, and the index states the
  policy. It comes from the `disclosure` field of the blog config, so if a post
  renders without one, run `blog-post config` rather than pasting it by hand.
- **Stay smolweb-valid**: every `<p>` closed, no bare `<meta charset>`, no
  unclosed tags. The template handles the shell; your body has to hold up its
  end.
- **Match the voice of the existing posts.** Read one or two first. They are
  first-person, specific, and do not oversell.
- Entities over literal punctuation in prose: `&mdash;`, `&ldquo;`, `&rdquo;`.
