import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  blogDir,
  createPost,
  DEFAULT_DIR,
  esc,
  insertIntoIndex,
  isoSeconds,
  lint,
  nextNumber,
  readPosts,
  renderPost,
  typogrify,
  type Post,
} from '../src/blog.ts';

const NOW = Date.parse('2026-08-16T11:00:00Z');

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A throwaway blog directory holding one post and an index. */
async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'blog-'));
  dirs.push(dir);

  await writeFile(
    join(dir, '001-post.html'),
    renderPost({ title: 'First', description: 'the first one', date: '2026-08-14T11:21:00Z' }),
  );
  await writeFile(
    join(dir, 'index.html'),
    '<!doctype html>\n<html lang="en">\n<body>\n<h1>Blog</h1>\n<ul>\n\t<li><a href="001-post.html">First</a> &mdash; 2026-08-14</li>\n</ul>\n</body>\n</html>\n',
  );

  return dir;
}

const post = (over: Partial<Post> & Pick<Post, 'file'>): Post => ({
  n: 1,
  date: '2026-08-16T09:00:00Z',
  title: 't',
  description: 'd',
  ...over,
});

describe('blogDir', () => {
  it('prefers an explicit path, then $BLOG_DIR, then the default', () => {
    expect(blogDir('/tmp/x', {})).toBe('/tmp/x');
    expect(blogDir(undefined, { BLOG_DIR: '/tmp/y' })).toBe('/tmp/y');
    expect(blogDir(undefined, {})).toBe(DEFAULT_DIR);
  });
});

describe('nextNumber', () => {
  it('pads and follows the highest existing post, not the last', () => {
    expect(nextNumber([])).toBe('001');
    expect(nextNumber([{ n: 1 }, { n: 2 }])).toBe('003');
    expect(nextNumber([{ n: 11 }, { n: 2 }])).toBe('012');
    expect(nextNumber([{ n: 9 }])).toBe('010');
  });
});

describe('esc and typogrify', () => {
  it('escapes what would break an attribute', () => {
    expect(esc('a & b')).toBe('a &amp; b');
    expect(esc('say "hi"')).toBe('say &quot;hi&quot;');
    expect(esc('<script>')).toBe('&lt;script&gt;');
  });

  it('matches the entity style the existing posts use', () => {
    expect(typogrify('a -- b')).toBe('a &mdash; b');
    expect(typogrify('the "best" thing')).toBe('the &ldquo;best&rdquo; thing');
    expect(typogrify("don't")).toBe('don&rsquo;t');
    expect(typogrify('rock & roll')).toBe('rock &amp; roll');
  });
});

describe('renderPost', () => {
  const html = renderPost({
    title: 'A Post',
    description: 'about things',
    date: '2026-08-16T10:00:00Z',
  });

  it('emits the smolweb-valid shape the blog requires', () => {
    expect(html).toContain('<html lang="en">');
    // http-equiv rather than a bare charset: every <meta> needs a content attribute.
    expect(html).toContain('<meta http-equiv="Content-Type" content="text/html; charset=utf-8">');
    expect(html).not.toMatch(/<meta charset/);
    expect(html).toContain('<meta name="date" content="2026-08-16T10:00:00Z">');
    expect(html).toContain('<meta name="description" content="about things">');
    expect(html).toContain('<h1>A Post</h1>');
    expect(html).toContain('href="feed.xml"');
  });

  it('keeps the AI-drafting acknowledgment, which is required disclosure', () => {
    expect(html).toContain('How this was written:');
  });

  it('escapes a description that tries to break out of its attribute', () => {
    const hostile = renderPost({
      title: 'x',
      description: '" onload="alert(1)',
      date: '2026-08-16T10:00:00Z',
    });
    expect(hostile).not.toContain('onload="alert(1)"');
    expect(hostile).toContain('&quot;');
  });
});

describe('insertIntoIndex', () => {
  const index = '<ul>\n\t<li><a href="001-post.html">First</a> &mdash; 2026-08-14</li>\n</ul>';
  const second = { file: '002-post.html', title: 'Second', date: '2026-08-16T10:00:00Z' };

  it('splices one li at the top', () => {
    const once = insertIntoIndex(index, second);
    expect(once).toContain('href="002-post.html"');
    expect(once.indexOf('002-post.html')).toBeLessThan(once.indexOf('001-post.html'));
  });

  it('is idempotent', () => {
    const once = insertIntoIndex(index, second);
    expect(insertIntoIndex(once, second)).toBe(once);
  });
});

describe('lint', () => {
  it('catches a future date — the failure that made the live feed look dead', () => {
    const problems = lint([post({ file: 'a.html', date: '2026-08-16T21:00:00Z' })], NOW);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.problem).toMatch(/future/);
  });

  it('catches the silent feed-generator skips', () => {
    const problems = lint(
      [
        post({ file: 'b.html', date: null }),
        post({ file: 'c.html', date: 'not-a-date' }),
        post({ file: 'd.html', description: null }),
        post({ file: 'e.html', title: null }),
      ],
      NOW,
    );

    const forFile = (file: string) =>
      problems.filter((p) => p.file === file).map((p) => p.problem).join(' ');

    expect(forFile('b.html')).toMatch(/no <meta name="date">/);
    expect(forFile('c.html')).toMatch(/unparseable/);
    expect(forFile('d.html')).toMatch(/description/);
    expect(forFile('e.html')).toMatch(/no <h1>/);
  });

  it('reports nothing for a healthy post, including one dated exactly now', () => {
    expect(lint([post({ file: 'ok.html' })], NOW)).toEqual([]);
    expect(lint([post({ file: 'ok.html', date: '2026-08-16T11:00:00Z' })], NOW)).toEqual([]);
  });
});

describe('createPost', () => {
  it('writes the next post, lists it, and produces something that lints clean', async () => {
    const dir = await fixture();

    const { file } = await createPost(dir, {
      title: 'Second Post',
      description: 'number two',
      date: '2026-08-16T10:00:00Z',
    });
    expect(file).toBe('002-post.html');

    const posts = await readPosts(dir);
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({
      title: 'Second Post',
      date: '2026-08-16T10:00:00Z',
      description: 'number two',
    });

    const index = await readFile(join(dir, 'index.html'), 'utf8');
    expect(index).toContain('href="002-post.html"');
    expect(index.indexOf('002-post')).toBeLessThan(index.indexOf('001-post'));

    expect(lint(posts, Date.parse('2026-08-17T00:00:00Z'))).toEqual([]);
  });

  it('cannot lose a post to two concurrent runs', async () => {
    const dir = await fixture();

    // Both calls read the directory before either writes, so both pick 002.
    // The 'wx' flag is what stops the loser from silently replacing the winner.
    const results = await Promise.allSettled([
      createPost(dir, { title: 'Racer A', description: 'a', date: '2026-08-16T10:00:00Z' }),
      createPost(dir, { title: 'Racer B', description: 'b', date: '2026-08-16T10:00:00Z' }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/EEXIST/);

    const posts = await readPosts(dir);
    expect(posts).toHaveLength(2);
    expect(posts[1]!.title).toMatch(/^Racer [AB]$/);
  });
});

describe('isoSeconds', () => {
  it('trims milliseconds to match the format the posts use', () => {
    expect(isoSeconds(new Date('2026-08-16T10:04:00.123Z'))).toBe('2026-08-16T10:04:00Z');
  });
});
