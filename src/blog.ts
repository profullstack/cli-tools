import { readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The plain-HTML blog at ~/public_html/blog.
 *
 * That blog has no build step and no CMS — writing a file *is* publishing — so
 * every convention it depends on lives only in the files already there, and
 * nothing catches a mistake before it is live. This module holds the
 * conventions so a new post cannot quietly get one wrong.
 */

export const DEFAULT_DIR = join(homedir(), 'public_html', 'blog');

const POST_RE = /^(\d+)-post\.html$/;

export interface Post {
  file: string;
  n: number;
  date: string | null;
  title: string | null;
  description: string | null;
}

export interface NewPost {
  title: string;
  description: string;
  /** ISO 8601, e.g. 2026-08-16T10:04:00Z */
  date: string;
  /** HTML fragment: h2/p only, no document shell. */
  body?: string;
}

export interface Problem {
  file: string;
  problem: string;
}

/** Where the blog lives: an explicit path wins, then $BLOG_DIR, then the default. */
export function blogDir(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  return explicit || env.BLOG_DIR || DEFAULT_DIR;
}

/** Escape text for an HTML attribute or element body. */
export function esc(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Apply the blog's typographic conventions to a title.
 *
 * The existing posts use HTML entities rather than literal punctuation. Only
 * the entities already in use are emitted, because smolweb validity requires
 * every entity to be one XML defines or a numeric one.
 */
export function typogrify(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/ -- | — /g, ' &mdash; ')
    .replace(/"([^"]+)"/g, '&ldquo;$1&rdquo;')
    .replace(/'/g, '&rsquo;');
}

function match(html: string, re: RegExp): string | null {
  const found = html.match(re);
  return found?.[1] ? found[1].trim() : null;
}

/** Every post file with its number, date, title and description. */
export async function readPosts(dir: string): Promise<Post[]> {
  const files = (await readdir(dir)).filter((file) => POST_RE.test(file));
  const posts: Post[] = [];

  for (const file of files.sort()) {
    const html = await readFile(join(dir, file), 'utf8');
    posts.push({
      file,
      n: Number(POST_RE.exec(file)![1]),
      date: match(html, /<meta\s+name="date"\s+content="([^"]+)"/i),
      description: match(html, /<meta\s+name="description"\s+content="([^"]+)"/i),
      title: match(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i),
    });
  }

  return posts.sort((a, b) => a.n - b.n);
}

/** Next post number, zero-padded, following the highest that exists. */
export function nextNumber(posts: readonly Pick<Post, 'n'>[]): string {
  const highest = posts.reduce((max, post) => Math.max(max, post.n), 0);
  return String(highest + 1).padStart(3, '0');
}

/**
 * Render a post file.
 *
 * Deliberately smolweb-valid, which is stricter than "valid HTML": an explicit
 * `<html lang>`, `<head>` and `<body>`; `<meta http-equiv="Content-Type">`
 * rather than a bare `<meta charset>`, because every `<meta>` needs a `content`
 * attribute; and every `<p>` closed.
 */
export function renderPost({ title, description, date, body = '' }: NewPost): string {
  const day = date.slice(0, 10);
  const heading = typogrify(title);
  const content = body.trim() || '<h2>Start here</h2>\n\n<p>&hellip;</p>';

  return `<!doctype html>
<html lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${heading} &mdash; Chovy's Blog</title>
<link rel="alternate" type="application/rss+xml" title="Chovy's Blog" href="feed.xml">
<meta name="date" content="${esc(date)}">
<meta name="description" content="${esc(description)}">
</head>
<body>

<article>

<h1>${heading}</h1>

<p><em>${day}, by Anthony &ldquo;chovy&rdquo; Ettinger.</em></p>

<p><small><strong>How this was written:</strong> drafted with an AI assistant from my own notes,
then edited by me.</small></p>

<nav>
	<a href="../blog">back to my blog postings</a>
</nav>

${content}

<nav>
	<a href="../blog">back to my blog postings</a>
</nav>

</article>

</body>
</html>
`;
}

/**
 * Splice a post into index.html's list, newest first.
 *
 * index.html is hand-maintained — build-feed.mjs never touches it — which is
 * exactly why it drifts. Inserting one `<li>` leaves the rest of the page as
 * the author wrote it.
 */
export function insertIntoIndex(
  html: string,
  post: { file: string; title: string; date: string },
): string {
  if (html.includes(`href="${post.file}"`)) return html;

  const open = html.indexOf('<ul>');
  if (open === -1) return html;

  const day = post.date.slice(0, 10);
  const li = `\t<li><a href="${post.file}">${typogrify(post.title)}</a> &mdash; ${day}</li>`;
  const at = open + '<ul>'.length;

  return `${html.slice(0, at)}\n${li}${html.slice(at)}`;
}

/**
 * Problems that make a post invisible or mis-sorted in the feed.
 *
 * The future-date check is the one that matters. A post dated ahead of now pins
 * itself above every real post *and* is dropped outright by readers that filter
 * future items, so the feed looks like it stopped updating while every file on
 * disk looks perfect. Three posts once sat 7-10 hours ahead and did exactly
 * that; nothing else surfaced it.
 */
export function lint(posts: readonly Post[], now: number = Date.now()): Problem[] {
  const problems: Problem[] = [];

  for (const post of posts) {
    if (!post.date) {
      problems.push({ file: post.file, problem: 'no <meta name="date"> — build-feed.mjs skips it' });
      continue;
    }

    const when = new Date(post.date);
    if (Number.isNaN(when.getTime())) {
      problems.push({ file: post.file, problem: `unparseable date "${post.date}"` });
    } else if (when.getTime() > now) {
      problems.push({
        file: post.file,
        problem: `dated in the future (${post.date}) — pins to the top of the feed and readers may hide it`,
      });
    }

    if (!post.description) {
      problems.push({
        file: post.file,
        problem: 'no <meta name="description"> — empty feed summary',
      });
    }
    if (!post.title) {
      problems.push({ file: post.file, problem: 'no <h1> — feed falls back to <title>' });
    }
  }

  return problems;
}

/** Write the next post and list it in index.html. */
export async function createPost(
  dir: string,
  post: NewPost,
): Promise<{ file: string; path: string }> {
  const posts = await readPosts(dir);
  const file = `${nextNumber(posts)}-post.html`;
  const path = join(dir, file);

  // 'wx' rather than a plain write: two concurrent runs both read the directory
  // before either writes, so both pick the same number. Losing a post to that
  // race would be invisible until somebody noticed it missing.
  await writeFile(path, renderPost(post), { flag: 'wx' });

  const indexPath = join(dir, 'index.html');
  const index = await readFile(indexPath, 'utf8');
  await writeFile(indexPath, insertIntoIndex(index, { file, title: post.title, date: post.date }));

  return { file, path };
}

/** ISO 8601 with the milliseconds trimmed, matching the format the posts use. */
export function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, 'Z');
}
