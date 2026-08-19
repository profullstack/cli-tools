import { readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { type BlogConfig, type BlogLink, EMPTY_CONFIG } from './blog-config.ts';

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
 * CrawlProof's cookieless pageview tracker, on every page of the blog.
 *
 * This is the one deliberate departure from smolweb validity: the guidelines
 * forbid scripts served from another host. Nothing on the page depends on it —
 * the post reads identically with JavaScript off — so the "usable without
 * JavaScript" half of the rule still holds.
 *
 * With no site id configured nothing is emitted at all, which is the fully
 * valid case — and the default, so a fresh checkout never meters somebody
 * else's traffic into an account it inherited from the repository.
 */
export function tracker(siteId: string | null): string {
  if (!siteId) return '';
  return `<script data-site="${esc(siteId)}" src="https://crawlproof.com/stats.js" async></script>`;
}

/**
 * The sponsored bar that runs at the foot of every page.
 *
 * `text_link` by default, not a 728x90 or 300x250: it is a 40px full-width
 * strip that carries its own "Sponsored" mark inside the frame, so `ad.js`
 * prepends no extra caption, and an unsold or blocked slot collapses to
 * nothing instead of leaving a banner-shaped hole.
 *
 * The slot id is the author's own, so it is configuration rather than a
 * constant: a shared one would bill every installation's impressions to
 * whoever happened to be in the file. `ad.js` loads only when there is a slot
 * for it to fill, and the tracker is emitted here so no page carries it twice.
 */
export function adUnit(
  config: Pick<BlogConfig, 'adSlotId' | 'adFormat' | 'trackerSiteId'>,
): string {
  const tag = tracker(config.trackerSiteId);
  if (!config.adSlotId) return tag;

  const slot =
    `<aside data-cp-ad data-slot="${esc(config.adSlotId)}"` +
    ` data-format="${esc(config.adFormat)}"></aside>`;

  return [slot, '', tag, '<script src="https://crawlproof.com/ad.js" async></script>']
    .filter((line, index, all) => line !== '' || all[index + 1] !== '')
    .join('\n');
}

/** The footer identity links, or nothing when none are configured. */
function identity(links: readonly BlogLink[]): string {
  if (links.length === 0) return '';
  const anchors = links.map(
    (link) => `<a rel="${esc(link.rel ?? 'me')}" href="${esc(link.href)}">${esc(link.label)}</a>`,
  );
  return `\n<p>Find me: ${anchors.join(' &middot;\n')}</p>\n`;
}

/**
 * Render a post file.
 *
 * Deliberately smolweb-valid, which is stricter than "valid HTML": an explicit
 * `<html lang>`, `<head>` and `<body>`; `<meta http-equiv="Content-Type">`
 * rather than a bare `<meta charset>`, because every `<meta>` needs a `content`
 * attribute; and every `<p>` closed. The one exception is {@link tracker}, the
 * external analytics tag, which smolweb's no-third-party-script rule forbids —
 * and which is absent unless a site id is configured.
 *
 * Everything identifying the author comes from {@link BlogConfig}. Rendered
 * with the default config the post carries no byline, no identity links and no
 * third-party scripts, so a checkout cannot publish somebody else's name or
 * meter traffic into an account it inherited from the repository.
 */
export function renderPost(
  { title, description, date, body = '' }: NewPost,
  config: BlogConfig = EMPTY_CONFIG,
): string {
  const day = date.slice(0, 10);
  const heading = typogrify(title);
  const content = body.trim() || '<h2>Start here</h2>\n\n<p>&hellip;</p>';

  // esc rather than typogrify: the site name is emitted identically in the
  // <title> and in the feed link's title attribute, and an attribute is the
  // stricter of the two. The byline is typogrified because a byline is prose.
  const site = config.siteTitle ? ` &mdash; ${esc(config.siteTitle)}` : '';
  const feedTitle = config.siteTitle ? ` title="${esc(config.siteTitle)}"` : '';
  const byline = config.author
    ? `<p><em>${day}, by ${typogrify(config.author)}.</em></p>`
    : `<p><em>${day}</em></p>`;
  const disclosure = config.disclosure
    ? `\n\n<p><small>${typogrify(config.disclosure)}</small></p>`
    : '';
  const footer = adUnit(config);

  return `<!doctype html>
<html lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${heading}${site}</title>
<link rel="alternate" type="application/rss+xml"${feedTitle} href="feed.xml">
<meta name="date" content="${esc(date)}">
<meta name="description" content="${esc(description)}">
</head>
<body>

<article>

<h1>${heading}</h1>

${byline}${disclosure}

<nav>
	<a href="../blog">back to my blog postings</a>
</nav>

${content}

<nav>
	<a href="../blog">back to my blog postings</a>
</nav>
${identity(config.links)}
</article>
${footer ? `\n${footer}\n` : ''}
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
  config: BlogConfig = EMPTY_CONFIG,
): Promise<{ file: string; path: string }> {
  const posts = await readPosts(dir);
  const file = `${nextNumber(posts)}-post.html`;
  const path = join(dir, file);

  // 'wx' rather than a plain write: two concurrent runs both read the directory
  // before either writes, so both pick the same number. Losing a post to that
  // race would be invisible until somebody noticed it missing.
  await writeFile(path, renderPost(post, config), { flag: 'wx' });

  const indexPath = join(dir, 'index.html');
  const index = await readFile(indexPath, 'utf8');
  await writeFile(indexPath, insertIntoIndex(index, { file, title: post.title, date: post.date }));

  return { file, path };
}

/** ISO 8601 with the milliseconds trimmed, matching the format the posts use. */
export function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, 'Z');
}
