import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ANCHORS,
  type ImageRequest,
  RefusedError,
  STYLE,
  baseKeyOf,
  cssFor,
  generate,
  manifestFor,
  parseEmojiTest,
  promptFor,
  select,
  tonePromptFor,
  toKey,
  unicodeVersionOf,
  withRetry,
} from '../src/emoji.ts';

const SAMPLE = `# emoji-test.txt
# Version: 18.0

# group: Smileys & Emotion
# subgroup: face-smiling
1F600                                                  ; fully-qualified     # 😀 E1.0 grinning face
# subgroup: heart
2764 FE0F                                              ; fully-qualified     # ❤️ E0.6 red heart
2764                                                   ; unqualified         # ❤ E0.6 red heart

# group: People & Body
# subgroup: hand-fingers-closed
1F44D                                                  ; fully-qualified     # 👍 E0.6 thumbs up
1F44D 1F3FD                                            ; fully-qualified     # 👍🏽 E1.0 thumbs up: medium skin tone
# subgroup: hand-single-finger
261D FE0F                                              ; fully-qualified     # ☝️ E0.6 index pointing up
261D 1F3FD                                             ; fully-qualified     # ☝🏽 E1.0 index pointing up: medium skin tone
# subgroup: person-role
1F469 200D 1F4BB                                       ; fully-qualified     # 👩‍💻 E4.0 woman technologist
1F469 1F3FE 200D 1F4BB                                 ; fully-qualified     # 👩🏾‍💻 E4.0 woman technologist: medium-dark skin tone

# group: Component
1F3FB                                                  ; component           # 🏻 E1.0 light skin tone

# group: Flags
# subgroup: country-flag
1F1EF 1F1F5                                            ; fully-qualified     # 🇯🇵 E0.6 flag: Japan
`;

const all = parseEmojiTest(SAMPLE);
const known = new Set(all.map((e) => e.key));
const byKey = (key: string) => all.find((e) => e.key === key)!;

describe('parseEmojiTest', () => {
  it('keeps only fully-qualified sequences, with group and version', () => {
    expect(all.map((e) => e.key)).toEqual([
      '1f600',
      '2764-fe0f',
      '1f44d',
      '1f44d-1f3fd',
      '261d-fe0f',
      '261d-1f3fd',
      '1f469-200d-1f4bb',
      '1f469-1f3fe-200d-1f4bb',
      '1f1ef-1f1f5',
    ]);
    expect(byKey('2764-fe0f')).toMatchObject({
      char: '❤️',
      name: 'red heart',
      group: 'Smileys & Emotion',
      subgroup: 'heart',
      version: '0.6',
    });
  });

  it('reads the Unicode version from the header', () => {
    expect(unicodeVersionOf(SAMPLE)).toBe('18.0');
    expect(unicodeVersionOf('nothing')).toBe('unknown');
  });

  it('keys are lowercase and hyphen-joined', () => {
    expect(toKey(['1F469', '200D', '1F4BB'])).toBe('1f469-200d-1f4bb');
  });
});

describe('baseKeyOf', () => {
  it('strips the tone to find the glyph to edit from', () => {
    expect(baseKeyOf(byKey('1f44d-1f3fd'), known)).toBe('1f44d');
    expect(baseKeyOf(byKey('1f469-1f3fe-200d-1f4bb'), known)).toBe('1f469-200d-1f4bb');
  });

  it('puts FE0F back when only the qualified base exists', () => {
    expect(baseKeyOf(byKey('261d-1f3fd'), known)).toBe('261d-fe0f');
  });

  it('is null for an untoned glyph', () => {
    expect(baseKeyOf(byKey('1f44d'), known)).toBeNull();
  });
});

describe('select', () => {
  it('matches whole graphemes, so a toned emoji does not pick its base', () => {
    expect(select(all, { only: ['👍🏽'] }).map((e) => e.key)).toEqual(['1f44d-1f3fd']);
  });

  it('ignores FE0F, which people leave out when they type', () => {
    expect(select(all, { only: ['❤'] }).map((e) => e.key)).toEqual(['2764-fe0f']);
  });

  it('takes keys, groups, subgroups and a limit', () => {
    expect(select(all, { only: ['1f600', '1F1EF-1F1F5'] })).toHaveLength(2);
    expect(select(all, { groups: ['flags'] }).map((e) => e.key)).toEqual(['1f1ef-1f1f5']);
    expect(select(all, { groups: ['heart'] }).map((e) => e.key)).toEqual(['2764-fe0f']);
    expect(select(all, { limit: 2 })).toHaveLength(2);
  });
});

