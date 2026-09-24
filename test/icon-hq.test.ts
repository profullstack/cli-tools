import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ImageRequest } from '../src/emoji.ts';
import { BRANDS } from '../src/icon-brands.ts';
import {
  CreditError, FA_BRAND_COLORS, STYLE_REFS, buildHq, drawHq, guardCredits, hqPromptFor, withHq, withStyle,
} from '../src/icon-hq.ts';
import { resolveStyle } from '../src/icon-styles.ts';
import { GENERIC } from '../src/icon-set.ts';
import type { Manifest } from '../src/icon.ts';

// A 1x1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function setup() {
  const out = await mkdtemp(join(tmpdir(), 'openicon-hq-'));
  const styleDir = await mkdtemp(join(tmpdir(), 'openemoji-'));
  for (const f of STYLE_REFS) await writeFile(join(styleDir, f), PNG);
  return { out, styleDir };
}

const base = (out: string, styleDir: string, caller: (r: ImageRequest) => Promise<{ png: Buffer; tokens: number }>) => ({
  out, styleDir, caller, concurrency: 2, quality: 'low', force: false, log: () => {},
  render: () => PNG, sleep: async () => {},
});

describe('hq prompt', () => {
  it('keeps the line glyph, borrows the emoji look, and says what the icon is', () => {
    const mail = GENERIC.find((i) => i.key === 'mail')!;
    const prompt = hqPromptFor(mail);
    expect(prompt).toContain('keep its exact silhouette');
    expect(prompt).toContain('"mail"');
    expect(prompt).toContain('Colour: sky blue');
    expect(prompt).toContain('never resemble a logo');
  });
});

describe('hq colour', () => {
  it('meaning overrides the category, and every category has a colour', async () => {
    const { hqColorFor, CATEGORY_COLORS } = await import('../src/icon-hq.ts');
    const by = (k: string) => GENERIC.find((i) => i.key === k)!;
    expect(hqColorFor(by('delete'))).toContain('coral red');
    expect(hqColorFor(by('add'))).toContain('green');
    expect(hqColorFor(by('copy'))).toBe(CATEGORY_COLORS.action);
    for (const i of GENERIC) expect(CATEGORY_COLORS[i.category], i.category).toBeTruthy();
  });
});

describe('drawHq', () => {
  it('sends the line glyph first, then the three style references', async () => {
    const { out, styleDir } = await setup();
    const seen: number[] = [];
    const report = await drawHq({
      ...base(out, styleDir, async (r) => { seen.push(r.references.length); return { png: PNG, tokens: 1 }; }),
      keys: ['mail', 'phone'],
    });
    expect(report.drawn.sort()).toEqual(['mail', 'phone']);
    expect(seen).toEqual([4, 4]);
    expect(existsSync(join(out, 'hq', 'master', 'mail.png'))).toBe(true);

    const again = await drawHq({ ...base(out, styleDir, async () => { throw new Error('should not be called'); }), keys: ['mail'] });
    expect(again.skipped).toEqual(['mail']);
    expect(again.calls).toBe(0);
  });

  it('stops at once when the account is out of credit, without retrying', async () => {
    const { out, styleDir } = await setup();
    let calls = 0;
    const caller = guardCredits(async () => {
      calls += 1;
      throw Object.assign(new Error('You have no credits remaining.'), { status: 429 });
    });
    const report = await drawHq({ ...base(out, styleDir, caller), keys: ['mail', 'phone', 'link', 'search'], concurrency: 1 });
    expect(report.stoppedForCredit).toContain('no credits');
    expect(calls).toBe(1);
    expect(report.drawn).toEqual([]);
  });

  it('backs off on 429 rate limits and carries on', async () => {
    const { out, styleDir } = await setup();
    let calls = 0;
    const report = await drawHq({
      ...base(out, styleDir, async () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error('Rate limit reached'), { status: 429 });
        return { png: PNG, tokens: 1 };
      }),
      keys: ['mail'],
    });
    expect(report.drawn).toEqual(['mail']);
    expect(report.calls).toBe(3);
  });

  it('refuses to draw a brand', async () => {
    const { out, styleDir } = await setup();
    await expect(drawHq({ ...base(out, styleDir, async () => ({ png: PNG, tokens: 1 })), keys: ['github'] })).rejects.toThrow(/not a drawn icon/);
  });

  it('guardCredits leaves other errors alone', async () => {
    const guarded = guardCredits(async () => { throw new Error('Rate limit reached'); });
    await expect(guarded({ model: 'm', prompt: 'p', quality: 'low', references: [] })).rejects.not.toBeInstanceOf(CreditError);
  });
});

