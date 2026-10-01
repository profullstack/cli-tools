import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { check, init, renderConf, template } from '../src/openinstall.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'openinstall-'));
  dirs.push(d);
  return d;
}

describe('template', () => {
  it('is valid bash with every OpenInstall phase', () => {
    const t = template();
    expect(t.startsWith('#!/usr/bin/env bash')).toBe(true);
    for (const phase of ['setup)', 'build)', 'activate)', 'status)', 'all)']) expect(t).toContain(phase);
    expect(t).toContain('# managed by bin/install.sh');
    const d = repo();
    writeFileSync(join(d, 'x.sh'), t);
    expect(spawnSync('bash', ['-n', join(d, 'x.sh')]).status).toBe(0);
  });
});

describe('renderConf', () => {
  it('writes only what was given', () => {
    expect(renderConf({ port: '3100', start: 'bun run start', domains: 'a.com www.a.com', postgres: true }).split('\n').filter((l) => !l.startsWith('#') && l))
      .toEqual(['PORT=3100', 'START_CMD=bun run start', 'DOMAINS=a.com www.a.com', 'POSTGRES=1']);
    expect(() => renderConf({ start: 'a\nb' })).toThrow('newline');
  });
});

describe('init', () => {
  it('creates, then changes nothing on a second run', () => {
    const d = repo();
    expect(init(d, { port: '3100' })).toEqual({ script: 'created', conf: 'created' });
    expect(statSync(join(d, 'bin', 'install.sh')).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(d, 'bin', 'install.conf'), 'utf8')).toContain('PORT=3100');
    expect(init(d, { port: '3100' })).toEqual({ script: 'unchanged', conf: 'unchanged' });
  });

  it('keeps a customised script and conf unless forced', () => {
    const d = repo();
    init(d, { port: '3100' });
    writeFileSync(join(d, 'bin', 'install.sh'), '#!/usr/bin/env bash\necho custom\n');
    expect(init(d, { port: '4000' })).toEqual({ script: 'kept', conf: 'kept' });
    expect(readFileSync(join(d, 'bin', 'install.sh'), 'utf8')).toContain('custom');
    expect(init(d, { port: '4000' }, { force: true })).toEqual({ script: 'updated', conf: 'updated' });
    expect(readFileSync(join(d, 'bin', 'install.conf'), 'utf8')).toContain('PORT=4000');
  });
});

describe('check', () => {
  it('passes a fresh init and names what is wrong otherwise', () => {
    const d = repo();
    expect(check(d)).toMatchObject({ ok: false, problems: [expect.stringContaining('missing')] });
    init(d);
    expect(check(d)).toMatchObject({ ok: true, notes: [expect.stringContaining('current generic copy')] });

    chmodSync(join(d, 'bin', 'install.sh'), 0o644);
    expect(check(d).problems).toContain('bin/install.sh is not executable (chmod +x bin/install.sh)');

    writeFileSync(join(d, 'bin', 'install.sh'), '#!/usr/bin/env bash\ncase "$1" in setup) ;;\n');
    chmodSync(join(d, 'bin', 'install.sh'), 0o755);
    const r = check(d);
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/syntax error|no "build" phase/);
  });
});

describe('the generic script on its own', () => {
  it('reports status for a static site without root', () => {
    const d = repo();
    init(d, { runtime: 'static' });
    const r = spawnSync('bash', [join(d, 'bin', 'install.sh'), 'status'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: d },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('runtime=static');
    expect(r.stdout).toMatch(/^app=openinstall-/m);
  });
});
