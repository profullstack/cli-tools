import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Who is applying, with what, and to which kind of job.
 *
 * None of this is a property of the tool. A name, a phone number, a résumé and
 * an answer to "do you need sponsorship" are the applicant's, and a checkout
 * that carried someone else's would fill their details into your applications.
 * So every default here is empty, and a form with a required question nobody
 * configured an answer for stops at "needs a human" rather than guessing.
 *
 * A profile bundles all of it — identity, documents, answers, the "why us"
 * paragraph and the search filters — so one person can hunt for two kinds of
 * role (say, an AI engineer résumé and an architect one) without the answers
 * of one leaking into the other. What a profile does NOT own is the record of
 * what has been sent: that is global, because applying twice to the same
 * posting from two profiles is exactly as bad as applying twice from one.
 */

export class JobsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobsError';
  }
}

export const WORKPLACES = ['remote', 'hybrid', 'onsite'] as const;
export type Workplace = (typeof WORKPLACES)[number];

/** A weighted group of terms that raises a posting's score when any of them appears. */
export interface Boost {
  /** Case-insensitive regular expressions; a plain word is a valid one. */
  terms: string[];
  weight: number;
  /** Where to look: the title only, or the title and the description. */
  in: 'any' | 'title';
}

export interface Filters {
  /** A Markdown list of companies (URL or local file): table rows or bullets with a link each. */
  source: string;
  workplace: Workplace[];
  /** ISO country codes (US, CA, GB …) or region names (EMEA, APAC, LATAM); empty means anywhere. */
  countries: string[];
  title: {
    /** A title must match one of these (substring, case-insensitive regex). */
    include: string[];
    /** A title matching one of these as a whole word is dropped. */
    exclude: string[];
  };
  pay: {
    /** Annual minimum in `currency`. Null means no pay filter. */
    min: number | null;
    currency: string;
    /** Drop postings that state no pay at all, instead of flagging them `pay:unknown`. */
    require: boolean;
  };
  boost: Record<string, Boost>;
  minScore: number;
  limit: number;
  /** Flags (ONSITE, CLEARANCE, NON-JS, LOCATION-BOUND, pay:unknown) that drop a posting outright. */
  exclude: string[];
}

export interface Applicant {
  firstName: string | null;
  lastName: string | null;
  /** What goes in "preferred name"; falls back to firstName. */
  preferredName: string | null;
  email: string | null;
  phone: string | null;
  linkedin: string | null;
  github: string | null;
  website: string | null;
  /** "City, ST, Country" — for "where are you currently located". */
  location: string | null;
  /** Just the city — for location autocompletes, which search on it. */
  city: string | null;
}

/**
 * Answers to the screening questions the built-in rules recognise.
 *
 * Each is the exact option text to pick (or type), so "Yes", "No", "United
 * States". Anything a form asks that is not here and not in `rules` makes the
 * run stop for a human, which is the point: a wrong answer to a work
 * authorisation question is worse than no application.
 */
export const ANSWER_KEYS = [
  'country',
  'workAuthorized',
  'sponsorship',
  'bayArea',
  'previouslyApplied',
  'llmExperience',
  'largeScaleBackend',
  'clientFacing',
  'heardFrom',
] as const;
export type AnswerKey = (typeof ANSWER_KEYS)[number];
export type Answers = Record<AnswerKey, string | null>;

/** What each answer key is matched against, for `jobhunt profile` help. */
export const ANSWER_HELP: Record<AnswerKey, string> = {
  country: '"Country" select (e.g. United States)',
  workAuthorized: '"legally authorized / eligible to work" (Yes/No)',
  sponsorship: '"require sponsorship / visa" (Yes/No)',
  bayArea: '"based in the Bay Area / Pacific time" (Yes/No)',
  previouslyApplied: '"previously applied / interviewed with us" (Yes/No)',
  llmExperience: '"experience with large language models" (Yes/No)',
  largeScaleBackend: '"large scale backend" experience (Yes/No)',
  clientFacing: '"client-facing / customer handling" experience (Yes/No)',
  heardFrom: '"How did you hear about us" option text (e.g. Company website)',
};

/** A question the built-ins do not know, answered by label. */
export interface CustomRule {
  /** Case-insensitive regex tested against the field's label. */
  match: string;
  kind: 'fill' | 'select';
  value: string;
}

