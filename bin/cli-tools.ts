#!/usr/bin/env -S npx --yes tsx
/**
 * cli-tools — the front door to everything else in this repository.
 *
 * It exists so the whole set has one name. `moshcode install cli-tools` looks
 * for a binary called `cli-tools` to decide whether the tool is present, and
 * the pit passes `/cli-tools …` straight through to it, so a single command
 * covers install status, updates, and reaching any of the others.
 *
 *   cli-tools list                 what is installed, and what is on PATH
 *   cli-tools update               pull and relink
 *   cli-tools link [--force]       symlink the commands into ~/.local/bin
 *   cli-tools unlink               remove the ones we own
 *   cli-tools aliases [--install]  the moshcode pit aliases
 *   cli-tools <command> [args…]    run one of the commands directly
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { integer, parseArgs, UsageError } from '../src/args.ts';
import {
  SERVICE_NAME,
  TIMER_NAME,
  decide,
  formatInterval,
  isDue,
  parseStatus,
  renderService,
  renderTimer,
} from '../src/selfupdate.ts';
import {
  credentialsPath,
  keyStates,
  keyVariable,
  KNOWN_KEYS,
  loadStored,
  mask,
  saveStored,
} from '../src/credentials.ts';
import { pullVault, vaultTarget } from '../src/vault.ts';
import { isMain } from '../src/is-main.ts';
import {
  aliasesPath,
  commands,
  mergeAliases,
  PIT_ALIASES,
  repoRoot,
  resolveCommand,
  whichOnPath,
} from '../src/registry.ts';
import {
  COMPANIONS,
  ensure as ensureCompanions,
  installCommand,
  source as companionSource,
  statuses as companionStatuses,
} from '../src/companions.ts';

export const USAGE = `Usage:
  cli-tools list
  cli-tools update [--auto]
  cli-tools autoupdate [--install [--hours N] | --remove]
  cli-tools link [--force]
  cli-tools unlink
  cli-tools companions [--install [--force]]
  cli-tools aliases [--install]
  cli-tools config [pull | set <key> [value] | unset <key>]
  cli-tools <command> [args…]

Commands:
  list      Every command here, and whether it is on PATH
  update    git pull, reinstall dependencies, relink
            "--auto" is the unattended form: at most once a day, and only on a
            clean checkout of the default branch with nothing unpushed
  autoupdate  A systemd user timer that runs "update --auto" for you
  link      Symlink the commands into ~/.local/bin, and install the companions
  unlink    Remove the symlinks we own (companions are left installed)
  companions  The commands that come from npm rather than this checkout
            "--install" installs the missing ones, "--force" updates them all
  aliases   Print the moshcode pit aliases, or write them with --install
  config    API keys: what is set, where it came from, and how to change it
            "config pull" imports them from the logicsrc team vault
  where     Print the checkout this command is running from
  help      This usage

Keys (config set <key>):
  openai      OPENAI_API_KEY      generate-names
  anthropic   ANTHROPIC_API_KEY   generate-names
  perplexity  PERPLEXITY_API_KEY  ask-web
  elevenlabs  ELEVENLABS_API_KEY  tts

Options:
  --force   link: take over a symlink owned by another checkout
            update --auto: check now, ignoring the once-a-day stamp
  --install aliases: merge them into ~/.moshcode/aliases.json
            autoupdate: write and enable the systemd user timer
  --remove  autoupdate: disable it and delete the units
  --hours N autoupdate --install: how often to check (default: 24)
  --auto    update: the unattended form, safe to run from a timer
  --json    list/aliases/config: machine-readable (config never prints a key)
  -h, --help
`;

const SPEC = {
  boolean: ['--force', '--install', '--json', '--auto', '--remove', '-h', '--help'],
  string: ['--hours'],
} as const;

/**
 * The dispatcher's own verbs. Anything else is one of the commands.
 *
 * Exported so a test can hold it against USAGE. This list going stale is a real
 * failure mode with a quiet symptom: a verb documented in the usage text but
 * missing here falls through to the passthrough and answers "unknown command"
 * while the help says it exists. That is exactly what happened to `help`, and
 * then again to `companions`.
 */
export const KNOWN_VERBS = new Set([
  'help', 'list', 'update', 'autoupdate', 'link', 'unlink', 'companions', 'aliases', 'config',
  'where',
]);

