#!/usr/bin/env node
/**
 * jobhunt — find jobs worth applying to, and apply to them through a browser.
 *
 * Not called `jobs`: that is a builtin in every POSIX shell, and a builtin
 * beats PATH, so `jobs discover` would answer "no such job" without ever
 * reaching this file. The moshcode plugin is still `jobs`, so the slash
 * commands read /jobs:discover, /jobs:apply and so on.
 *
 * The loop is discover → queue → apply. Discovery reads public ATS job-board
 * APIs, never a login; applying drives TronBrowser's `tron automate` and stops
 * for a human at anything it cannot answer honestly. Who is applying lives in
 * ~/.config/cli-tools/jobs.json as one or more profiles, never in this repo.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { UsageError, parseArgs } from '../src/args.ts';
import { isMain } from '../src/is-main.ts';
import {
  ANSWER_HELP,
  ANSWER_KEYS,
  FILTER_KEYS,
  JobsError,
  type JobsConfig,
  type Profile,
  type Settings,
  checkDocuments,
  emptyProfile,
  isProfileName,
  isRegex,
  loadJobsConfig,
  parseAssignment,
  resolveSettings,
  saveJobsConfig,
  setFilter,
  setProfileField,
  unsetFilter,
} from '../src/jobs-config.ts';
import { type Candidate, discover } from '../src/jobs-discover.ts';
import {
  type QueueItem,
  appliedSet,
  filterHistory,
  findQueued,
  formatHistory,
  jobKey,
  logHistory,
  parseSince,
  queueAdd,
  readApplied,
  readHistory,
  readJsonl,
  readQueue,
  readShortlist,
  recordApplied,
  resultsPath,
  shortlistPath,
  writeJsonAtomic,
  writeQueue,
} from '../src/jobs-state.ts';
import {
  type RunContext,
  createRun,
  formatRun,
  formatRunLine,
  latestRun,
  listRuns,
  loadRun,
  prepareResume,
  reconcile,
  runLogPath,
  runWorker,
  saveRun,
  stopRun,
} from '../src/jobs-run.ts';
import { makeApplyJob, mailAccountFor, preflight } from '../src/jobs-apply.ts';
import { loadConfig as loadMailConfig } from '../src/mail.ts';
import { confirm } from '../src/prompt.ts';

const USAGE = `Usage:
  jobhunt discover [--min-score N] [--limit N] [--json]   find postings, rank them, save the shortlist
  jobhunt shortlist [--json]                              the last discovery, numbered
  jobhunt queue                                           what the next run will apply to
  jobhunt queue add <index…> [--focus TEXT]               queue shortlist entries by number
  jobhunt queue focus <key> <text>                        set what {focus} says for one job
  jobhunt queue rm <key|index…>
  jobhunt queue clear
  jobhunt skip <index|key|url> --reason R                 never show or send this one again
  jobhunt apply [key] [--dry-run] [--no-mail] [--yes]     run the queue now, in the foreground
  jobhunt run start [key] [--dry-run] [--detach] [--no-mail]
  jobhunt run stop [id]                                   stop between jobs; a half-filled form is never sent
  jobhunt run resume [id] [--detach]                      continue a stopped or crashed run
  jobhunt run restart [id] [--detach]                     stop it if it is running, then resume
  jobhunt run list
  jobhunt run show [id] [--json]
  jobhunt status                                          applied, queued, and the latest run
  jobhunt history [--run ID] [--since 7d] [--type T,…] [--limit N] [--json]
  jobhunt config [--json]                                 the effective settings, and which file they came from
  jobhunt config set <key=value…>                         change the active profile's search filters
  jobhunt config unset <key…>                             put a filter back to its default
  jobhunt profile list
  jobhunt profile show [name]
  jobhunt profile add <name> [--from NAME] [key=value…]
  jobhunt profile set <name> <key=value…>
  jobhunt profile answer <name> <label-regex> <value> [--select]
  jobhunt profile use <name>                              make it the default
  jobhunt profile rm <name> --yes

Every command takes --profile NAME (default: \`profile use\`, $JOBS_PROFILE, or the only one).

Filters (\`config set\`; lists are comma-separated, key+=v and key-=v add and remove):
  source          Markdown list of companies, URL or file (default: awesome-ai-startups-hiring)
  workplace       remote, hybrid, onsite, any                    Ashby, Lever: structured; Workable:
                                                                  remote only; Greenhouse: location text
  countries       US, CA, GB … or EMEA, APAC, EUROPE, LATAM; any  Ashby, Lever, Workable: structured
                                                                  plus text; Greenhouse: location text
  title.include   regexes a title must match (substring)
  title.exclude   regexes that drop a title (whole word)
  pay.min         annual minimum in pay.currency (150k)           Ashby: compensation; Greenhouse:
  pay.currency    USD, EUR, GBP …                                 pay ranges or description; Lever:
  pay.require     true drops postings with no stated pay          salaryRange or description; Workable: none
  minScore, limit the shortlist floor and length (7, 40)
  exclude         flags that drop a posting: ONSITE, CLEARANCE, NON-JS, LOCATION-BOUND, pay:unknown
  boost.<tag>.terms / .weight / .in (any|title)   score terms; \`config\` lists the defaults

Profile keys (\`profile set\`):
  firstName lastName preferredName email phone linkedin github website location city
  resume cover why mailAccount answers.<key> filters.<key>
  why is a template: {company} and {focus} are filled per job.
  answers: ${ANSWER_KEYS.join(', ')}

Config lives in $JOBS_CONFIG or ~/.config/cli-tools/jobs.json (0600). State (applied.jsonl,
history.jsonl, runs/, profiles/<name>/) in $JOBS_STATE, the file's "state", or
~/.local/share/cli-tools/jobs. Browser: TRON_AUTOMATE_BIN / TRON_CHROMIUM_BIN or "tron" in the file.
`;

const SPEC = {
  boolean: ['--dry-run', '--json', '--detach', '--no-mail', '--yes', '--select', '-h', '--help'],
  string: ['--profile', '--min-score', '--limit', '--focus', '--reason', '--from', '--run', '--since', '--type'],
} as const;

function out(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function note(text: string): void {
  process.stderr.write(`jobhunt: ${text}\n`);
}

function line(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function number(values: Map<string, string>, flag: string): number | undefined {
  const raw = values.get(flag);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new UsageError(`${flag} must be a whole number, got "${raw}"`);
  return Number(raw);
}

function formatCandidates(list: Candidate[]): string {
  if (list.length === 0) return '(nothing matched)';
  return list
    .map((candidate, index) =>
      [index, candidate.score, candidate.company, candidate.title, candidate.loc || '-', candidate.workplace,
        candidate.comp || 'pay ?', candidate.flags.filter((flag) => flag !== 'pay:unknown').join('+') || '-'].join(' | '))
    .join('\n');
}

function formatQueue(queue: QueueItem[], seen: (url: string) => boolean): string {
  if (queue.length === 0) return '(queue is empty — `jobhunt queue add <index…>` after `jobhunt discover`)';
  return queue
    .map((item, index) =>
      `${index}  ${item.key}${seen(item.url) ? '  (already applied)' : ''}\n     ${item.company} — ${item.title}\n     ${item.applyUrl || item.url}\n     focus: ${item.focus ?? '(none)'}`)
    .join('\n');
}

function formatFilters(settings: Settings): string {
  const f = settings.profile.filters;
  const list = (items: string[]) => (items.length ? items.join(', ') : '—');
  return [
    `  source          ${f.source}`,
    `  workplace       ${list(f.workplace)}`,
    `  countries       ${f.countries.length ? f.countries.join(', ') : 'any'}`,
    `  title.include   ${list(f.title.include)}`,
    `  title.exclude   ${list(f.title.exclude)}`,
    `  pay             min ${f.pay.min ?? '—'} ${f.pay.currency}, ${f.pay.require ? 'stated pay required' : 'unstated pay allowed (flagged pay:unknown)'}`,
    `  minScore        ${f.minScore}`,
    `  limit           ${f.limit}`,
    `  exclude         ${list(f.exclude)}`,
    ...Object.entries(f.boost).map(([tag, boost]) =>
      `  boost.${tag.padEnd(10)} +${boost.weight} ${boost.in === 'title' ? 'title ' : ''}${boost.terms.join(', ')}`),
  ].join('\n');
}

function mailFor(settings: Settings, off: boolean): { name: string | null; why: string } {
  if (off) return { name: null, why: 'off (--no-mail)' };
  let result: ReturnType<typeof mailAccountFor>;
  try {
    result = mailAccountFor(settings.profile, loadMailConfig());
  } catch (error) {
    return { name: null, why: (error as Error).message };
  }
  return 'name' in result
    ? { name: result.name, why: `read from the \`mail\` account "${result.name}"` }
    : { name: null, why: `${result.none}; codes are read from the code file only` };
}

/** Load, pick the profile, and hand back the things every verb needs. */
function setup(profileFlag: string | undefined) {
  const loaded = loadJobsConfig();
  const settings = resolveSettings(loaded.config, profileFlag);
  mkdirSync(settings.profileDir, { recursive: true, mode: 0o700 });
  const context: RunContext = { stateDir: settings.stateDir, profileDir: settings.profileDir, emit: line };
  return { ...loaded, settings, context };
}