describe('buildHq', () => {
  it('colours brands with the owner colour and records where it came from', async () => {
    const { out } = await setup();
    await mkdir(join(out, 'svg'), { recursive: true });
    await writeFile(join(out, 'svg', 'github.svg'), '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M0 0h24v24H0z"/></svg>');
    await writeFile(join(out, 'svg', 'slack.svg'), '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M0 0h24v24H0z"/></svg>');
    await mkdir(join(out, 'hq', 'master'), { recursive: true });
    await writeFile(join(out, 'hq', 'master', 'mail.png'), await sharpSquare());

    const entries = await buildHq({
      out, sizes: [16, 32], log: () => {}, render: () => PNG, simpleIconsHex: new Map([['github', '#181717']]),
    });
    expect(entries.get('github')).toMatchObject({ svg: 'hq/svg/github.svg', made_by: 'human', hex: '#181717', hex_source: 'simple-icons:github' });
    expect(entries.get('slack')).toMatchObject({ hex: FA_BRAND_COLORS.slack!.hex, made_by: 'human' });
    expect(await readFile(join(out, 'hq', 'svg', 'github.svg'), 'utf8')).toContain('fill="#181717"');
    expect(entries.get('mail')).toEqual({ png: 'hq/png/{size}/mail.png', webp: 'hq/webp/{size}/mail.webp', made_by: 'ai' });
    expect(existsSync(join(out, 'hq', 'png', '32', 'mail.png'))).toBe(true);
    expect(existsSync(join(out, 'hq', 'webp', '64', 'mail.webp'))).toBe(true);
  });

  it('every Font Awesome brand has a documented colour', () => {
    for (const b of BRANDS.filter((b) => b.source === 'font-awesome')) {
      expect(FA_BRAND_COLORS[b.key]?.hex, b.key).toMatch(/^#[0-9A-F]{6}$/);
      expect(FA_BRAND_COLORS[b.key]?.source, b.key).toMatch(/^https:\/\//);
    }
  });
});

describe('withHq', () => {
  it('adds the hq block per icon and the style list, leaving simple fields alone', () => {
    const manifest = {
      openicon: '0.1', sizes: [16], icons: [
        { key: 'mail', svg: 'svg/mail.svg', png: 'png/{size}/mail.png' },
        { key: 'phone', svg: 'svg/phone.svg', png: 'png/{size}/phone.png' },
      ],
    } as unknown as Manifest;
    const next = withHq(manifest, new Map([['mail', { png: 'hq/png/{size}/mail.png', webp: 'hq/webp/{size}/mail.webp', made_by: 'ai' as const }]]), [16]);
    expect(next.styles).toEqual(['simple', 'hq']);
    expect(next.hq).toMatchObject({ sizes: [16], webp_sizes: [64, 128], coverage: { total: 2, done: 1 } });
    expect(next.icons[0]).toMatchObject({ svg: 'svg/mail.svg', hq: { made_by: 'ai' } });
    expect(next.icons[1]!.hq).toBeUndefined();
  });
});

describe('styles', () => {
  it('agentic takes no emoji reference and names its own material', () => {
    const mail = GENERIC.find((i) => i.key === 'mail')!;
    const matte = resolveStyle('agentic');
    expect(matte.id).toBe('agentic-matte');
    expect(matte.emojiRefs).toEqual([]);
    const prompt = matte.promptFor(mail);
    expect(prompt).toContain('keep its exact silhouette');
    expect(prompt).toContain('FLAT tonal planes');
    expect(prompt).toContain('no specular highlight');
    expect(prompt).toContain('Accent colour: sky blue #1E88E5');
    // The gloss vocabulary belongs to the HQ style and must not leak in.
    expect(prompt).not.toContain('glossy 3D emoji');
    expect(resolveStyle('hq').promptFor(mail)).toContain('glossy 3D emoji');
  });

  it('each agentic style is drawn and derived under its own directory', async () => {
    const { out, styleDir } = await setup();
    const style = resolveStyle('agentic-emissive');
    await drawHq({ ...base(out, styleDir, async () => ({ png: PNG, tokens: 1 })), style, keys: ['mail'] });
    expect(existsSync(join(out, 'styles', 'agentic-emissive', 'master', 'mail.png'))).toBe(true);
    expect(existsSync(join(out, 'hq', 'master', 'mail.png'))).toBe(false);
  });

  it('an unreadable master is left out rather than derived into broken sizes', async () => {
    const { out } = await setup();
    const style = resolveStyle('agentic-matte');
    await mkdir(join(out, style.dir, 'master'), { recursive: true });
    await writeFile(join(out, style.dir, 'master', 'mail.png'), await sharpSquare());
    // What a run that filled the disk leaves behind: a plausible file that is not an image.
    await writeFile(join(out, style.dir, 'master', 'phone.png'), Buffer.alloc(512));

    const lines: string[] = [];
    const entries = await buildHq({
      out, sizes: [16], style, log: (l) => lines.push(l), render: () => PNG, simpleIconsHex: new Map(),
    });
    expect(entries.has('mail')).toBe(true);
    expect(entries.has('phone')).toBe(false);
    expect(lines.join('\n')).toContain('BROKEN master agentic-matte/phone');
  });
});

describe('withStyle', () => {
  it('keeps every style in one manifest, and hq keeps its old name too', () => {
    const manifest = {
      openicon: '0.1', sizes: [16], icons: [{ key: 'mail', svg: 'svg/mail.svg', png: 'png/{size}/mail.png' }],
    } as unknown as Manifest;
    const entry = (dir: string) => new Map([['mail', { png: `${dir}/png/{size}/mail.png`, webp: `${dir}/webp/{size}/mail.webp`, made_by: 'ai' as const }]]);

    const withBoth = withStyle(
      withHq(manifest, entry('hq'), [16]),
      resolveStyle('agentic-matte'),
      entry('styles/agentic-matte'),
      [16],
    );

    expect(withBoth.styles).toEqual(['simple', 'hq', 'agentic-matte']);
    expect(Object.keys(withBoth.style_info!)).toEqual(['hq', 'agentic-matte']);
    expect(withBoth.style_info!['agentic-matte']).toMatchObject({ dir: 'styles/agentic-matte', label: 'Agentic Matte' });
    // Both names, one object: a reader from the first HQ release still works.
    expect(withBoth.icons[0]!.hq).toEqual(withBoth.icons[0]!.styles!.hq);
    expect(withBoth.icons[0]!.styles!['agentic-matte']!.png).toBe('styles/agentic-matte/png/{size}/mail.png');
  });
});

async function sharpSquare(): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  return sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 200, g: 50, b: 50, alpha: 1 } } }).png().toBuffer();
}
