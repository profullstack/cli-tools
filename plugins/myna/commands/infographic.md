---
description: Render a graphic whose text is exactly the copy chosen for it — and know which backend cannot promise that.
argument-hint: <url or topic>
allowed-tools: Bash(myna:*), Read
---

## Task

Render an infographic for `$ARGUMENTS`.

```bash
myna infographic https://example.com/report --style html
myna infographic "quarterly numbers"                  # --style svg, the default
myna infographic "quarterly numbers" --output /tmp/q3.png --json
```

A positional starting `http://` or `https://` is fetched and read; anything else
is a prompt. It writes a PNG — to `--output` if given, otherwise into a fresh
temp directory whose path it prints — and posting it is a separate step:

```bash
myna post --to bluesky --media /tmp/q3.png "the numbers are in"
```

## Pick the backend for the promise you need

| `--style` | How it renders | Is the text exact? |
| --- | --- | --- |
| `svg` (default) | a built-in template | **yes** — no model touches the pixels |
| `html` | the model writes HTML and CSS, then it is screenshotted at 1200×1200 | **yes** — real text, better design |
| `image` | the whole thing goes to an image model | **no** |

The first two exist precisely because image models rewrite words on the way
through: invented figures, misspelled names, quotes nobody said. Letting the
model choose the copy and rendering it ourselves removes that failure class
entirely.

So `image` is the wrong choice for anything carrying a number, a name or a
quotation. If a graphic made that way is going to be posted, read every word on
it against the source first, and say that you did.

## It needs the writer and a rasterizer

Both, or it refuses:

- A configured writer, as `/myna:draft` describes — the model picks the copy
  even in the `svg` path.
- One of Chrome/Chromium, `rsvg-convert`, ImageMagick or Inkscape on the box,
  or `CHROME_PATH`. Browsers that Playwright or Puppeteer already downloaded
  count.

`myna doctor` lists what it found, and is the fast answer to "why did that fail"
before anything gets reinstalled.

## Flags

`--style`, `--output` and `--keep-svg` all consume a value — the parser has
almost no bare booleans — so it is `--keep-svg=1`, not `--keep-svg`. Colours come
from settings: `infographic.accent`, `infographic.background`,
`infographic.footer`.