export interface Profile {
  applicant: Applicant;
  resume: string | null;
  cover: string | null;
  /**
   * The "why do you want to work here" answer. `{company}` and `{focus}` are
   * replaced per job; focus is what you set when queueing it.
   */
  why: string | null;
  answers: Answers;
  rules: CustomRule[];
  filters: Filters;
  /** The `mail` account that receives security codes; default is the one whose address matches. */
  mailAccount: string | null;
}

export interface JobsConfig {
  default: string | null;
  profiles: Record<string, Profile>;
  /** Where applied.jsonl and the per-profile state live. */
  state: string | null;
  tron: { automateBin: string | null; chromiumBin: string | null };
}

export const DEFAULT_SOURCE =
  'https://raw.githubusercontent.com/vinitshahdeo/awesome-ai-startups-hiring/main/README.md';

/**
 * The search the tool shipped with: remote, US, engineering titles, scored for
 * agentic and AI-assisted coding work. Kept as data so every piece of it can be
 * changed per profile.
 */
export function defaultFilters(): Filters {
  return {
    source: DEFAULT_SOURCE,
    workplace: ['remote'],
    countries: ['US'],
    title: {
      include: ['engineer', 'developer', 'architect', 'member of technical staff'],
      exclude: [
        'intern', 'new grad', 'junior', 'sales', 'recruit', 'director', 'vp', 'manager', 'strategist',
        'operations', 'client services', 'solutions architect', 'hardware', 'embedded', 'firmware',
        'mechanical', 'electrical', 'asic', 'fpga', 'silicon', 'support engineer', 'solutions engineer',
        'sales engineer', 'research scientist', 'ml research', 'ios', 'android',
      ],
    },
    pay: { min: null, currency: 'USD', require: false },
    boost: {
      'ai-tools': { terms: ['claude code', 'cursor', 'codex', 'copilot', 'windsurf'], weight: 4, in: 'any' },
      'ai-coding-culture': {
        terms: [
          'agentic coding', 'ai[- ]native', 'coding agents?', 'ai[- ]assisted (development|coding)',
          'write (almost )?(all|most) of (our|the) code',
        ],
        weight: 5,
        in: 'any',
      },
      agents: { terms: ['\\bagent(s|ic)?\\b'], weight: 3, in: 'any' },
      'js-stack': { terms: ['full[- ]?stack', 'typescript', 'node', 'react', 'svelte'], weight: 2, in: 'any' },
      role: { terms: ['founding', 'forward deployed', 'product engineer'], weight: 2, in: 'any' },
      'title-ai': { terms: ['agent', '\\bai\\b', 'llm'], weight: 3, in: 'title' },
    },
    minScore: 7,
    limit: 40,
    exclude: [],
  };
}

export function emptyApplicant(): Applicant {
  return {
    firstName: null, lastName: null, preferredName: null, email: null, phone: null,
    linkedin: null, github: null, website: null, location: null, city: null,
  };
}

export function emptyAnswers(): Answers {
  return Object.fromEntries(ANSWER_KEYS.map((key) => [key, null])) as Answers;
}

export function emptyProfile(): Profile {
  return {
    applicant: emptyApplicant(),
    resume: null,
    cover: null,
    why: null,
    answers: emptyAnswers(),
    rules: [],
    filters: defaultFilters(),
    mailAccount: null,
  };
}

export function emptyConfig(): JobsConfig {
  return { default: null, profiles: {}, state: null, tron: { automateBin: null, chromiumBin: null } };
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function xdgConfigHome(env: NodeJS.ProcessEnv): string {
  return env.XDG_CONFIG_HOME || join(homedir(), '.config');
}

function xdgDataHome(env: NodeJS.ProcessEnv): string {
  return env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
}

export function jobsConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.JOBS_CONFIG || join(xdgConfigHome(env), 'cli-tools', 'jobs.json');
}

