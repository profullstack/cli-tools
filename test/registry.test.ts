import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  aliasesPath,
  commands,
  mergeAliases,
  onPath,
  PIT_ALIASES,
  repoRoot,
  resolveCommand,
} from '../src/registry.ts';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'registry-'));
  dirs.push(dir);
  return dir;
}

describe('commands', () => {
  it('reads the real bin directory, so a new tool needs no edit here', () => {
    const names = commands().map((entry) => entry.name);
    expect(names).toContain('cli-tools');
    expect(names).toContain('blog-post');
    expect(names).toContain('gh-prs-merge');
  });

  it('gives every command a summary', () => {
    for (const entry of commands()) {
      expect(entry.summary, `${entry.name} has no summary`).not.toBe('');
    }
  });

  it('lists bin/*.ts sorted, without the extension', async () => {
    const root = await tmp();
    await mkdir(join(root, 'bin'));
    await writeFile(join(root, 'bin', 'zed.ts'), '');
    await writeFile(join(root, 'bin', 'alpha.ts'), '');
    await writeFile(join(root, 'bin', 'notes.md'), '');

    expect(commands(root).map((entry) => entry.name)).toEqual(['alpha', 'zed']);
  });
});

describe('repoRoot', () => {
  it('finds the checkout containing bin/ and package.json', () => {
    expect(commands(repoRoot()).length).toBeGreaterThan(0);
  });
});

