import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { find, glyphMode, search } from '../bin/icon.ts';
import { BRANDS } from '../src/icon-brands.ts';
import { GENERIC } from '../src/icon-set.ts';
import { KEY_PATTERN, brandSvg, build, checkNames, humanName, previewFor, resolveNerd, strokeSvg } from '../src/icon.ts';

const ALL = [...GENERIC, ...BRANDS];

describe('the set', () => {
  it('has the icons a UI needs', () => {
    expect(ALL.length).toBeGreaterThanOrEqual(300);
    for (const key of ['mail', 'phone', 'link', 'search', 'settings', 'terminal', 'git-branch', 'github', 'x', 'bluesky', 'mastodon', 'discord', 'slack', 'signal', 'whatsapp', 'youtube', 'rss', 'npm']) {
      expect(ALL.some((i) => i.key === key), key).toBe(true);
    }
  });

  it('names are kebab-case and every key and alias finds exactly one icon', () => {
    expect(checkNames(ALL)).toEqual([]);
    for (const i of ALL) expect(i.key).toMatch(KEY_PATTERN);
  });

  it('every icon can be drawn in any terminal: a Unicode glyph and 1-4 ASCII characters', () => {
    for (const i of ALL) {
      expect(i.unicode.length, i.key).toBeGreaterThan(0);
      // Printable ASCII, spaces only inside ("[ ]" is a checkbox, " x" is not).
      expect(i.ascii, i.key).toMatch(/^[\x21-\x7e]([\x20-\x7e]{0,2}[\x21-\x7e])?$/);
    }
  });

  it('drawn icons stay on the 24 grid', () => {
    for (const i of GENERIC) {
      for (const n of i.body.match(/-?(\d+(\.\d+)?|\.\d+)/g) ?? []) expect(Math.abs(Number(n)), i.key).toBeLessThanOrEqual(24);
    }
  });

  it('brands come from a licensed source, never drawn here', () => {
    for (const b of BRANDS) expect(['simple-icons', 'font-awesome']).toContain(b.source);
  });
});

describe('glyphs', () => {
  const table = { 'md-email': { char: '\u{f01ee}', code: 'f01ee' }, 'fa-envelope': { char: '', code: 'f0e0' } };

  it('takes the first Nerd Font name the release has', () => {
    expect(resolveNerd(['md-email_outline', 'md-email', 'fa-envelope'], table)).toEqual({
      nerd: '\u{f01ee}',
      nerd_code: 'f01ee',
      nerd_name: 'md-email',
    });
    expect(resolveNerd(['nope'], table)).toEqual({});
  });

  it('picks nerd, then unicode, then ascii from the environment', () => {
    expect(glyphMode({ OPENICON_GLYPHS: 'ascii', NERD_FONT: '1' })).toBe('ascii');
    expect(glyphMode({ NERD_FONT: '1' })).toBe('nerd');
    expect(glyphMode({ LANG: 'en_US.UTF-8' })).toBe('unicode');
    expect(glyphMode({ LANG: 'C' })).toBe('ascii');
  });

  it('finds by key or alias, searches keywords', () => {
    expect(find('email')?.key).toBe('mail');
    expect(find('twitter')?.key).toBe('x');
    expect(search(['money']).map((i) => i.key)).toContain('wallet');
  });
});

describe('drawing', () => {
  it('stroke icons use currentColor and one weight', () => {
    const svg = strokeSvg('<path d="M5 12h14"/>', 'Minus');
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).toContain('stroke-width="2"');
    expect(svg).toContain('<title>Minus</title>');
  });

  it('a brand logo is scaled into the 20x20 live area and centred', () => {
    const svg = brandSvg('<svg viewBox="0 0 448 512"><path fill="currentColor" d="M0 0h448v512H0z"/></svg>', 'Box');
    expect(svg).toContain('fill="currentColor"');
    // 512 tall -> 20 units, so 448 wide -> 17.5, centred at x = 2 + 1.25.
    expect(svg).toContain('translate(3.25 2) scale(0.03906)');
  });

  it('names read like words', () => {
    expect(humanName('git-pull-request')).toBe('Git pull request');
  });
});