/** `~/x` → `$HOME/x`. Config values are typed by hand, so they get the shell's reading of `~`. */
export function expandHome(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

// ---------------------------------------------------------------------------
// Normalising what was read
// ---------------------------------------------------------------------------

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asStrings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((item) => (typeof item === 'string' && item.trim() ? [item.trim()] : []));
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asWorkplaces(value: unknown): Workplace[] | null {
  const list = asStrings(value);
  if (!list) return null;
  if (list.some((item) => item.toLowerCase() === 'any')) return [...WORKPLACES];
  return WORKPLACES.filter((place) => list.some((item) => item.toLowerCase() === place));
}

/**
 * Filters as stored, over the defaults.
 *
 * Lists replace rather than merge: a profile that sets `countries` to `["CA"]`
 * means Canada, not Canada-and-the-US. The same goes for `boost` as a whole, so
 * removing one of the default boosts stays removed.
 */
export function normalizeFilters(raw: unknown): Filters {
  const base = defaultFilters();
  const object = record(raw);
  const title = record(object.title);
  const pay = record(object.pay);

  let boost = base.boost;
  if (object.boost !== undefined) {
    boost = {};
    for (const [tag, value] of Object.entries(record(object.boost))) {
      const entry = record(value);
      const terms = asStrings(entry.terms);
      if (!terms || terms.length === 0) continue;
      boost[tag] = {
        terms,
        weight: asNumber(entry.weight) ?? 1,
        in: entry.in === 'title' ? 'title' : 'any',
      };
    }
  }

  return {
    source: asString(object.source) ?? base.source,
    workplace: asWorkplaces(object.workplace) ?? base.workplace,
    countries: (asStrings(object.countries) ?? base.countries).map((code) => code.toUpperCase()),
    title: {
      include: asStrings(title.include) ?? base.title.include,
      exclude: asStrings(title.exclude) ?? base.title.exclude,
    },
    pay: {
      min: pay.min === null ? null : (asNumber(pay.min) ?? base.pay.min),
      currency: (asString(pay.currency) ?? base.pay.currency).toUpperCase(),
      require: typeof pay.require === 'boolean' ? pay.require : base.pay.require,
    },
    boost,
    minScore: asNumber(object.minScore) ?? base.minScore,
    limit: asNumber(object.limit) ?? base.limit,
    exclude: asStrings(object.exclude) ?? base.exclude,
  };
}

export function normalizeProfile(raw: unknown): Profile {
  const object = record(raw);
  const applicantRaw = record(object.applicant);
  const answersRaw = record(object.answers);
  const applicant = emptyApplicant();
  for (const key of Object.keys(applicant) as (keyof Applicant)[]) applicant[key] = asString(applicantRaw[key]);
  const answers = emptyAnswers();
  for (const key of ANSWER_KEYS) answers[key] = asString(answersRaw[key]);

  const rules = Array.isArray(object.rules)
    ? object.rules.flatMap((value): CustomRule[] => {
        const entry = record(value);
        const match = asString(entry.match);
        const answer = asString(entry.value);
        if (!match || !answer || !isRegex(match)) return [];
        return [{ match, kind: entry.kind === 'select' ? 'select' : 'fill', value: answer }];
      })
    : [];

  return {
    applicant,
    resume: asString(object.resume),
    cover: asString(object.cover),
    why: asString(object.why),
    answers,
    rules,
    filters: normalizeFilters(object.filters),
    mailAccount: asString(object.mailAccount),
  };
}

/** Accept only the shape we write, so a hand edit cannot smuggle in nonsense. */
export function normalizeConfig(raw: unknown): JobsConfig {
  const object = record(raw);
  const profiles: Record<string, Profile> = {};
  for (const [name, value] of Object.entries(record(object.profiles))) {
    if (isProfileName(name)) profiles[name] = normalizeProfile(value);
  }
  const tron = record(object.tron);
  const wanted = asString(object.default);
  return {
    default: wanted && profiles[wanted] ? wanted : null,
    profiles,
    state: asString(object.state),
    tron: { automateBin: asString(tron.automateBin), chromiumBin: asString(tron.chromiumBin) },
  };
}

export function isProfileName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,39}$/.test(name);
}