function runLinks(root: string, args: readonly string[]): number {
  const script = join(root, 'scripts', 'install-links.mjs');
  return spawnSync(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit' }).status ?? 1;
}

/**
 * Install the npm-backed companions, and say what happened to each.
 *
 * Never fails the caller. `npm install -g` fails for ordinary reasons — no npm
 * on the box, a read-only prefix, no network — and none of them are a reason
 * for `cli-tools link` to report that the linking did not happen. The line is
 * printed to stderr so it stays out of anything reading stdout.
 */
function installCompanions({ latest = false, quiet = false } = {}): ReturnType<typeof ensureCompanions> {
  const results = ensureCompanions({
    onPath: (name) => whichOnPath(name),
    run: ({ command, args }) => {
      const out = spawnSync(command, args, { encoding: 'utf8' });
      if (out.error) return { status: 1, stderr: `${command} is not available: ${out.error.message}` };
      return { status: out.status, stderr: out.stderr };
    },
    latest,
  });

  if (quiet) return results;
  for (const entry of results) {
    if (entry.action === 'present') continue;
    const from = companionSource(entry);
    if (entry.action === 'installed') {
      process.stderr.write(`${entry.name}: ${entry.message ? `${from} ${entry.message}` : `installed ${from}`}\n`);
      continue;
    }
    process.stderr.write(
      `${entry.name}: could not install ${from} — ${entry.message}\n` +
        `         install it yourself with: ${installCommand(entry, { latest }).display}\n`,
    );
  }
  return results;
}

/** Pull and relink. Dependencies come first so a new one is present before use. */
function update(root: string): number {
  const git = spawnSync('git', ['pull', '--ff-only'], { cwd: root, stdio: 'inherit' });
  if (git.status !== 0) {
    process.stderr.write(
      'update: git pull failed. A dirty tree or a diverged branch stops this on purpose —\n' +
        `        nothing here discards your work. Sort it out in ${root} and retry.\n`,
    );
    return git.status ?? 1;
  }

  const pnpm = spawnSync('pnpm', ['install', '--silent'], { cwd: root, stdio: 'inherit' });
  if (pnpm.error) {
    const npm = spawnSync('npm', ['install', '--silent', '--no-audit', '--no-fund'], {
      cwd: root,
      stdio: 'inherit',
    });
    if (npm.status !== 0) return npm.status ?? 1;
  } else if (pnpm.status !== 0) {
    return pnpm.status ?? 1;
  }

  const linked = runLinks(root, []);
  // After the links, so a failed npm never hides a failed relink. `--latest`
  // here is what makes `update` mean update for the companions too: a bare
  // `npm install -g <pkg>` leaves an already-satisfied version in place.
  installCompanions({ latest: true });
  return linked;
}

/** Where the last automatic check is remembered. */
function stampPath(env: NodeJS.ProcessEnv = process.env): string {
  const state = env.XDG_STATE_HOME || join(env.HOME ?? homedir(), '.local', 'state');
  return join(state, 'cli-tools', 'update-stamp');
}

function readStamp(): number | null {
  try {
    return Number(readFileSync(stampPath(), 'utf8').trim());
  } catch {
    return null;
  }
}

function writeStamp(now: number): void {
  const path = stampPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${now}\n`);
}

/** `origin/HEAD` when the remote publishes it, else master. */
function defaultBranch(root: string): string {
  const result = spawnSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) return 'master';
  const name = (result.stdout ?? '').trim().split('/').pop();
  return name || 'master';
}

/**
 * The unattended path: check rarely, move only when it is unambiguously safe.
 *
 * Every refusal is printed rather than swallowed. This normally runs from a
 * timer, where stderr lands in the journal, and "why is my checkout not
 * updating" is otherwise unanswerable without reproducing the decision by hand.
 */
function autoUpdate(root: string, force: boolean): number {
  const now = Date.now();
  if (!force && !isDue(readStamp(), now)) return 0;

  // Stamped before the work, not after: a fetch that fails should not mean a
  // retry on every single invocation for as long as the network is down.
  writeStamp(now);

  const fetched = spawnSync('git', ['fetch', '--quiet'], { cwd: root, encoding: 'utf8' });
  if (fetched.status !== 0) {
    process.stderr.write(`update --auto: git fetch failed — ${(fetched.stderr ?? '').trim()}\n`);
    return 0;
  }

  const status = spawnSync('git', ['status', '--porcelain=v2', '--branch'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (status.status !== 0) {
    process.stderr.write('update --auto: could not read git status\n');
    return 0;
  }

  const decision = decide(parseStatus(status.stdout ?? ''), {
    defaultBranch: defaultBranch(root),
  });
  if (decision.action === 'skip') {
    process.stderr.write(`update --auto: skipped — ${decision.reason}\n`);
    return 0;
  }

  process.stderr.write(`update --auto: ${decision.reason}\n`);
  return update(root);
}

function unitDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(env.HOME ?? homedir(), '.config'), 'systemd', 'user');
}

function systemctl(args: readonly string[]): number {
  const result = spawnSync('systemctl', ['--user', ...args], { stdio: 'inherit' });
  if (result.error) {
    process.stderr.write('autoupdate: systemctl --user is not available on this machine.\n');
    return 1;
  }
  return result.status ?? 1;
}

/**
 * Install, remove or report the timer.
 *
 * systemd rather than cron because the units are declarative, `Persistent=true`
 * catches up a machine that was asleep, and the output of a failed run is in
 * the journal instead of an email nobody configured.
 */
function autoupdate(root: string, flags: Set<string>, hours: number): number {
  const dir = unitDir();
  const service = join(dir, SERVICE_NAME);
  const timer = join(dir, TIMER_NAME);

  if (flags.has('--remove')) {
    systemctl(['disable', '--now', TIMER_NAME]);
    for (const path of [service, timer]) {
      try {
        rmSync(path);
      } catch {
        // Already gone is the outcome we wanted.
      }
    }
    systemctl(['daemon-reload']);
    process.stdout.write('autoupdate: removed\n');
    return 0;
  }

  if (flags.has('--install')) {
    // The installed symlink is preferred over this checkout's path: it is the
    // name the operator actually uses, and it keeps working if the checkout
    // moves and is re-linked.
    const linked = join(process.env.HOME ?? homedir(), '.local', 'bin', 'cli-tools');
    const exec = existsSync(linked) ? linked : join(root, 'bin', 'cli-tools.ts');

    mkdirSync(dir, { recursive: true });
    writeFileSync(service, renderService(exec, process.env.PATH));
    writeFileSync(timer, renderTimer(hours * 3600));

    if (systemctl(['daemon-reload']) !== 0) return 1;
    if (systemctl(['enable', '--now', TIMER_NAME]) !== 0) return 1;

    process.stdout.write(`autoupdate: enabled, every ${formatInterval(hours * 3600)}\n${timer}\n`);
    process.stdout.write(
      'Note: user timers stop when you log out unless lingering is on\n' +
        '      (`loginctl enable-linger` — needs root).\n',
    );
    return 0;
  }

  if (!existsSync(timer)) {
    process.stdout.write('autoupdate: not installed — `cli-tools autoupdate --install`\n');
    return 0;
  }
  return systemctl(['list-timers', '--all', TIMER_NAME]);
}

function writeAliases(): number {
  const path = aliasesPath();
  let existing: Record<string, string> = {};

  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed as Record<string, string>;
    }
  } catch (error) {
    // A missing file is the first-run case. Anything else means the pit has a
    // file we would be overwriting blind, and its aliases are the operator's.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`aliases: ${path} exists but is not readable JSON — not touching it.\n`);
      return 1;
    }
  }

  const { merged, added, kept } = mergeAliases(existing);

  if (added.length === 0) {
    process.stdout.write(`aliases: nothing to add — ${path} is already up to date.\n`);
  } else {
    mkdirSync(dirname(path), { recursive: true });
    // 0600 to match how the pit writes it: an alias list is a working habit.
    writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`aliases: added ${added.join(', ')} to ${path}\n`);
  }

  for (const name of kept) {
    process.stdout.write(
      `aliases: kept your own "${name}" (${existing[name]}) — ours would have been "${PIT_ALIASES[name]}"\n`,
    );
  }

  process.stdout.write('\nThe pit re-reads the file on every lookup, so an open pit has them now.\n');
  return 0;
}

/**
 * Read one line without echoing it.
 *
 * A key typed at a visible prompt ends up in the scrollback of whatever
 * terminal, screen share or recording happens to be running, which is most of
 * the reason to have this command rather than telling people to edit the file.
 * Piped input is read as-is, so `… | cli-tools config set openai` works in a
 * script without a TTY.
 */
async function promptSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8').trim();
  }

  process.stderr.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise<string>((resolve) => {
    let value = '';
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        // Enter, or EOF/interrupt.
        if (byte === 0x0d || byte === 0x0a || byte === 0x04) {
          finish();
          return;
        }
        if (byte === 0x03) {
          process.stderr.write('\n');
          process.exit(130);
        }
        // Backspace / delete.
        if (byte === 0x7f || byte === 0x08) {
          value = value.slice(0, -1);
          continue;
        }
        value += String.fromCharCode(byte);
      }
    };
    const finish = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write('\n');
      resolve(value.trim());
    };
    process.stdin.on('data', onData);
  });
}

async function configCommand(rest: readonly string[], json: boolean): Promise<number> {
  const [verb, name, ...more] = rest;

  if (!verb) {
    const states = keyStates();
    if (json) {
      process.stdout.write(`${JSON.stringify({ path: credentialsPath(), keys: states }, null, 2)}\n`);
      return 0;
    }

    process.stdout.write(`${credentialsPath()}\n\n`);
    for (const state of states) {
      const where =
        state.source === 'env'
          ? 'environment (overrides the file)'
          : state.source === 'file'
            ? 'stored'
            : 'not set';
      process.stdout.write(
        `  ${state.name.padEnd(10)} ${state.variable.padEnd(18)} ${where}\n` +
          (state.preview ? `${' '.repeat(13)}${state.preview}\n` : ''),
      );
    }

    const shadowed = states.filter((state) => state.source === 'env');
    if (shadowed.length > 0) {
      // The failure this heads off: storing a key, still getting the old one,
      // and having nothing on screen explain why.
      process.stdout.write(
        `\nNote: ${shadowed.map((s) => s.variable).join(', ')} ${shadowed.length === 1 ? 'is' : 'are'} set in your environment,\n` +
          'so a stored value would be ignored. Unset the variable to use the stored one.\n',
      );
    }
    if (states.every((state) => state.source === 'unset')) {
      process.stdout.write('\nNothing set. Add one with:\n  cli-tools config set openai\n');
    }
    return 0;
  }

  if (verb === 'pull') {
    const target = vaultTarget();
    const label = `${target.team}/${target.project}--${target.env}`;
    process.stderr.write(`config: pulling ${label}…\n`);

    let vault: Record<string, string>;
    try {
      vault = pullVault(target);
    } catch (error) {
      process.stderr.write(`config: ${(error as Error).message}\n`);
      return 1;
    }

    // Only the keys these commands use. Copying the whole vault down would make
    // this file a second, drifting copy of every team secret — which is the
    // thing the vault exists to avoid.
    const stored = loadStored();
    const imported: string[] = [];
    const unchanged: string[] = [];
    for (const variable of Object.values(KNOWN_KEYS)) {
      const value = vault[variable];
      if (!value) continue;
      if (stored[variable] === value) {
        unchanged.push(variable);
        continue;
      }
      stored[variable] = value;
      imported.push(variable);
    }

    if (imported.length === 0 && unchanged.length === 0) {
      process.stderr.write(
        `config: ${label} has ${Object.keys(vault).length} keys, none of them ones these ` +
          `commands use (${Object.values(KNOWN_KEYS).join(', ')}).\n`,
      );
      return 1;
    }

    if (imported.length > 0) {
      const path = saveStored(stored);
      for (const variable of imported) {
        process.stdout.write(`config: imported ${variable} (${mask(stored[variable]!)})\n`);
      }
      process.stdout.write(`config: written to ${path}\n`);
    }
    for (const variable of unchanged) {
      process.stdout.write(`config: ${variable} already matches the vault\n`);
    }

    const ignored = Object.keys(vault).filter(
      (key) => !Object.values(KNOWN_KEYS).includes(key),
    ).length;
    if (ignored > 0) {
      process.stdout.write(
        `\n${ignored} other key(s) in the vault were left there — this stores only what\n` +
          'these commands read. The vault stays the authority.\n',
      );
    }

    const shadowed = imported.filter((variable) => process.env[variable]);
    if (shadowed.length > 0) {
      process.stdout.write(
        `\nNote: ${shadowed.join(', ')} ${shadowed.length === 1 ? 'is' : 'are'} also set in your\n` +
          'environment, which wins over what was just stored.\n',
      );
    }
    return 0;
  }

  if (verb !== 'set' && verb !== 'unset') {
    process.stderr.write(`config: unknown verb "${verb}" (expected set, unset or pull)\n`);
    return 1;
  }

  if (!name) {
    process.stderr.write(`config ${verb}: name a key — ${Object.keys(KNOWN_KEYS).join(', ')}\n`);
    return 1;
  }

  const variable = keyVariable(name);
  if (!variable) {
    process.stderr.write(
      `config: unknown key "${name}". Known keys: ${Object.keys(KNOWN_KEYS).join(', ')}\n`,
    );
    return 1;
  }

  const stored = loadStored();

  if (verb === 'unset') {
    if (!Object.hasOwn(stored, variable)) {
      process.stdout.write(`config: ${variable} was not stored — nothing to remove.\n`);
      return 0;
    }
    delete stored[variable];
    process.stdout.write(`config: removed ${variable} from ${saveStored(stored)}\n`);
    return 0;
  }

  // An inline value is accepted because scripts need it, but it lands in shell
  // history and the process list, so the prompt is the default and this says so.
  let value = more.length > 0 ? more.join(' ').trim() : '';
  if (!value) {
    value = await promptSecret(`${variable}: `);
  } else if (process.stdin.isTTY) {
    process.stderr.write(
      'config: a value on the command line is visible in shell history and `ps`.\n' +
        `        Prefer \`cli-tools config set ${name}\` and type it at the prompt.\n`,
    );
  }

  if (!value) {
    process.stderr.write('config: no value given — nothing stored.\n');
    return 1;
  }

  stored[variable] = value;
  const path = saveStored(stored);
  process.stdout.write(`config: stored ${variable} (${mask(value)}) in ${path}\n`);

  if (process.env[variable]) {
    process.stdout.write(
      `\nNote: ${variable} is also set in your environment, which wins.\n` +
        `      Unset it for the stored value to take effect.\n`,
    );
  }
  return 0;
}