describe('prompts', () => {
  it('carry the art direction, the group hint and the exact emoji', () => {
    const prompt = promptFor(byKey('1f1ef-1f1f5'), STYLE);
    expect(prompt).toContain(STYLE);
    expect(prompt).toContain('flag waving on a short gold pole');
    expect(prompt).toContain('"flag: Japan"');
    expect(prompt).toContain('1F1EF 1F1F5');
  });

  it('famous-design subjects carry their own brief', async () => {
    const { DESIGN_NOTES } = await import('../src/emoji.ts');
    const mermaid = { key: '1f9dc-200d-2640-fe0f', codepoints: ['1f9dc', '200d', '2640', 'fe0f'], char: '🧜‍♀️', name: 'mermaid', group: 'People & Body', subgroup: 'person-fantasy', version: '5.0' };
    expect(promptFor(mermaid, STYLE)).toContain(DESIGN_NOTES['1f9dc']);
    expect(promptFor(byKey('1f600'), STYLE)).not.toContain('Design brief');
  });

  it('a tone edit changes skin and nothing else', () => {
    const prompt = tonePromptFor(byKey('1f44d-1f3fd'));
    expect(prompt).toContain('medium skin tone (Fitzpatrick type 4)');
    expect(prompt).toContain('Change skin only');
  });
});

describe('withRetry', () => {
  const noSleep = { sleep: async () => {} };

  it('retries rate limits and server errors', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('slow down'), { status: 429 });
      return 'ok';
    }, noSleep);
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('does not retry a refusal or a bad request', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls += 1;
        throw new RefusedError('safety system');
      }, noSleep),
    ).rejects.toThrow('safety');
    await expect(
      withRetry(async () => {
        calls += 1;
        throw Object.assign(new Error('bad'), { status: 400 });
      }, noSleep),
    ).rejects.toThrow('bad');
    expect(calls).toBe(2);
  });
});