export function isRegex(source: string): boolean {
  try {
    new RegExp(source, 'i');
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Reading and writing
// ---------------------------------------------------------------------------

export interface LoadedConfig {
  config: JobsConfig;
  path: string;
  /** False when no file exists yet — running with none is a supported mode. */
  found: boolean;
}

/**
 * Read the config. A missing file is an empty config; malformed JSON is an
 * error, because silently applying with somebody's answers stripped out is
 * worse than refusing to apply.
 */
export function loadJobsConfig(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const path = jobsConfigPath(env);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { config: emptyConfig(), path, found: false };
  }
  try {
    return { config: normalizeConfig(JSON.parse(text)), path, found: true };
  } catch (error) {
    throw new JobsError(`${path}: not valid JSON — ${(error as Error).message}`);
  }
}

/** 0600, because a profile is a phone number, an address and a résumé path. */
export function saveJobsConfig(config: JobsConfig, env: NodeJS.ProcessEnv = process.env): string {
  const path = jobsConfigPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // The mode only applies on create; an existing file keeps a hand-set one.
  chmodSync(path, 0o600);
  return path;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface Settings {
  profileName: string;
  profile: Profile;
  /** True when no profile is configured and this is the empty stand-in. */
  implicit: boolean;
  /** Global: applied.jsonl lives here. */
  stateDir: string;
  /** Per profile: shortlist, queue, results, logs, codes. */
  profileDir: string;
  automateBin: string;
  chromiumBin: string | null;
}

/**
 * Which profile a command means: the flag, then $JOBS_PROFILE, then the one
 * `profile use` chose, then the only one there is. With several profiles and
 * no default, that is a question rather than a guess.
 */
export function pickProfileName(
  config: JobsConfig,
  flag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { name: string; implicit: boolean } {
  const names = Object.keys(config.profiles);
  const wanted = (flag ?? env.JOBS_PROFILE ?? '').trim();
  if (wanted) {
    if (!config.profiles[wanted]) {
      throw new JobsError(
        names.length
          ? `no profile "${wanted}". Configured: ${names.join(', ')}`
          : `no profile "${wanted}" — create it with \`jobhunt profile add ${wanted}\``,
      );
    }
    return { name: wanted, implicit: false };
  }
  if (config.default) return { name: config.default, implicit: false };
  if (names.length === 1) return { name: names[0]!, implicit: false };
  if (names.length === 0) return { name: 'default', implicit: true };
  throw new JobsError(
    `which profile? Pass --profile (${names.join(', ')}), export JOBS_PROFILE, ` +
      'or pick one with `jobhunt profile use <name>`.',
  );
}

/** The automate entry point of a TronBrowser install, when nothing names another. */
export function defaultAutomateBin(): string {
  return join(homedir(), '.local', 'lib', 'tronbrowser', 'tronbrowser', 'sdk', 'automate-bin.js');
}

export function resolveSettings(
  config: JobsConfig,
  flag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Settings {
  const { name, implicit } = pickProfileName(config, flag, env);
  const stored = config.profiles[name] ?? emptyProfile();
  const profile: Profile = {
    ...stored,
    resume: asString(env.JOBS_RESUME) ?? stored.resume,
    cover: asString(env.JOBS_COVER) ?? stored.cover,
    why: asString(env.JOBS_WHY) ?? stored.why,
  };
  const stateDir = expandHome(
    asString(env.JOBS_STATE) ?? config.state ?? join(xdgDataHome(env), 'cli-tools', 'jobs'),
  );
  const chromium = asString(env.TRON_CHROMIUM_BIN) ?? config.tron.chromiumBin;
  return {
    profileName: name,
    profile,
    implicit,
    stateDir,
    profileDir: join(stateDir, 'profiles', name),
    automateBin: expandHome(asString(env.TRON_AUTOMATE_BIN) ?? config.tron.automateBin ?? defaultAutomateBin()),
    chromiumBin: chromium ? expandHome(chromium) : null,
  };
}

// ---------------------------------------------------------------------------
// Editing: `key=value`, `key+=value`, `key-=value`
// ---------------------------------------------------------------------------

export interface Assignment {
  path: string[];
  op: '=' | '+=' | '-=';
  value: string;
}

export function parseAssignment(text: string): Assignment {
  const match = /^([A-Za-z][\w.-]*?)(\+=|-=|=)(.*)$/s.exec(text);
  if (!match) throw new JobsError(`expected key=value (or key+=value / key-=value for lists), got "${text}"`);
  return { path: match[1]!.split('.'), op: match[2] as Assignment['op'], value: match[3]!.trim() };
}

function splitList(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function editList(current: string[], op: Assignment['op'], value: string): string[] {
  const items = splitList(value);
  if (op === '=') return items;
  if (op === '+=') return [...current, ...items.filter((item) => !current.includes(item))];
  return current.filter((item) => !items.includes(item));
}

function parseBool(key: string, value: string): boolean {
  if (/^(true|yes|on|1)$/i.test(value)) return true;
  if (/^(false|no|off|0)$/i.test(value)) return false;
  throw new JobsError(`${key} is true or false, got "${value}"`);
}

function parseNumber(key: string, value: string, { allowNull = false } = {}): number | null {
  if (allowNull && /^(|none|null|off)$/i.test(value)) return null;
  // 150k and 1.2m, because that is how pay gets typed.
  const match = /^(\d+(?:\.\d+)?)([km]?)$/i.exec(value.replace(/[,_$]/g, ''));
  if (!match) throw new JobsError(`${key} must be a number, got "${value}"`);
  const scale = { '': 1, k: 1_000, m: 1_000_000 }[match[2]!.toLowerCase() as '' | 'k' | 'm'];
  return Number(match[1]) * scale;
}

function checkTerms(key: string, terms: string[]): string[] {
  const bad = terms.find((term) => !isRegex(term));
  if (bad) throw new JobsError(`${key}: "${bad}" is not a valid regular expression`);
  return terms;
}

/** The filter keys `jobhunt config set` accepts, for the help and for error messages. */
export const FILTER_KEYS = [
  'source', 'workplace', 'countries', 'title.include', 'title.exclude', 'pay.min', 'pay.currency',
  'pay.require', 'minScore', 'limit', 'exclude', 'boost.<tag>.terms', 'boost.<tag>.weight', 'boost.<tag>.in',
] as const;

/** Apply one assignment to a copy of the filters, validating it. */
export function setFilter(filters: Filters, assignment: Assignment): Filters {
  const next: Filters = structuredClone(filters);
  const { path, op, value } = assignment;
  const key = path.join('.');
  const listOnly = () => {
    if (op !== '=') throw new JobsError(`${key} is not a list; use ${key}=value`);
  };

  switch (key) {
    case 'source':
      listOnly();
      next.source = value || defaultFilters().source;
      return next;
    case 'workplace': {
      const list = editList(next.workplace, op, value).map((item) => item.toLowerCase());
      const bad = list.find((item) => item !== 'any' && !(WORKPLACES as readonly string[]).includes(item));
      if (bad) throw new JobsError(`workplace is remote, hybrid, onsite or any — got "${bad}"`);
      next.workplace = list.includes('any') ? [...WORKPLACES] : (list as Workplace[]);
      if (next.workplace.length === 0) throw new JobsError('workplace cannot be empty; use workplace=any');
      return next;
    }
    case 'countries': {
      const list = editList(next.countries, op, value).map((item) => item.toUpperCase());
      next.countries = list.includes('ANY') ? [] : list;
      return next;
    }
    case 'title.include':
      next.title.include = checkTerms(key, editList(next.title.include, op, value));
      return next;
    case 'title.exclude':
      next.title.exclude = checkTerms(key, editList(next.title.exclude, op, value));
      return next;
    case 'exclude':
      next.exclude = editList(next.exclude, op, value);
      return next;
    case 'pay.min':
      listOnly();
      next.pay.min = parseNumber(key, value, { allowNull: true });
      return next;
    case 'pay.currency':
      listOnly();
      if (!/^[a-z]{3}$/i.test(value)) throw new JobsError(`pay.currency is a 3-letter code (USD, EUR, GBP), got "${value}"`);
      next.pay.currency = value.toUpperCase();
      return next;
    case 'pay.require':
      listOnly();
      next.pay.require = parseBool(key, value);
      return next;
    case 'minScore':
    case 'limit':
      listOnly();
      next[key] = parseNumber(key, value) as number;
      return next;
  }

  if (path[0] === 'boost' && path.length === 3) {
    const tag = path[1]!;
    const entry: Boost = next.boost[tag] ?? { terms: [], weight: 1, in: 'any' };
    if (path[2] === 'terms') entry.terms = checkTerms(key, editList(entry.terms, op, value));
    else if (path[2] === 'weight') { listOnly(); entry.weight = parseNumber(key, value) as number; }
    else if (path[2] === 'in') {
      listOnly();
      if (value !== 'any' && value !== 'title') throw new JobsError(`${key} is any or title, got "${value}"`);
      entry.in = value;
    } else throw new JobsError(`unknown key "${key}" — boost.<tag> takes terms, weight and in`);
    if (entry.terms.length === 0) delete next.boost[tag];
    else next.boost[tag] = entry;
    return next;
  }

  throw new JobsError(`unknown filter "${key}". Keys: ${FILTER_KEYS.join(', ')}`);
}

/** Put a filter back to its default; `boost.<tag>` removes that boost. */
export function unsetFilter(filters: Filters, key: string): Filters {
  const next: Filters = structuredClone(filters);
  const base = defaultFilters();
  const path = key.split('.');
  if (path[0] === 'boost' && path.length === 2) {
    delete next.boost[path[1]!];
    return next;
  }
  switch (key) {
    case 'source': next.source = base.source; return next;
    case 'workplace': next.workplace = base.workplace; return next;
    case 'countries': next.countries = base.countries; return next;
    case 'title.include': next.title.include = base.title.include; return next;
    case 'title.exclude': next.title.exclude = base.title.exclude; return next;
    case 'pay.min': next.pay.min = base.pay.min; return next;
    case 'pay.currency': next.pay.currency = base.pay.currency; return next;
    case 'pay.require': next.pay.require = base.pay.require; return next;
    case 'minScore': next.minScore = base.minScore; return next;
    case 'limit': next.limit = base.limit; return next;
    case 'exclude': next.exclude = base.exclude; return next;
    case 'boost': next.boost = base.boost; return next;
  }
  throw new JobsError(`unknown filter "${key}". Keys: ${FILTER_KEYS.join(', ')}`);
}

const APPLICANT_KEYS = Object.keys(emptyApplicant()) as (keyof Applicant)[];

/** The profile keys `jobhunt profile set` accepts, besides `filters.<key>`. */
export const PROFILE_KEYS = [
  ...APPLICANT_KEYS, 'resume', 'cover', 'why', 'mailAccount', ...ANSWER_KEYS.map((key) => `answers.${key}`),
];

/**
 * Apply one assignment to a copy of a profile.
 *
 * Document paths are checked here rather than at apply time: a résumé that has
 * moved is found out when you set it, not halfway through a form.
 */
export function setProfileField(
  profile: Profile,
  assignment: Assignment,
  fileExists: (path: string) => boolean = existsSync,
): Profile {
  const next: Profile = structuredClone(profile);
  const { path, op, value } = assignment;
  const key = path.join('.');

  if (path[0] === 'filters') {
    next.filters = setFilter(next.filters, { ...assignment, path: path.slice(1) });
    return next;
  }
  if (op !== '=') throw new JobsError(`${key} is not a list; use ${key}=value`);
  const cleared = value === '' ? null : value;

  if (path.length === 1 && (APPLICANT_KEYS as string[]).includes(key)) {
    next.applicant[key as keyof Applicant] = cleared;
    return next;
  }
  if (path[0] === 'applicant' && path.length === 2 && (APPLICANT_KEYS as string[]).includes(path[1]!)) {
    next.applicant[path[1] as keyof Applicant] = cleared;
    return next;
  }
  if (path[0] === 'answers' && path.length === 2) {
    if (!(ANSWER_KEYS as readonly string[]).includes(path[1]!)) {
      throw new JobsError(
        `unknown answer "${path[1]}". Known: ${ANSWER_KEYS.join(', ')} — ` +
          'for any other question use `jobhunt profile answer <name> "<label regex>" <value>`',
      );
    }
    next.answers[path[1] as AnswerKey] = cleared;
    return next;
  }
  switch (key) {
    case 'resume':
    case 'cover':
      if (cleared && !fileExists(expandHome(cleared))) throw new JobsError(`${key}: no file at ${cleared}`);
      next[key] = cleared;
      return next;
    case 'why':
    case 'mailAccount':
      next[key] = cleared;
      return next;
  }
  throw new JobsError(`unknown profile key "${key}". Keys: ${PROFILE_KEYS.join(', ')}, filters.<key>`);
}

/** The résumé and cover must exist before a profile is stored with them. */
export function checkDocuments(profile: Profile, fileExists: (path: string) => boolean = existsSync): void {
  for (const key of ['resume', 'cover'] as const) {
    const path = profile[key];
    if (path && !fileExists(expandHome(path))) throw new JobsError(`${key}: no file at ${path}`);
  }
}

/** Fill the "why us" template for one job. */
export function renderWhy(template: string | null, job: { company: string; focus?: string | null }): string {
  if (!template) return '';
  return template.replaceAll('{company}', job.company).replaceAll('{focus}', job.focus ?? '').trim();
}