describe('build', () => {
  it('writes the OpenIcon layout offline', async () => {
    const out = await mkdtemp(join(tmpdir(), 'openicon-'));
    const cache = await mkdtemp(join(tmpdir(), 'openicon-cache-'));
    const fetchImpl = (async (url: string) => {
      if (url.endsWith('glyphnames.json')) {
        return new Response(JSON.stringify({ 'md-email': { char: '\u{f01ee}', code: 'f01ee' }, 'md-github': { char: '\u{f02a4}', code: 'f02a4' } }));
      }
      return new Response('<svg viewBox="0 0 24 24"><title>X</title><path d="M0 0h24v24H0z"/></svg>');
    }) as typeof fetch;
    const manifest = await build({
      out,
      sizes: [16, 32],
      color: '#000',
      only: ['mail', 'github', 'slack'],
      fetchImpl,
      env: { XDG_CACHE_HOME: cache },
      log: () => {},
      render: () => Buffer.from('png'),
    });

    expect(manifest).toMatchObject({ openicon: '0.1', made_by: 'ai', grid: { size: 24, stroke: 2, padding: 2 } });
    const mail = manifest.icons.find((i) => i.key === 'mail')!;
    expect(mail).toMatchObject({ category: 'communication', aliases: ['email', 'envelope'], svg: 'svg/mail.svg' });
    expect(mail.tui).toMatchObject({ nerd: '\u{f01ee}', nerd_name: 'md-email', unicode: '✉', ascii: '@' });

    const github = manifest.icons.find((i) => i.key === 'github')!;
    expect(github).toMatchObject({ brand: true, license: 'CC0-1.0', made_by: 'human', source: 'simple-icons:github' });
    expect(github.trademark).toContain('trademark');
    const slack = manifest.icons.find((i) => i.key === 'slack')!;
    expect(slack).toMatchObject({ license: 'CC-BY-4.0', source: 'font-awesome:slack' });
    // No Nerd glyph in this table for Slack: the icon still has its fallbacks.
    expect(slack.tui.nerd).toBeUndefined();
    expect(slack.tui.ascii).toBe('slk');

    expect(existsSync(join(out, 'png', '32', 'mail.png'))).toBe(true);
    expect(await readFile(join(out, 'sprite.svg'), 'utf8')).toContain('<symbol id="oi-mail"');
    expect(await readFile(join(out, 'svg', 'github.svg'), 'utf8')).toContain('<title>GitHub</title>');
  });
});

describe('previewFor', () => {
  const manifest = (styled: boolean) =>
    ({
      openicon: '0.1',
      icons: [
        {
          key: 'mail',
          category: 'communication',
          svg: 'svg/mail.svg',
          tui: { unicode: '✉', ascii: '@' },
          ...(styled
            ? { styles: { 'agentic-matte': { png: 'styles/agentic-matte/png/{size}/mail.png', webp: 'styles/agentic-matte/webp/{size}/mail.webp', made_by: 'ai' } } }
            : {}),
        },
      ],
      categories: { communication: 'Communication' },
      styles: ['simple', 'agentic-matte'],
      style_info: { 'agentic-matte': { label: 'Agentic Matte', material: 'Flat tonal planes.' } },
    }) as unknown as Parameters<typeof previewFor>[0];

  const svgs = new Map([['mail', '<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>']]);

  it('offers a style switcher only once the icons carry that style', () => {
    // The page `build` writes comes before any style is applied: nothing to switch to.
    const bare = previewFor(manifest(false), svgs);
    expect(bare).not.toContain('style-agentic-matte');

    const withStyles = previewFor(manifest(true), svgs);
    expect(withStyles).toContain('id="style-agentic-matte"');
    expect(withStyles).toContain('Agentic Matte');
    expect(withStyles).toContain('styles/agentic-matte/webp/64/mail.webp');
    // Simple is what a page opens on, and the switch needs no script.
    expect(withStyles).toContain('id="style-simple" checked');
    expect(withStyles).not.toContain('<script');
  });
});
