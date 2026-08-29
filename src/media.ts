/**
 * Picking an image or video engine, and admitting when there is not one.
 *
 * Three engines, none of which this repository can assume is present:
 *
 *   sharp        an npm package with a native binary. Fast, and the only one
 *                that arrives by installing this repo -- but an OPTIONAL
 *                dependency, because a prebuilt binary is not available for
 *                every platform and a tools package that cannot be installed at
 *                all is worse than one that cannot resize a PNG.
 *   ImageMagick  a system binary. Everywhere, slower, and handles the long tail
 *                sharp does not: PDF, PSD, complex composites, animated GIF.
 *   ffmpeg       a system binary, and the only one of the three that knows what
 *                a video is.
 *
 * So every entry point here answers "what have I got" before it answers the
 * question it was asked, and says which engine it used. A tool that silently
 * picks a different backend produces different output for the same command,
 * which is the kind of surprise that gets blamed on the file rather than the
 * tool.
 */

import { run } from './exec.ts';

export type ImageEngine = 'sharp' | 'magick';

export class MissingEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingEngineError';
  }
}

/** Cached, because a lookup per file in a loop is a process spawn per file. */
const probed = new Map<string, string | null>();

/**
 * Where a binary is, or null.
 *
 * `command -v` through a shell would be shorter and is exactly the thing
 * src/exec.ts exists to avoid; this runs the candidate with a harmless flag and
 * reads the exit code instead.
 *
 * The flag is a parameter because the harmless one is not the same everywhere.
 * ImageMagick and ffmpeg both answer `-version` with 0; yt-dlp's parser reads
 * that single dash as seven combined short options and exits non-zero, so
 * probing it the same way would report an installed binary missing.
 */
export async function findBinary(names: string[], flag = '-version'): Promise<string | null> {
  const key = `${flag} ${names.join(',')}`;
  if (probed.has(key)) return probed.get(key) ?? null;

  for (const name of names) {
    const res = await run(name, [flag], { timeoutMs: 5000 }).catch(() => null);
    // A missing binary rejects at spawn, which src/exec.ts reports as 127.
    if (res && res.code === 0) {
      probed.set(key, name);
      return name;
    }
  }
  probed.set(key, null);
  return null;
}

/**
 * The slice of sharp's surface this repository uses.
 *
 * Declared structurally rather than imported from sharp's own types, because
 * sharp is an OPTIONAL dependency: `tsc` has to pass on a checkout that has
 * never installed it, and importing a type from a package that is not there is
 * a hard error. The cost is that this drifts if sharp changes shape, which is
 * why it is deliberately tiny.
 */
export interface SharpInstance {
  resize(opts: Record<string, unknown>): SharpInstance;
  toFormat(format: string, opts?: Record<string, unknown>): SharpInstance;
  toFile(path: string): Promise<{ width: number; height: number; size: number }>;
  metadata(): Promise<{ width?: number; height?: number; format?: string; space?: string }>;
}
export type SharpFactory = (input: string) => SharpInstance;

/** sharp, if this install has it. Imported lazily so its absence is not fatal. */
export async function loadSharp(): Promise<SharpFactory | null> {
  try {
    // A variable specifier, so the type checker does not try to resolve a
    // package that is legitimately absent.
    const specifier = 'sharp';
    const mod = (await import(specifier)) as { default?: SharpFactory };
    return (mod.default ?? (mod as unknown as SharpFactory)) ?? null;
  } catch {
    return null;
  }
}

export const findMagick = () => findBinary(['magick', 'convert']);
export const findFfmpeg = () => findBinary(['ffmpeg']);
export const findFfprobe = () => findBinary(['ffprobe']);
/* youtube-dl is accepted as a fallback name, but only as one: it still exists on
 * plenty of boxes and still resolves a plain YouTube URL, and it is years
 * behind on everything else. Preferring yt-dlp keeps that from being silent. */
export const findYtDlp = () => findBinary(['yt-dlp', 'youtube-dl'], '--version');

/**
 * Which image engine to use.
 *
 * sharp first when nothing is specified: it needs no system install, it is
 * several times faster, and it is the one that came with this repository. An
 * explicit choice is honoured or refused outright -- never quietly downgraded,
 * because someone who asked for ImageMagick usually asked for a reason.
 */
export async function pickImageEngine(preferred?: string): Promise<{
  engine: ImageEngine;
  magickBin?: string;
}> {
  const sharp = await loadSharp();
  const magick = await findMagick();

  if (preferred === 'sharp') {
    if (!sharp) {
      throw new MissingEngineError(
        'sharp is not installed. It is an optional dependency: `pnpm add sharp` inside cli-tools, or use --engine magick.',
      );
    }
    return { engine: 'sharp' };
  }

  if (preferred === 'magick') {
    if (!magick) {
      throw new MissingEngineError(
        'ImageMagick is not on PATH. Install it (apt install imagemagick / brew install imagemagick), or use --engine sharp.',
      );
    }
    return { engine: 'magick', magickBin: magick };
  }

  if (sharp) return { engine: 'sharp' };
  if (magick) return { engine: 'magick', magickBin: magick };

  throw new MissingEngineError(
    'No image engine available. Either install sharp (`pnpm add sharp` inside cli-tools) or ImageMagick on PATH.',
  );
}

/**
 * ImageMagick 6 and 7 do not take the same argv.
 *
 * v7 is `magick in.png -resize 50% out.png`; v6 is `convert` with the same tail.
 * Building the argv here rather than at each call site keeps that difference in
 * one place, which is where it belongs -- the alternative is every command
 * growing its own version check.
 */
export function magickArgs(bin: string, args: string[]): string[] {
  return bin === 'magick' ? args : args;
}

/** Bytes, in a form a person reads without counting digits. */
export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)}${units[i]}`;
}

/**
 * A duration, as hh:mm:ss rather than a float of seconds.
 *
 * ffprobe reports 5025.4 and nobody reads that as an hour and twenty-four
 * minutes.
 */
export function humanDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '?';
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * The output path for a conversion, when none was given.
 *
 * Never overwrites the input: swapping the extension on a file whose target
 * format is the same one it already has would destroy the original, and a tool
 * that eats its input on a typo is not one to keep.
 */
export function defaultOutput(input: string, format: string): string {
  const dot = input.lastIndexOf('.');
  const stem = dot > 0 ? input.slice(0, dot) : input;
  const ext = dot > 0 ? input.slice(dot + 1).toLowerCase() : '';
  return ext === format.toLowerCase() ? `${stem}.converted.${format}` : `${stem}.${format}`;
}
