import { describe, expect, it } from 'vitest';
import { defaultOutput, humanBytes, humanDuration, pickImageEngine } from '../src/media.ts';

describe('defaultOutput', () => {
  it('swaps the extension', () => {
    expect(defaultOutput('logo.png', 'webp')).toBe('logo.webp');
    expect(defaultOutput('/a/b/logo.PNG', 'webp')).toBe('/a/b/logo.webp');
  });

  /*
   * The case that would destroy the input.
   *
   * Converting a png to png is a real thing to ask -- re-encoding at a different
   * quality -- and naively swapping the extension yields the path you started
   * with. A tool that eats its own input on a plausible command is not one to
   * keep, so it steps aside instead.
   */
  it('never returns the input path when the format already matches', () => {
    expect(defaultOutput('logo.png', 'png')).toBe('logo.converted.png');
    expect(defaultOutput('logo.PNG', 'png')).toBe('logo.converted.png');
  });

  it('copes with a file that has no extension', () => {
    expect(defaultOutput('logo', 'png')).toBe('logo.png');
  });
});

describe('humanBytes', () => {
  it('reads as a size rather than a digit count', () => {
    expect(humanBytes(0)).toBe('0B');
    expect(humanBytes(999)).toBe('999B');
    expect(humanBytes(1024)).toBe('1.0KB');
    expect(humanBytes(1_500_000)).toBe('1.4MB');
  });

  it('says so rather than guessing when the number is not one', () => {
    expect(humanBytes(Number.NaN)).toBe('?');
    expect(humanBytes(-1)).toBe('?');
  });
});

describe('humanDuration', () => {
  /* ffprobe reports 5025.4 and nobody reads that as an hour and twenty-four. */
  it('turns a float of seconds into a clock', () => {
    expect(humanDuration(5025.4)).toBe('1:23:45');
    expect(humanDuration(90)).toBe('1:30');
    expect(humanDuration(9)).toBe('0:09');
  });

  it('does not invent a duration it was not given', () => {
    expect(humanDuration(Number.NaN)).toBe('?');
  });
});

describe('picking an engine', () => {
  /*
   * An explicit choice is honoured or refused, never quietly downgraded.
   * Someone who asks for ImageMagick has usually asked for a reason -- a PDF, a
   * PSD, an animated GIF -- and silently handing them sharp produces a failure
   * that looks like a bad input file.
   */
  it('refuses an explicitly named engine that is absent, rather than substituting', async () => {
    // ImageMagick is not installed in this environment, which is what makes
    // this assertion meaningful rather than tautological.
    await expect(pickImageEngine('magick')).rejects.toThrow(/ImageMagick is not on PATH/);
  });

  it('names the fix in the error, not just the problem', async () => {
    await expect(pickImageEngine('magick')).rejects.toThrow(/apt install|brew install|--engine sharp/);
  });
});