// A 1x1 transparent PNG, standing in for the model's output.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('generate', () => {
  it('draws anchors first, then plain glyphs against them, then tones from their base', async () => {
    const out = await mkdtemp(join(tmpdir(), 'emoji-'));
    const calls: Array<{ prompt: string; refs: number }> = [];
    const caller = async (request: ImageRequest) => {
      calls.push({ prompt: request.prompt, refs: request.references.length });
      return { png: PNG, tokens: 10 };
    };
    const report = await generate(all, select(all, { only: ['👩🏾‍💻', '🇯🇵'] }), {
      out,
      model: 'test',
      quality: 'low',
      style: STYLE,
      concurrency: 1,
      force: false,
      caller,
      log: () => {},
    });

    const anchorsInSample = ANCHORS.filter((k) => known.has(k));
    // Anchors (😀 ❤️ 👍 in this sample), then 🇯🇵 and the pulled-in 👩‍💻, then 👩🏾‍💻.
    expect(report.drawn.slice(0, anchorsInSample.length)).toEqual(anchorsInSample);
    expect(report.drawn).toContain('1f469-200d-1f4bb');
    expect(report.drawn.at(-1)).toBe('1f469-1f3fe-200d-1f4bb');
    expect(report.failed).toEqual([]);
    expect(report.tokens).toBe(10 * report.drawn.length);

    // The first anchor draws blind; everything after has references.
    expect(calls[0]!.refs).toBe(0);
    expect(calls.slice(1).every((c) => c.refs > 0)).toBe(true);
    // The tone edit sees exactly one image: its base.
    expect(calls.at(-1)).toMatchObject({ refs: 1 });
    expect(calls.at(-1)!.prompt).toContain('medium-dark skin tone');

    expect(existsSync(join(out, 'master', '1f1ef-1f1f5.png'))).toBe(true);
    expect(await readFile(join(out, 'style.txt'), 'utf8')).toContain('soft-volume 3D');

    // A second run pays for nothing.
    calls.length = 0;
    const again = await generate(all, select(all, { only: ['👩🏾‍💻', '🇯🇵'] }), {
      out, model: 'test', quality: 'low', style: STYLE, concurrency: 1, force: false, caller, log: () => {},
    });
    expect(calls).toHaveLength(0);
    expect(again.skipped).toHaveLength(2);
  });

  it('treats a zero-byte master as missing and redraws it', async () => {
    const out = await mkdtemp(join(tmpdir(), 'emoji-'));
    const { mkdir: mk, writeFile: wf } = await import('node:fs/promises');
    await mk(join(out, 'master'), { recursive: true });
    await wf(join(out, 'master', '1f1ef-1f1f5.png'), Buffer.alloc(0));
    let drew = 0;
    const caller = async () => {
      drew += 1;
      return { png: PNG, tokens: 1 };
    };
    const report = await generate(all, select(all, { only: ['1f1ef-1f1f5'] }), {
      out, model: 'test', quality: 'low', style: STYLE, concurrency: 1, force: false, caller, log: () => {},
    });
    expect(report.drawn).toContain('1f1ef-1f1f5');
    expect((await readFile(join(out, 'master', '1f1ef-1f1f5.png'))).length).toBeGreaterThan(0);
    expect(existsSync(join(out, 'master', '1f1ef-1f1f5.png.partial'))).toBe(false);
    expect(drew).toBeGreaterThan(0);
  });

  it('records a refusal and keeps going', async () => {
    const out = await mkdtemp(join(tmpdir(), 'emoji-'));
    const caller = async (request: ImageRequest) => {
      if (request.prompt.includes('Japan')) throw new RefusedError('rejected by the safety system');
      return { png: PNG, tokens: 1 };
    };
    const report = await generate(all, select(all, { groups: ['Flags', 'face-smiling'] }), {
      out, model: 'test', quality: 'low', style: STYLE, concurrency: 2, force: false, caller, log: () => {},
    });
    expect(report.failed.map((f) => f.key)).toEqual(['1f1ef-1f1f5']);
    const failures = JSON.parse(await readFile(join(out, 'failures.json'), 'utf8'));
    expect(failures[0]).toMatchObject({ key: '1f1ef-1f1f5', name: 'flag: Japan' });
  });
});

describe('manifest', () => {
  const manifest = manifestFor(all, ['1f600', '1f44d', '1f44d-1f3fd'], {
    sizes: [32, 128],
    webpSizes: [64],
    keywords: new Map([['❤', ['love', 'heart']]]),
    svg: true,
    fonts: [{ format: 'cbdt', path: 'font/OpenEmoji-CBDT.ttf' }],
    unicodeVersion: '18.0',
    model: 'gpt-image-2',
  });

  it('says what made it, and how much of Unicode it covers', () => {
    expect(manifest).toMatchObject({
      openemoji: '0.1',
      unicode: '18.0',
      made_by: 'ai',
      disclosure: 'ai-generated',
      ai_model: 'gpt-image-2',
      formats: ['png', 'webp', 'svg', 'cbdt'],
    });
    expect(manifest.coverage).toMatchObject({ total: all.length, drawn: 3 });
    expect(manifest.coverage.missing).toContain('1f1ef-1f1f5');
  });

  it('links a tone to its base and names every file', () => {
    expect(manifest.emoji.find((e) => e.key === '1f44d-1f3fd')).toMatchObject({
      base: '1f44d',
      svg: 'svg/1f44d-1f3fd.svg',
      png: 'png/{size}/1f44d-1f3fd.png',
    });
  });

  it('lists every emoji, and only drawn ones carry files', () => {
    expect(manifest.emoji).toHaveLength(all.length);
    const heart = manifest.emoji.find((e) => e.key === '2764-fe0f')!;
    expect(heart.png).toBeUndefined();
    expect(heart.svg).toBeUndefined();
    // CLDR spells it without FE0F; the lookup still finds it.
    expect(heart.keywords).toEqual(['love', 'heart']);
    expect(manifest.emoji.find((e) => e.key === '1f600')!.webp).toBe('webp/{size}/1f600.webp');
  });

  it('the stylesheet points at the fonts and falls back to the system set', () => {
    const css = cssFor(manifest);
    expect(css).toContain('url("font/OpenEmoji-CBDT.ttf")');
    expect(css).toContain('"Noto Color Emoji"');
  });
});

