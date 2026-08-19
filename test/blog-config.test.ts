import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  applyEnv,
  configPaths,
  EMPTY_CONFIG,
  loadBlogConfig,
  normalizeConfig,
} from '../src/blog-config.ts';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'blog-config-'));
  dirs.push(dir);
  return dir;
}

describe('configPaths', () => {
  it('prefers $BLOG_CONFIG, then the blog dir, then the user config dir', () => {
    const paths = configPaths('/blog', {
      BLOG_CONFIG: '/explicit.json',
      XDG_CONFIG_HOME: '/xdg',
    } as NodeJS.ProcessEnv);

    expect(paths).toEqual(['/explicit.json', '/blog/blog.config.json', '/xdg/cli-tools/blog.json']);
  });

  it('still offers the user config dir when no blog dir is known', () => {
    const paths = configPaths(undefined, { XDG_CONFIG_HOME: '/xdg' } as NodeJS.ProcessEnv);
    expect(paths).toEqual(['/xdg/cli-tools/blog.json']);
  });
});

describe('normalizeConfig', () => {
  it('reads a full config', () => {
    const config = normalizeConfig({
      siteTitle: 'A Blog',
      author: 'Some One',
      disclosure: 'drafted then edited',
      links: [{ label: 'GitHub', href: 'https://github.com/someone' }],
      trackerSiteId: 'site',
      adSlotId: 'slot',
      adFormat: 'banner_728x90',
    });

    expect(config.author).toBe('Some One');
    expect(config.links).toEqual([{ label: 'GitHub', href: 'https://github.com/someone' }]);
    expect(config.adFormat).toBe('banner_728x90');
  });

  it('keeps a link rel when one is given', () => {
    const config = normalizeConfig({
      links: [{ label: 'home', href: 'https://example.com', rel: 'author' }],
    });
    expect(config.links[0]).toEqual({ label: 'home', href: 'https://example.com', rel: 'author' });
  });

  // A half-written link would otherwise render as an empty or hrefless anchor
  // on every future post, which nothing else would catch.
  it('drops links missing a label or an href, and non-objects', () => {
    const config = normalizeConfig({
      links: [
        { label: 'ok', href: 'https://example.com' },
        { label: 'no href' },
        { href: 'https://example.com/no-label' },
        'nonsense',
        null,
      ],
    });
    expect(config.links).toEqual([{ label: 'ok', href: 'https://example.com' }]);
  });

  it('treats blank strings and wrong types as absent', () => {
    const config = normalizeConfig({ author: '   ', siteTitle: 42, links: 'no' });
    expect(config.author).toBeNull();
    expect(config.siteTitle).toBeNull();
    expect(config.links).toEqual([]);
  });

  it('falls back to the empty config for junk input', () => {
    expect(normalizeConfig(null)).toEqual(EMPTY_CONFIG);
    expect(normalizeConfig('nope')).toEqual(EMPTY_CONFIG);
  });
});

describe('applyEnv', () => {
  it('lets the environment override the file', () => {
    const config = applyEnv({ ...EMPTY_CONFIG, author: 'From File' }, {
      BLOG_AUTHOR: 'From Env',
      CRAWLPROOF_SITE_ID: 'site',
    } as NodeJS.ProcessEnv);

    expect(config.author).toBe('From Env');
    expect(config.trackerSiteId).toBe('site');
  });

  it('leaves the file value alone when the variable is unset', () => {
    const config = applyEnv({ ...EMPTY_CONFIG, author: 'From File' }, {} as NodeJS.ProcessEnv);
    expect(config.author).toBe('From File');
  });
});

describe('loadBlogConfig', () => {
  it('returns the empty config when nothing is configured', async () => {
    const dir = await tmp();
    const config = await loadBlogConfig(dir, { XDG_CONFIG_HOME: dir } as NodeJS.ProcessEnv);
    expect(config).toEqual(EMPTY_CONFIG);
  });

  it('reads the blog directory config', async () => {
    const dir = await tmp();
    await writeFile(join(dir, 'blog.config.json'), JSON.stringify({ author: 'Some One' }));

    const config = await loadBlogConfig(dir, { XDG_CONFIG_HOME: dir } as NodeJS.ProcessEnv);
    expect(config.author).toBe('Some One');
  });

  // Silently publishing a post stripped of the author's identity is worse than
  // refusing to publish one, so bad JSON is an error rather than a fallback.
  it('refuses malformed JSON, naming the file', async () => {
    const dir = await tmp();
    const path = join(dir, 'blog.config.json');
    await writeFile(path, '{ not json');

    await expect(
      loadBlogConfig(dir, { XDG_CONFIG_HOME: dir } as NodeJS.ProcessEnv),
    ).rejects.toThrow(path);
  });
});
