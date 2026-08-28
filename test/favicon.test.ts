import { describe, expect, it } from 'vitest';

import { UsageError } from '../src/args.ts';
import {
  DEFAULT_COMPRESSION,
  DEFAULT_OUT,
  DEFAULT_QUALITY,
  type IconRequest,
  PACKAGE,
  assertSupportedInput,
  buildArgs,
  describeCommand,
  resolveSpec,
} from '../src/favicon.ts';

const request = (overrides: Partial<IconRequest> = {}): IconRequest => ({
  input: 'logo.svg',
  outDir: DEFAULT_OUT,
  quality: DEFAULT_QUALITY,
  compression: DEFAULT_COMPRESSION,
  favicons: true,
  quiet: false,
  ...overrides,
});

describe('resolveSpec', () => {
  it('runs the published generator by default', () => {
    expect(resolveSpec({})).toBe(PACKAGE);
  });

  it('takes a pinned version or a checkout from FAVICON_SPEC', () => {
    expect(resolveSpec({ FAVICON_SPEC: `${PACKAGE}@1.2.1` })).toBe(`${PACKAGE}@1.2.1`);
    expect(resolveSpec({ FAVICON_SPEC: '/home/me/src/favicon-generator' })).toBe(
      '/home/me/src/favicon-generator',
    );
  });

  // An exported-but-empty variable is the shape a shell leaves behind, and npx
  // would read it as "run the package named empty string".
  it('ignores an empty or whitespace value', () => {
    expect(resolveSpec({ FAVICON_SPEC: '   ' })).toBe(PACKAGE);
  });
});

describe('assertSupportedInput', () => {
  it('accepts an SVG or a PNG, whatever the case', () => {
    expect(() => assertSupportedInput('logo.svg')).not.toThrow();
    expect(() => assertSupportedInput('MARK.SVG')).not.toThrow();
    expect(() => assertSupportedInput('mark.PNG')).not.toThrow();
  });

  it('rejects anything else by name', () => {
    expect(() => assertSupportedInput('logo.jpg')).toThrow(UsageError);
    expect(() => assertSupportedInput('logo.jpg')).toThrow(/\.jpg/);
  });

  it('says something useful about a file with no extension at all', () => {
    expect(() => assertSupportedInput('logo')).toThrow(/not an SVG or a PNG/);
  });
});

describe('buildArgs', () => {
  // -i and -o are what keep interactive mode unreachable: the generator only
  // prompts when it has been told nothing, and a prompt in a script is a hang.
  it('always names the input and the output directory', () => {
    expect(buildArgs(request())).toEqual([
      '-i',
      'logo.svg',
      '-o',
      './icons',
      '-q',
      '95',
      '-c',
      '9',
    ]);
  });

  it('passes the numbers through in the generator’s own spelling', () => {
    expect(buildArgs(request({ quality: 90, compression: 6 }))).toContain('90');
    expect(buildArgs(request({ outDir: 'public/icons' }))).toContain('public/icons');
  });

  it('adds --no-favicon only when the pair was turned off', () => {
    expect(buildArgs(request())).not.toContain('--no-favicon');
    expect(buildArgs(request({ favicons: false }))).toContain('--no-favicon');
  });

  // Ours is --quiet, theirs is --silent; the translation is the point.
  it('sends --quiet on as --silent', () => {
    expect(buildArgs(request({ quiet: true }))).toContain('--silent');
    expect(buildArgs(request({ quiet: true }))).not.toContain('--quiet');
  });
});

describe('describeCommand', () => {
  it('is the line --dry-run prints, and it starts with npx --yes', () => {
    expect(describeCommand(request(), PACKAGE)).toBe(
      `npx --yes ${PACKAGE} -i logo.svg -o ./icons -q 95 -c 9`,
    );
  });
});
