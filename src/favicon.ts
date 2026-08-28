/**
 * The icon set a site actually links, generated from one file.
 *
 * The generation is `@profullstack/favicon-generator`, which is published and
 * maintained in its own repository. What lives here is the part that has to be
 * on PATH, plus argument handling, and that second half is not decoration —
 * its CLI has three edges that make it awkward to call from anything but a
 * prompt:
 *
 *   - It ignores what it does not recognise. `fav logo.svg --out icons` drops
 *     both the file and the directory on the floor, because the file is a
 *     positional and the flag is spelled `-o/--output`; with nothing left to
 *     go on it falls through to interactive mode, which in a script or a CI
 *     step with no TTY dies with "User force closed the prompt". Here the file
 *     is a positional, `--out` is a name for the directory, and an unknown
 *     flag is a usage error.
 *   - Interactive mode is unreachable through this command, because `-i` and
 *     `-o` are always passed. A tool that blocks on a prompt is a tool that
 *     cannot be put in a Makefile.
 *   - `fav --version` prints nothing at all: it starts an async read of its
 *     own package.json and then exits before that resolves. Not wrapped, and
 *     not offered — `--spec` says what would run instead.
 *
 * It is deliberately NOT a dependency of this repository. It brings its own
 * sharp (0.33, where the optional one here is 0.35) and carries a postinstall
 * that shells out to `pnpm dlx`, so under the pnpm 11 policy in .npmrc adding
 * it would leave every `pnpm install` in this repo either failing on an
 * unapproved build script or running somebody else's install-time shell — for
 * one command out of sixteen.
 *
 * And npx rather than the private prefix `codeburn` installs into, which is
 * the other way this repo runs somebody else's CLI. That machinery earns its
 * keep there for two reasons neither of which holds here: codeburn is a
 * dashboard opened many times a day, where dlx's per-run registry round trip is
 * the whole latency, and its executable is called `codeburn` — the same name as
 * our wrapper — so an install on PATH would have the wrapper exec itself.
 * Generating an icon set happens about once per project, upstream's executable
 * is called `fav` and ours is not, and a run costs about seven seconds the
 * first time on a box and under two warm. Nothing to install, nothing to
 * refresh, nothing to collide with.
 *
 *   FAVICON_SPEC   what npx runs, when you want a pinned version or a checkout
 */

import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { extname } from 'node:path';

import { UsageError } from './args.ts';

export const PACKAGE = '@profullstack/favicon-generator';

/**
 * What the generator can read.
 *
 * SVG is the input worth having — every size is then a clean render rather
 * than a resample — but it takes a PNG too, and refusing one here would be
 * this wrapper inventing a restriction the tool underneath does not have.
 */
export const INPUT_EXTENSIONS = ['.svg', '.png'] as const;

export const DEFAULT_OUT = './icons';
export const DEFAULT_QUALITY = 95;
export const DEFAULT_COMPRESSION = 9;

export interface IconRequest {
  input: string;
  outDir: string;
  quality: number;
  compression: number;
  /** The extra favicon-16.png / favicon-32.png pair, on by default. */
  favicons: boolean;
  quiet: boolean;
}

/**
 * Which build of the generator to run.
 *
 * Unpinned by default, which is the same bet every tool here already makes in
 * its `npx --yes tsx` shebang: this is a toolbelt on somebody's box, so the
 * newest published generator is the one they want, and a version frozen into
 * this file would quietly outlive its own fixes. `FAVICON_SPEC` is the way out
 * in both directions — pin it (`@profullstack/favicon-generator@1.2.1`) when a
 * release breaks you, or point it at a checkout while you work on the
 * generator itself.
 */
export function resolveSpec(env: NodeJS.ProcessEnv = process.env): string {
  const spec = env.FAVICON_SPEC?.trim();
  return spec ? spec : PACKAGE;
}

/** Reject a file the generator would only reject later, and less clearly. */
export function assertSupportedInput(input: string): void {
  const extension = extname(input).toLowerCase();
  if (!(INPUT_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new UsageError(
      `${input} is not an SVG or a PNG${extension ? ` (got ${extension})` : ''}`,
    );
  }
}

/**
 * A missing file, said before a package download rather than after it.
 *
 * The generator reports this perfectly well itself; the point of checking
 * first is that a typo should not cost the npx install on a cold box.
 */
export async function assertReadable(input: string): Promise<void> {
  try {
    await access(input, constants.R_OK);
  } catch {
    throw new UsageError(`no such file: ${input}`);
  }
}

/**
 * Our options in the generator's own spelling.
 *
 * `-i` and `-o` are always present: they are what keeps interactive mode out
 * of reach. The two numbers are always passed too, so that what runs is the
 * documented default of this command rather than whatever the generator's
 * default happens to be in the version npx resolved.
 */
export function buildArgs(request: IconRequest): string[] {
  const args = [
    '-i',
    request.input,
    '-o',
    request.outDir,
    '-q',
    String(request.quality),
    '-c',
    String(request.compression),
  ];
  if (!request.favicons) args.push('--no-favicon');
  if (request.quiet) args.push('--silent');
  return args;
}

/** The command line, for `--dry-run` and for the error when npx is missing. */
export function describeCommand(request: IconRequest, spec: string = resolveSpec()): string {
  return ['npx', '--yes', spec, ...buildArgs(request)].join(' ');
}

/**
 * Run the generator, with its output as our output.
 *
 * stdio is inherited rather than captured because the generator prints a file
 * per icon as it writes it, and a wrapper that swallowed that to reprint a
 * summary would be slower and say less.
 */
export function launch(
  name: string,
  request: IconRequest,
  spec: string = resolveSpec(),
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['--yes', spec, ...buildArgs(request)], { stdio: 'inherit' });
    child.on('error', (error) => {
      process.stderr.write(`${name}: could not start npx — ${error.message}\n`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}