export async function run(argv: readonly string[]): Promise<number> {
  // The first word is the command, and everything after it belongs to that
  // command — parsed here only for our own verbs, and passed through untouched
  // for the others. Parsing the whole line up front would mean this dispatcher
  // had to know every flag every tool accepts, and would reject the ones it
  // did not.
  const command = argv[0];
  const rest = argv.slice(1);
  const root = repoRoot();

  if (!command || command === '-h' || command === '--help') {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }

  // Anything that is not one of ours is one of the commands: pass it straight
  // through, arguments and streams untouched, so `cli-tools gh-prs --orgs x`
  // behaves exactly as `gh-prs --orgs x` does.
  // `help` is here because it is what people type. Without it the word fell
  // through to the passthrough below, which reported "unknown command: help"
  // and exited 1 — before printing the usage that answers the question.
  const known = KNOWN_VERBS;
  if (!known.has(command)) {
    const match = commands(root).find((entry) => entry.name === command);
    if (!match) {
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 1;
    }
    const script = join(root, 'bin', `${match.name}.ts`);
    return spawnSync(script, rest, { stdio: 'inherit' }).status ?? 1;
  }

  let options;
  try {
    options = parseArgs(rest, SPEC);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }

  switch (command) {
    case 'where':
      process.stdout.write(`${root}\n`);
      return 0;

    // positional, so `--json` is a flag here rather than part of a key's value.
    // A value that begins with a dash cannot be passed inline for the same
    // reason; type it at the prompt, which is the better habit anyway.
    case 'config':
      return configCommand(options.positional, options.flags.has('--json'));

    case 'list': {
      const binDir = join(root, 'bin');
      const all = commands(root).map((entry) => ({
        ...entry,
        ...resolveCommand(entry.name, binDir),
      }));

      const companions = companionStatuses((name) => whichOnPath(name));

      if (options.flags.has('--json')) {
        process.stdout.write(`${JSON.stringify({ root, commands: all, companions }, null, 2)}\n`);
        return 0;
      }

      process.stdout.write(`${root}\n\n`);
      for (const entry of all) {
        const mark = entry.status === 'ours' ? '*' : entry.status === 'other' ? '!' : ' ';
        process.stdout.write(`${mark} ${entry.name.padEnd(16)} ${entry.summary}\n`);
        // Naming the file is the whole point of the ! row: without it you know
        // something else answers to the name but not what, and the next step is
        // a `readlink` you should not have had to think of.
        if (entry.status === 'other') {
          process.stdout.write(`${' '.repeat(19)}↳ on PATH: ${entry.target}\n`);
        }
      }

      // A separate block, because they are a different kind of thing: these
      // come from npm and run with no checkout, so the *-ours / !-shadowed
      // marks above would be answering a question that does not apply.
      process.stdout.write('\nFrom npm:\n');
      for (const entry of companions) {
        const mark = entry.state === 'installed' ? '*' : ' ';
        process.stdout.write(`${mark} ${entry.name.padEnd(16)} ${entry.summary}\n`);
      }

      const other = all.filter((entry) => entry.status === 'other');
      const missing = all.filter((entry) => entry.status === 'missing');
      const absent = companions.filter((entry) => entry.state === 'missing');

      process.stdout.write('\n');
      if (absent.length > 0) {
        process.stdout.write(
          `${absent.length} companion${absent.length === 1 ? '' : 's'} not installed — run \`cli-tools companions --install\`.\n`,
        );
      }
      if (other.length === 0 && missing.length === 0) {
        process.stdout.write('All running from this checkout.\n');
        return 0;
      }

      process.stdout.write(
        `${all.length - other.length - missing.length} of ${all.length} running from this checkout.\n`,
      );
      if (missing.length > 0) {
        process.stdout.write(`${missing.length} not on PATH — run \`cli-tools link\`.\n`);
      }
      if (other.length > 0) {
        process.stdout.write(
          `${other.length} shadowed by another implementation (!). \`cli-tools link --force\`\n` +
            'takes over a symlink; a real file of that name is refused either way.\n' +
            'Check the flags first — a port does not always keep the original defaults.\n',
        );
      }
      return 0;
    }

    case 'help':
      process.stdout.write(USAGE);
      return 0;

    case 'update':
      return options.flags.has('--auto')
        ? autoUpdate(root, options.flags.has('--force'))
        : update(root);

    case 'autoupdate':
      return autoupdate(
        root,
        options.flags,
        integer(options.values, '--hours', 24, { min: 1, max: 24 * 30 }),
      );

    case 'link': {
      const linked = runLinks(root, options.flags.has('--force') ? ['--force'] : []);
      installCompanions();
      return linked;
    }

    case 'unlink':
      // Deliberately not uninstalling the companions. They are ordinary global
      // npm packages that work with no checkout at all, so unlinking this
      // repository is no reason to take them off the machine — and `npm rm -g`
      // is not a decision to make on somebody's behalf.
      return runLinks(root, ['--remove']);

    case 'companions': {
      if (options.flags.has('--json')) {
        const rows = options.flags.has('--install')
          ? installCompanions({ latest: options.flags.has('--force'), quiet: true })
          : companionStatuses((name) => whichOnPath(name));
        process.stdout.write(`${JSON.stringify({ companions: rows }, null, 2)}\n`);
        return 0;
      }
      if (options.flags.has('--install')) {
        installCompanions({ latest: options.flags.has('--force') });
        return 0;
      }
      process.stdout.write('Published separately, installed from npm:\n\n');
      for (const entry of companionStatuses((name) => whichOnPath(name))) {
        const mark = entry.state === 'installed' ? '*' : ' ';
        process.stdout.write(`${mark} ${entry.name.padEnd(16)} ${entry.summary}\n`);
        process.stdout.write(`${' '.repeat(19)}${companionSource(entry)}\n`);
      }
      process.stdout.write('\nInstall or update them with `cli-tools companions --install`.\n');
      return 0;
    }

    case 'aliases': {
      if (options.flags.has('--install')) return writeAliases();
      if (options.flags.has('--json')) {
        process.stdout.write(`${JSON.stringify(PIT_ALIASES, null, 2)}\n`);
        return 0;
      }
      process.stdout.write(`Suggested moshcode pit aliases (${aliasesPath()}):\n\n`);
      for (const [name, value] of Object.entries(PIT_ALIASES)) {
        process.stdout.write(`  /${name.padEnd(8)} ${value}\n`);
      }
      process.stdout.write('\nWrite them with `cli-tools aliases --install`.\n');
      return 0;
    }

    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