/** The profile a write goes to, created when running on the implicit empty one. */
function writableProfile(config: JobsConfig, settings: Settings): Profile {
  if (!config.profiles[settings.profileName]) {
    config.profiles[settings.profileName] = emptyProfile();
    config.default ??= settings.profileName;
  }
  return config.profiles[settings.profileName]!;
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, SPEC);
  if (parsed.flags.has('-h') || parsed.flags.has('--help') || parsed.positional.length === 0) {
    out(USAGE);
    return parsed.positional.length === 0 && !parsed.flags.has('-h') && !parsed.flags.has('--help') ? 2 : 0;
  }
  const [command, ...rest] = parsed.positional;
  const profileFlag = parsed.values.get('--profile');
  const json = parsed.flags.has('--json');

  switch (command) {
    case 'discover': {
      const { settings } = setup(profileFlag);
      const applied = readApplied(settings.stateDir);
      const minScore = number(parsed.values, '--min-score');
      const limit = number(parsed.values, '--limit');
      const result = await discover(settings.profile.filters, appliedSet(applied), {
        ...(minScore !== undefined ? { minScore } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      writeJsonAtomic(shortlistPath(settings.profileDir), result.shortlist);
      logHistory(settings.stateDir, {
        type: 'discover', profile: settings.profileName,
        detail: { companies: result.companies, boards: result.withBoards, matched: result.matched, shortlist: result.shortlist.length, applied: applied.length },
      });
      note(
        `profile ${settings.profileName}: ${result.companies} companies, ${result.withBoards} with boards, ` +
          `${result.matched} postings matched, ${result.dropped.applied ?? 0} already handled, ` +
          `shortlist ${result.shortlist.length} -> ${shortlistPath(settings.profileDir)}`,
      );
      out(json ? JSON.stringify(result.shortlist, null, 1) : formatCandidates(result.shortlist));
      return 0;
    }

    case 'shortlist': {
      const { settings } = setup(profileFlag);
      const list = readShortlist(settings.profileDir);
      out(json ? JSON.stringify(list, null, 1) : formatCandidates(list));
      return 0;
    }

    case 'queue': {
      const { settings } = setup(profileFlag);
      const seen = appliedSet(readApplied(settings.stateDir));
      let queue = readQueue(settings.profileDir);
      const [verb, ...args] = rest;
      const base = { profile: settings.profileName };
      if (!verb) {
        out(json ? JSON.stringify(queue, null, 1) : formatQueue(queue, seen));
        return 0;
      }
      if (verb === 'add') {
        if (args.length === 0 || args.some((arg) => !/^\d+$/.test(arg))) throw new UsageError('queue add takes shortlist numbers: `jobhunt queue add 0 3 5`');
        const result = queueAdd(queue, readShortlist(settings.profileDir), args.map(Number), parsed.values.get('--focus') ?? null, seen);
        writeQueue(settings.profileDir, result.queue);
        for (const item of result.added) logHistory(settings.stateDir, { ...base, type: 'queue-add', key: item.key, company: item.company, url: item.url });
        for (const skipped of result.skipped) note(skipped);
        out(formatQueue(result.queue, seen));
        if (settings.profile.why?.includes('{focus}') && result.added.some((item) => !item.focus)) {
          note('the why-us template uses {focus}; set it per job with `jobhunt queue focus <key> "<text>"`');
        }
        return 0;
      }
      if (verb === 'focus') {
        const [ref, ...words] = args;
        const item = ref ? findQueued(queue, ref) : undefined;
        if (!item || words.length === 0) throw new UsageError('queue focus <key> <text>');
        item.focus = words.join(' ');
        writeQueue(settings.profileDir, queue);
        logHistory(settings.stateDir, { ...base, type: 'queue-focus', key: item.key, company: item.company });
        out(formatQueue(queue, seen));
        return 0;
      }
      if (verb === 'rm') {
        const gone = args.map((ref) => findQueued(queue, ref)).filter((item): item is QueueItem => Boolean(item));
        if (gone.length === 0) throw new UsageError('queue rm <key|index…> — nothing matched');
        queue = queue.filter((item) => !gone.includes(item));
        writeQueue(settings.profileDir, queue);
        for (const item of gone) logHistory(settings.stateDir, { ...base, type: 'queue-rm', key: item.key, company: item.company });
        out(formatQueue(queue, seen));
        return 0;
      }
      if (verb === 'clear') {
        writeQueue(settings.profileDir, []);
        logHistory(settings.stateDir, { ...base, type: 'queue-clear', detail: { removed: queue.length } });
        out('queue cleared');
        return 0;
      }
      throw new UsageError(`unknown queue verb "${verb}"`);
    }

    case 'skip': {
      const { settings } = setup(profileFlag);
      const ref = rest[0];
      const reason = parsed.values.get('--reason');
      if (!ref || !reason) throw new UsageError('skip <index|key|url> --reason R');
      const shortlist = readShortlist(settings.profileDir);
      const queue = readQueue(settings.profileDir);
      let target: { url: string; company?: string; title?: string } | undefined;
      if (/^https?:\/\//.test(ref)) {
        target = [...queue, ...shortlist].find((item) => jobKey(item.url) === jobKey(ref) || jobKey(item.applyUrl) === jobKey(ref)) ?? { url: ref };
      } else if (/^\d+$/.test(ref)) {
        target = shortlist[Number(ref)];
      } else {
        target = findQueued(queue, ref);
      }
      if (!target) throw new UsageError(`nothing called "${ref}" in the shortlist or the queue`);
      const status = `skipped:${reason.replace(/\s+/g, '-')}`;
      recordApplied(settings.stateDir, {
        url: target.url, ...(target.company ? { company: target.company } : {}), ...(target.title ? { title: target.title } : {}),
        status, via: 'jobhunt', profile: settings.profileName, at: new Date().toISOString(),
      });
      const remaining = queue.filter((item) => jobKey(item.url) !== jobKey(target.url));
      if (remaining.length !== queue.length) writeQueue(settings.profileDir, remaining);
      logHistory(settings.stateDir, {
        type: 'skip', profile: settings.profileName, url: target.url, status,
        ...(target.company ? { company: target.company } : {}),
      });
      out(`${status}: ${target.company ?? ''} ${target.title ?? ''} ${target.url}`.replace(/\s+/g, ' '));
      return 0;
    }

    case 'apply':
      return runVerb(['start', ...rest], parsed, profileFlag, { foreground: true });

    case 'run':
      return runVerb(rest, parsed, profileFlag, { foreground: false });

    case 'status': {
      const { settings, context } = setup(profileFlag);
      const applied = readApplied(settings.stateDir);
      const byStatus: Record<string, number> = {};
      const byProfile: Record<string, number> = {};
      for (const row of applied) {
        const bucket = row.status.split(':')[0]!;
        byStatus[bucket] = (byStatus[bucket] ?? 0) + 1;
        const who = row.profile ?? '(before profiles)';
        byProfile[who] = (byProfile[who] ?? 0) + 1;
      }
      const seen = appliedSet(applied);
      const queue = readQueue(settings.profileDir);
      const waiting = queue.filter((item) => !seen(item.url));
      const run = latestRun(settings.stateDir, settings.profileName);
      const results = readJsonl<Record<string, unknown>>(resultsPath(settings.profileDir)).slice(-10);
      if (json) {
        out(JSON.stringify({ profile: settings.profileName, applied: applied.length, byStatus, byProfile, queued: waiting.length, run: run ? reconcile(context, run) : null, results }, null, 1));
        return 0;
      }
      out([
        `profile  ${settings.profileName}`,
        `applied  ${applied.length} handled — ${Object.entries(byStatus).map(([key, count]) => `${key} ${count}`).join(', ') || 'none'}`,
        `         by profile: ${Object.entries(byProfile).map(([key, count]) => `${key} ${count}`).join(', ') || '—'}`,
        `queue    ${waiting.length} waiting${queue.length > waiting.length ? ` (${queue.length - waiting.length} already handled)` : ''}`,
        `run      ${run ? formatRunLine(reconcile(context, run)) : '(none yet)'}`,
        '',
        'recent results:',
        ...(results.length
          ? results.map((row) => `  ${String(row.at ?? '').slice(0, 16).replace('T', ' ')}  ${String(row.status).padEnd(18)} ${row.company} — ${row.title}${row.dryRun ? '  (dry run)' : ''}`)
          : ['  (none)']),
      ].join('\n'));
      return 0;
    }

    case 'history': {
      const loaded = loadJobsConfig();
      const settings = resolveSettings(loaded.config, profileFlag);
      const limit = number(parsed.values, '--limit') ?? 50;
      const since = parsed.values.get('--since');
      const types = parsed.values.get('--type');
      const events = filterHistory(readHistory(settings.stateDir), {
        profile: profileFlag,
        run: parsed.values.get('--run'),
        since: since ? parseSince(since) : undefined,
        types: types ? types.split(',').map((type) => type.trim()).filter(Boolean) : undefined,
      }).slice(-limit);
      if (json) out(JSON.stringify(events, null, 1));
      else out(events.length ? formatHistory(events) : '(no history matches)');
      return 0;
    }

    case 'config':
      return configVerb(rest, parsed, profileFlag);

    case 'profile':
      return profileVerb(rest, parsed);

    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}

async function configVerb(rest: string[], parsed: ReturnType<typeof parseArgs>, profileFlag: string | undefined): Promise<number> {
  const loaded = loadJobsConfig();
  const settings = resolveSettings(loaded.config, profileFlag);
  const [verb, ...args] = rest;

  if (verb === 'set' || verb === 'unset') {
    if (args.length === 0) throw new UsageError(`config ${verb} needs ${verb === 'set' ? 'key=value' : 'a key'}`);
    const profile = writableProfile(loaded.config, settings);
    for (const arg of args) {
      if (verb === 'set') profile.filters = setFilter(profile.filters, parseAssignment(arg));
      else profile.filters = unsetFilter(profile.filters, arg);
    }
    const path = saveJobsConfig(loaded.config);
    logHistory(settings.stateDir, { type: verb === 'set' ? 'config-set' : 'config-unset', profile: settings.profileName, detail: { changes: args } });
    note(`saved to ${path} (profile ${settings.profileName})`);
    return configVerb([], parsed, settings.profileName);
  }
  if (verb) throw new UsageError(`unknown config verb "${verb}" — set, unset, or nothing to show`);

  const mail = mailFor(settings, false);
  if (parsed.flags.has('--json')) {
    out(JSON.stringify({
      file: loaded.path, found: loaded.found, profile: settings.profileName, implicit: settings.implicit,
      profiles: Object.keys(loaded.config.profiles), stateDir: settings.stateDir, profileDir: settings.profileDir,
      automateBin: settings.automateBin, chromiumBin: settings.chromiumBin, mail: mail.name, filters: settings.profile.filters,
    }, null, 1));
    return 0;
  }
  const exists = (path: string | null) => (path ? (existsSync(path) ? path : `${path} (missing)`) : '(not set)');
  out([
    `file      ${loaded.path}${loaded.found ? '' : ' (not created yet)'}`,
    `profile   ${settings.profileName}${settings.implicit ? ' (none configured — `jobhunt profile add <name>`)' : loaded.config.default === settings.profileName ? ' (default)' : ''}` +
      (Object.keys(loaded.config.profiles).length > 1 ? `   all: ${Object.keys(loaded.config.profiles).join(', ')}` : ''),
    `state     ${settings.stateDir}`,
    `          ${settings.profileDir}`,
    `tron      ${exists(settings.automateBin)}`,
    `browser   ${settings.chromiumBin ? exists(settings.chromiumBin) : "tron's bundled engine"}`,
    `resume    ${exists(settings.profile.resume)}`,
    `cover     ${exists(settings.profile.cover)}`,
    `codes     ${mail.why}`,
    'filters:',
    formatFilters(settings),
  ].join('\n'));
  return 0;
}

async function profileVerb(rest: string[], parsed: ReturnType<typeof parseArgs>): Promise<number> {
  const loaded = loadJobsConfig();
  const { config } = loaded;
  const [verb, name, ...args] = rest;
  const stateDir = resolveSettings({ ...config, default: null, profiles: {} }, undefined).stateDir;
  const need = (value: string | undefined): string => {
    if (!value) throw new UsageError(`profile ${verb} needs a profile name`);
    return value;
  };
  const existing = (value: string): Profile => {
    const profile = config.profiles[value];
    if (!profile) throw new JobsError(`no profile "${value}" — \`jobhunt profile list\``);
    return profile;
  };

  switch (verb ?? 'list') {
    case 'list': {
      const names = Object.keys(config.profiles);
      if (names.length === 0) out('(no profiles — `jobhunt profile add <name>`)');
      for (const each of names) {
        const profile = config.profiles[each]!;
        const who = [profile.applicant.firstName, profile.applicant.lastName].filter(Boolean).join(' ') || '(no name)';
        out(`${each === config.default ? '*' : ' '} ${each.padEnd(20)} ${who.padEnd(24)} ${profile.resume ?? '(no resume)'}`);
      }
      return 0;
    }
    case 'show': {
      const which = name ?? resolveSettings(config, undefined).profileName;
      out(JSON.stringify(existing(which), null, 2));
      return 0;
    }
    case 'add': {
      const target = need(name);
      if (!isProfileName(target)) throw new UsageError('a profile name is lowercase letters, digits, - and _');
      if (config.profiles[target]) throw new JobsError(`profile "${target}" exists — \`jobhunt profile set ${target} key=value\``);
      const from = parsed.values.get('--from');
      let profile = from ? structuredClone(existing(from)) : emptyProfile();
      for (const arg of args) profile = setProfileField(profile, parseAssignment(arg));
      checkDocuments(profile);
      config.profiles[target] = profile;
      config.default ??= target;
      const path = saveJobsConfig(config);
      logHistory(stateDir, { type: 'profile-add', profile: target, detail: { ...(from ? { from } : {}), keys: args.map((arg) => parseAssignment(arg).path.join('.')) } });
      out(`added profile ${target}${config.default === target ? ' (default)' : ''} to ${path}`);
      return 0;
    }
    case 'set': {
      const target = need(name);
      if (args.length === 0) throw new UsageError('profile set <name> key=value…');
      let profile = existing(target);
      for (const arg of args) profile = setProfileField(profile, parseAssignment(arg));
      config.profiles[target] = profile;
      saveJobsConfig(config);
      // Keys only: values are the applicant's details, and the log is not the place for them.
      logHistory(stateDir, { type: 'profile-set', profile: target, detail: { keys: args.map((arg) => parseAssignment(arg).path.join('.')) } });
      out(`updated ${target}: ${args.map((arg) => parseAssignment(arg).path.join('.')).join(', ')}`);
      return 0;
    }
    case 'answer': {
      const target = need(name);
      const [match, ...words] = args;
      if (!match || words.length === 0) throw new UsageError('profile answer <name> "<label regex>" <value> [--select]');
      if (!isRegex(match)) throw new JobsError(`"${match}" is not a valid regular expression`);
      const profile = existing(target);
      profile.rules = profile.rules.filter((rule) => rule.match !== match);
      profile.rules.push({ match, kind: parsed.flags.has('--select') ? 'select' : 'fill', value: words.join(' ') });
      saveJobsConfig(config);
      logHistory(stateDir, { type: 'profile-answer', profile: target, detail: { match } });
      out(`${target}: fields labelled /${match}/i are answered with a ${parsed.flags.has('--select') ? 'select' : 'fill'}`);
      return 0;
    }
    case 'use': {
      const target = need(name);
      existing(target);
      config.default = target;
      saveJobsConfig(config);
      logHistory(stateDir, { type: 'profile-use', profile: target });
      out(`default profile: ${target}`);
      return 0;
    }
    case 'rm': {
      const target = need(name);
      existing(target);
      if (!parsed.flags.has('--yes')) {
        const ok = process.stdin.isTTY ? await confirm(`remove profile "${target}"? (its state and the applied history stay)`) : false;
        if (!ok) throw new JobsError('not removed — pass --yes');
      }
      delete config.profiles[target];
      if (config.default === target) config.default = null;
      saveJobsConfig(config);
      logHistory(stateDir, { type: 'profile-rm', profile: target });
      out(`removed profile ${target}`);
      return 0;
    }
    default:
      throw new UsageError(`unknown profile verb "${verb}"`);
  }
}

// Help and flag checks happen above; this is the run lifecycle.
async function runVerb(
  rest: string[],
  parsed: ReturnType<typeof parseArgs>,
  profileFlag: string | undefined,
  { foreground }: { foreground: boolean },
): Promise<number> {
  const { settings, context } = setup(profileFlag);
  const [verb, ref] = rest;
  const noMail = parsed.flags.has('--no-mail');
  const pick = (id: string | undefined) => {
    if (id) return loadRun(settings.stateDir, id);
    const latest = latestRun(settings.stateDir, settings.profileName);
    if (!latest) throw new JobsError(`no runs yet for profile ${settings.profileName}`);
    return latest;
  };

  switch (verb) {
    case 'start': {
      const dryRun = parsed.flags.has('--dry-run');
      const problems = preflight(settings);
      if (problems.length) throw new JobsError(`cannot apply yet:\n  ${problems.join('\n  ')}`);
      const queue = readQueue(settings.profileDir);
      const seen = appliedSet(readApplied(settings.stateDir));
      const pending = queue.filter((item) => (!ref || item.key === ref) && !seen(item.url));
      if (pending.length === 0) throw new JobsError(ref ? `"${ref}" is not queued, or already handled` : 'nothing to apply to — the queue is empty or all handled');
      if (!dryRun && foreground && process.stdin.isTTY && !parsed.flags.has('--yes')) {
        out(formatQueue(pending, seen));
        if (!(await confirm(`submit ${pending.length} application(s) as ${settings.profileName}?`))) throw new JobsError('not started');
      }
      const record = createRun(context, settings.profileName, queue, { dryRun, only: ref });
      note(`run ${record.id}: ${record.jobs.filter((job) => job.state === 'pending').length} job(s)${dryRun ? ', dry run — nothing is submitted' : ''}; codes ${mailFor(settings, noMail).why}`);
      if (parsed.flags.has('--detach')) return detach(settings, record.id, noMail);
      return work(settings, context, record.id, noMail);
    }
    case 'work':
      // The detached child: the parent already created or prepared the record.
      if (!ref) throw new UsageError('run work <id>');
      return work(settings, context, ref, noMail);
    case 'resume':
    case 'restart': {
      let record = reconcile(context, pick(ref));
      if (verb === 'restart' && (record.status === 'running' || record.status === 'stopping')) {
        note(`stopping ${record.id} first`);
        record = await stopRun(context, record.id);
      }
      if (record.status === 'finished' && record.jobs.every((job) => job.state !== 'pending' && job.state !== 'running' && job.state !== 'awaiting-code')) {
        out(`run ${record.id} is finished; nothing to resume`);
        return 0;
      }
      const plan = prepareResume(context, record, verb);
      note(`run ${record.id}: redo ${plan.redo.length}, not started ${plan.pending.length}, done ${plan.done.length}, applied elsewhere ${plan.skipped.length}`);
      if (plan.redo.length + plan.pending.length === 0) return 0;
      if (parsed.flags.has('--detach')) return detach(settings, record.id, noMail);
      return work(settings, context, record.id, noMail);
    }
    case 'stop': {
      const record = await stopRun(context, pick(ref).id);
      out(formatRunLine(record));
      return 0;
    }
    case 'list': {
      const runs = listRuns(settings.stateDir).map((record) => reconcile(context, record));
      out(runs.length ? runs.map(formatRunLine).join('\n') : '(no runs yet)');
      return 0;
    }
    case 'show': {
      const record = reconcile(context, pick(ref));
      out(parsed.flags.has('--json') ? JSON.stringify(record, null, 1) : formatRun(record));
      return 0;
    }
    default:
      throw new UsageError(`unknown run verb "${verb ?? ''}" — start, stop, resume, restart, list, show`);
  }
}

function detach(settings: Settings, id: string, noMail: boolean): number {
  const logFile = runLogPath(settings.stateDir, id);
  const fd = openSync(logFile, 'a', 0o600);
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), 'run', 'work', id, '--profile', settings.profileName, ...(noMail ? ['--no-mail'] : [])],
    { detached: true, stdio: ['ignore', fd, fd], env: process.env },
  );
  child.unref();
  const record = loadRun(settings.stateDir, id);
  record.pid = child.pid ?? null;
  record.log = logFile;
  saveRun(settings.stateDir, record);
  out(`run ${id} started in the background (pid ${child.pid})\n  log:  ${logFile}\n  jobhunt run show ${id}   jobhunt run stop ${id}`);
  return 0;
}

async function work(settings: Settings, context: RunContext, id: string, noMail: boolean): Promise<number> {
  const record = loadRun(settings.stateDir, id);
  const controller = new AbortController();
  let signals = 0;
  const onSignal = () => {
    signals += 1;
    if (signals === 1) {
      note('stopping: a form not yet submitted is abandoned; one already submitted is finished first (again to force)');
      controller.abort();
    } else process.exit(130);
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  const mail = mailFor(settings, noMail);
  const applyJob = makeApplyJob({ settings, dryRun: record.dryRun, mailAccount: mail.name });
  const done = await runWorker(context, id, applyJob, controller.signal);
  return done.jobs.some((job) => job.state === 'failed') ? 1 : 0;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      if (error instanceof UsageError) {
        process.stderr.write(`${USAGE}\njobhunt: ${error.message}\n`);
        process.exit(2);
      }
      if (error instanceof JobsError) {
        note(error.message);
        process.exit(1);
      }
      note((error as Error).stack ?? String(error));
      process.exit(1);
    },
  );
}