describe('onPath', () => {
  it('finds an executable in a PATH directory', async () => {
    const dir = await tmp();
    const file = join(dir, 'somecmd');
    await writeFile(file, '#!/bin/sh\n');
    await chmod(file, 0o755);

    expect(onPath('somecmd', { PATH: dir } as NodeJS.ProcessEnv)).toBe(true);
    expect(onPath('othercmd', { PATH: dir } as NodeJS.ProcessEnv)).toBe(false);
  });

  // A file that is present but not executable is not a command, and reporting
  // it as installed would send someone hunting for the wrong problem.
  it('does not count a non-executable file', async () => {
    const dir = await tmp();
    const file = join(dir, 'inert');
    await writeFile(file, 'text');
    await chmod(file, 0o644);

    expect(onPath('inert', { PATH: dir } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('survives an empty or missing PATH', () => {
    expect(onPath('anything', {} as NodeJS.ProcessEnv)).toBe(false);
    expect(onPath('anything', { PATH: '' } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('resolveCommand', () => {
  /** A checkout with `bin/<name>.ts`, and a PATH dir linking to it. */
  async function layout(): Promise<{ binDir: string; pathDir: string; other: string }> {
    const root = await tmp();
    const binDir = join(root, 'bin');
    const pathDir = join(root, 'path');
    const other = join(root, 'elsewhere');
    await mkdir(binDir);
    await mkdir(pathDir);
    await mkdir(other);
    return { binDir, pathDir, other };
  }

  it('reports a link into our bin as ours', async () => {
    const { binDir, pathDir } = await layout();
    const source = join(binDir, 'thing.ts');
    await writeFile(source, '#!/bin/sh\n');
    await chmod(source, 0o755);
    await symlink(source, join(pathDir, 'thing'));

    const result = resolveCommand('thing', binDir, { PATH: pathDir } as NodeJS.ProcessEnv);
    expect(result.status).toBe('ours');
    expect(result.target).toBe(source);
  });

  // The bug this replaced: a bare presence check called every one of these
  // installed, while five were the older hand-written scripts they were ported
  // from — different implementations with different flag defaults.
  it('reports a different implementation of the same name as other, and names it', async () => {
    const { binDir, pathDir, other } = await layout();
    await writeFile(join(binDir, 'thing.ts'), '#!/bin/sh\n');
    const rival = join(other, 'thing');
    await writeFile(rival, '#!/bin/sh\n');
    await chmod(rival, 0o755);
    await symlink(rival, join(pathDir, 'thing'));

    const result = resolveCommand('thing', binDir, { PATH: pathDir } as NodeJS.ProcessEnv);
    expect(result.status).toBe('other');
    expect(result.target).toBe(rival);
  });

  it('reports a name that is nowhere on PATH as missing', async () => {
    const { binDir, pathDir } = await layout();
    const result = resolveCommand('absent', binDir, { PATH: pathDir } as NodeJS.ProcessEnv);
    expect(result).toEqual({ status: 'missing', target: null });
  });

  // Without the separator, a sibling directory whose name merely starts the
  // same way ("bin-old" beside "bin") would read as ours.
  it('does not mistake a sibling directory with a shared prefix for ours', async () => {
    const root = await tmp();
    const binDir = join(root, 'bin');
    const lookalike = join(root, 'bin-old');
    const pathDir = join(root, 'path');
    await mkdir(binDir);
    await mkdir(lookalike);
    await mkdir(pathDir);

    const rival = join(lookalike, 'thing');
    await writeFile(rival, '#!/bin/sh\n');
    await chmod(rival, 0o755);
    await symlink(rival, join(pathDir, 'thing'));

    expect(resolveCommand('thing', binDir, { PATH: pathDir } as NodeJS.ProcessEnv).status).toBe(
      'other',
    );
  });

  it('takes the first match on PATH, as the shell would', async () => {
    const { binDir, pathDir, other } = await layout();
    const source = join(binDir, 'thing.ts');
    await writeFile(source, '#!/bin/sh\n');
    await chmod(source, 0o755);
    await symlink(source, join(pathDir, 'thing'));

    const shadow = join(other, 'thing');
    await writeFile(shadow, '#!/bin/sh\n');
    await chmod(shadow, 0o755);

    // `other` first: it wins, exactly as PATH order dictates.
    expect(
      resolveCommand('thing', binDir, { PATH: `${other}:${pathDir}` } as NodeJS.ProcessEnv).status,
    ).toBe('other');
    expect(
      resolveCommand('thing', binDir, { PATH: `${pathDir}:${other}` } as NodeJS.ProcessEnv).status,
    ).toBe('ours');
  });

  it('still names a broken symlink rather than throwing', async () => {
    const { binDir, pathDir } = await layout();
    const dangling = join(binDir, 'gone.ts');
    await symlink(dangling, join(pathDir, 'gone'));

    // Nothing is executable, so it does not resolve — but it must not throw.
    expect(() =>
      resolveCommand('gone', binDir, { PATH: pathDir } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
});

describe('aliasesPath', () => {
  it('honours MOSHCODE_HOME', () => {
    expect(aliasesPath({ MOSHCODE_HOME: '/pit' } as NodeJS.ProcessEnv)).toBe('/pit/aliases.json');
  });

  it('falls back to ~/.moshcode', () => {
    expect(aliasesPath({} as NodeJS.ProcessEnv)).toMatch(/\.moshcode\/aliases\.json$/);
  });
});

describe('mergeAliases', () => {
  it('adds ours to an empty file', () => {
    const { merged, added, kept } = mergeAliases({});
    expect(merged).toEqual(PIT_ALIASES);
    expect(added).toEqual(Object.keys(PIT_ALIASES).sort());
    expect(kept).toEqual([]);
  });

  // The pit's alias file is the operator's. Repointing a word they bound
  // themselves is the kind of change nothing surfaces until the wrong command
  // runs, so an existing name always wins and the collision is reported.
  it('never overwrites an alias the operator already bound', () => {
    const existing = { merge: 'something-else --now', mine: 'my-tool' };
    const { merged, added, kept } = mergeAliases(existing);

    expect(merged.merge).toBe('something-else --now');
    expect(merged.mine).toBe('my-tool');
    expect(merged.prs).toBe('gh-prs');
    expect(added).not.toContain('merge');
    expect(kept).toEqual(['merge']);
  });

  it('is idempotent', () => {
    const once = mergeAliases({});
    const twice = mergeAliases(once.merged);

    expect(twice.merged).toEqual(once.merged);
    expect(twice.added).toEqual([]);
    expect(twice.kept).toEqual([]);
  });

  it('leaves unrelated aliases untouched', () => {
    const { merged } = mergeAliases({ tcfeed: 'tcfeed', 'gh-prs-all': 'gh-prs-all' });
    expect(merged.tcfeed).toBe('tcfeed');
    expect(merged['gh-prs-all']).toBe('gh-prs-all');
  });

  // gh-prs-merge already repairs by default under --apply, and baking --fix in
  // as well is what once made `/merge --fix` expand to `--apply --fix --fix`.
  it('keeps the merge alias thin', () => {
    expect(PIT_ALIASES.merge).toBe('gh-prs-merge --apply');
    expect(PIT_ALIASES.merge).not.toContain('--fix');
  });

  // A shell function beats PATH, so an alias named after the command it wraps
  // silently shadows the file and the two drift apart.
  it('never names an alias after a command', () => {
    const names = new Set(commands().map((entry) => entry.name));
    for (const alias of Object.keys(PIT_ALIASES)) {
      expect(names.has(alias), `alias "${alias}" shadows the command of that name`).toBe(false);
    }
  });

  // /ask and /say are the words you would reach for, and both already resolve
  // to something else on a normal box. A pit alias beats PATH, so binding them
  // would shadow those programs from inside the pit only — which is about the
  // most confusing failure available.
  it('avoids the names that would shadow something on PATH', () => {
    for (const taken of ['ask', 'say']) {
      expect(Object.keys(PIT_ALIASES)).not.toContain(taken);
    }
    expect(PIT_ALIASES.web).toBe('ask-web');
    expect(PIT_ALIASES.speak).toBe('tts');
    expect(PIT_ALIASES.aff).toBe('affiliate');
  });

  // Every alias has to start with a command that actually exists here, or it is
  // a `command not found` the moment somebody types it.
  it('expands to a command this repository installs', () => {
    const names = new Set(commands().map((entry) => entry.name));
    for (const [alias, value] of Object.entries(PIT_ALIASES)) {
      expect(names.has(value.split(' ')[0]!), `alias "${alias}" -> "${value}"`).toBe(true);
    }
  });
});