describe('platform exports', async () => {
  const { ESSENTIALS, PLATFORMS, fitName, packsFor, shortcodeOf, zipStore } = await import('../src/emoji-platforms.ts');

  it('shortcodes are oe_ plus the CLDR name, tones as t1-t5', () => {
    expect(shortcodeOf('face with tears of joy')).toBe('oe_face_with_tears_of_joy');
    expect(shortcodeOf('woman technologist: medium-dark skin tone')).toBe('oe_woman_technologist_t4');
    expect(shortcodeOf('kiss: woman, man, light skin tone, dark skin tone')).toBe('oe_kiss_woman_man_t1_t5');
    expect(shortcodeOf('flag: Côte d’Ivoire')).toBe('oe_flag_cote_d_ivoire');
    expect(shortcodeOf('keycap: #')).toBe('oe_keycap_hash');
  });

  it('long names are cut to the cap and stay unique', () => {
    const a = fitName('oe_couple_with_heart_woman_man_t1_t5', '1f469-1f3fb-200d-2764', 32);
    const b = fitName('oe_couple_with_heart_woman_man_t1_t4', '1f469-1f3fb-200d-2765', 32);
    expect(a.length).toBeLessThanOrEqual(32);
    expect(a).not.toBe(b);
    expect(fitName('oe_fire', '1f525', 32)).toBe('oe_fire');
  });

  const drawn = (keys: string[], group = 'Smileys & Emotion', subgroup = 'face-smiling') =>
    keys.map((key) => ({ key, char: '?', name: key, group, subgroup, unicode: '1.0', png: `png/{size}/${key}.png` }));

  it('packs respect the network cap, split per group', () => {
    const discord = PLATFORMS.find((p) => p.id === 'discord')!;
    const emoji = drawn(Array.from({ length: 120 }, (_, i) => `1f${(600 + i).toString(16)}`));
    const packs = packsFor(discord, emoji, 'all');
    expect(packs.map((p) => p.keys.length)).toEqual([50, 50, 20]);
    expect(packs[0]!.id).toBe('smileys-1');
  });

  it('stickers take the default tone only; essentials keep their order', () => {
    const signal = PLATFORMS.find((p) => p.id === 'signal')!;
    const emoji = [...drawn(['1f44d', '1f44d-1f3fd']), ...drawn([ESSENTIALS[1]!, ESSENTIALS[0]!])];
    expect(packsFor(signal, emoji, 'default-tone')[0]!.keys).toEqual(['1f44d', ESSENTIALS[1], ESSENTIALS[0]]);
    // 👍 is itself an essential; the pack follows ESSENTIALS order, not input order.
    expect(packsFor(signal, emoji, 'essentials')[0]!.keys).toEqual([ESSENTIALS[0], ESSENTIALS[1], '1f44d']);
  });

  it('flags for X are the flag subgroups', () => {
    const x = PLATFORMS.find((p) => p.id === 'x')!;
    const emoji = [...drawn(['1f1ef-1f1f5'], 'Flags', 'country-flag'), ...drawn(['1f600'])];
    expect(packsFor(x, emoji, 'flags')[0]!.keys).toEqual(['1f1ef-1f1f5']);
    expect(x.highlight?.subgroups).toContain('country-flag');
  });

  it('writes a zip that unzip can read', async () => {
    const { execFileSync } = await import('node:child_process');
    const dir = await mkdtemp(join(tmpdir(), 'zip-'));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'a.zip'), zipStore([{ name: 'oe_fire.png', data: PNG }, { name: 'emoji.txt', data: Buffer.from('ok\n') }]));
    const listing = execFileSync('unzip', ['-l', join(dir, 'a.zip')]).toString();
    expect(listing).toContain('oe_fire.png');
    expect(execFileSync('unzip', ['-p', join(dir, 'a.zip'), 'emoji.txt']).toString()).toBe('ok\n');
  });
});
