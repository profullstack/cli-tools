/**
 * OpenInstall: every repo carries an idempotent `bin/install.sh` that puts the
 * app into service on the box it runs on (systemd, nginx + TLS, postgres,
 * redis, health check). Spec: https://logicsrc.com/openinstall
 *
 * The script itself is not written here. `templates/openinstall/install.sh` is
 * a vendored copy of sh1pt's `packages/targets/deploy-ssh/bin/install.sh`,
 * which is what `sh1pt ship --target deploy-ssh` runs on the server. Change it
 * there first, then copy it here, so a repo set up by either tool gets the
 * same script.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { repoRoot } from './registry.ts';

export class OpenInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenInstallError';
  }
}

export function template(root: string = repoRoot()): string {
  return readFileSync(join(root, 'templates', 'openinstall', 'install.sh'), 'utf8');
}

/** The settings `init` can write into bin/install.conf. */
export interface ConfValues {
  app?: string | undefined;
  port?: string | undefined;
  start?: string | undefined;
  build?: string | undefined;
  runtime?: string | undefined;
  domains?: string | undefined;
  postgres?: boolean | undefined;
  redis?: boolean | undefined;
}

export function renderConf(v: ConfValues): string {
  const lines = [
    '# bin/install.conf: settings for bin/install.sh (OpenInstall). Committed, never secrets.',
    '# The environment overrides anything here. Every key is listed at the top of bin/install.sh.',
  ];
  const put = (key: string, value: string | undefined) => {
    if (value === undefined || value === '') return;
    if (/[\n\r]/.test(value)) throw new OpenInstallError(`${key} cannot contain a newline`);
    lines.push(`${key}=${value}`);
  };
  put('APP', v.app);
  put('RUNTIME', v.runtime);
  put('PORT', v.port);
  put('BUILD_CMD', v.build);
  put('START_CMD', v.start);
  put('DOMAINS', v.domains);
  if (v.postgres) put('POSTGRES', '1');
  if (v.redis) put('REDIS', '1');
  return `${lines.join('\n')}\n`;
}

export type FileState = 'created' | 'updated' | 'unchanged' | 'kept';

export interface InitResult {
  script: FileState;
  conf: FileState;
}

/**
 * Write bin/install.sh and bin/install.conf. Running it twice changes nothing.
 * A different install.sh is only replaced with `force`, because a repo may
 * have customised its copy; install.conf is never overwritten unless `force`.
 */
export function init(dir: string, values: ConfValues = {}, opts: { force?: boolean; root?: string } = {}): InitResult {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new OpenInstallError(`${dir} is not a directory`);
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const scriptPath = join(binDir, 'install.sh');
  const confPath = join(binDir, 'install.conf');
  const wanted = template(opts.root);

  let script: FileState;
  if (!existsSync(scriptPath)) {
    writeFileSync(scriptPath, wanted);
    script = 'created';
  } else if (readFileSync(scriptPath, 'utf8') === wanted) {
    script = 'unchanged';
  } else if (opts.force) {
    writeFileSync(scriptPath, wanted);
    script = 'updated';
  } else {
    script = 'kept';
  }
  if (script !== 'kept') chmodSync(scriptPath, 0o755);

  let conf: FileState;
  const confText = renderConf(values);
  if (!existsSync(confPath)) {
    writeFileSync(confPath, confText);
    conf = 'created';
  } else if (readFileSync(confPath, 'utf8') === confText) {
    conf = 'unchanged';
  } else if (opts.force) {
    writeFileSync(confPath, confText);
    conf = 'updated';
  } else {
    conf = 'kept';
  }
  return { script, conf };
}

export interface CheckResult {
  ok: boolean;
  problems: string[];
  notes: string[];
}

/** Is this repo's bin/install.sh present, runnable, valid bash, and current? */
export function check(dir: string, opts: { root?: string; bash?: string } = {}): CheckResult {
  const problems: string[] = [];
  const notes: string[] = [];
  const scriptPath = join(dir, 'bin', 'install.sh');
  if (!existsSync(scriptPath)) {
    problems.push('bin/install.sh is missing (run: openinstall init)');
    return { ok: false, problems, notes };
  }
  if ((statSync(scriptPath).mode & 0o111) === 0) problems.push('bin/install.sh is not executable (chmod +x bin/install.sh)');
  const syntax = spawnSync(opts.bash ?? 'bash', ['-n', scriptPath], { encoding: 'utf8' });
  if (syntax.error) notes.push(`could not run bash -n: ${syntax.error.message}`);
  else if (syntax.status !== 0) problems.push(`bin/install.sh has a bash syntax error: ${syntax.stderr.trim()}`);
  const text = readFileSync(scriptPath, 'utf8');
  for (const phase of ['setup', 'build', 'activate', 'status']) {
    if (!new RegExp(`^\\s*${phase}\\)`, 'm').test(text)) problems.push(`bin/install.sh has no "${phase}" phase`);
  }
  if (text === template(opts.root)) notes.push('bin/install.sh is the current generic copy');
  else notes.push('bin/install.sh differs from the generic copy (customised, or older: openinstall init --force replaces it)');
  if (!existsSync(join(dir, 'bin', 'install.conf'))) notes.push('no bin/install.conf: every setting is the default or comes from the environment');
  return { ok: problems.length === 0, problems, notes };
}
