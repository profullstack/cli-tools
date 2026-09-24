import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, type WriteStream } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { createInterface } from 'node:readline';

import { type Profile, type Settings, expandHome, renderWhy } from './jobs-config.ts';
import type { ApplyHooks, Outcome, RunJob } from './jobs-run.ts';
import { codePath, logPath } from './jobs-state.ts';
import { type MailConfig, loadConfig as loadMailConfig, openMailbox, resolveAccount } from './mail.ts';

/**
 * Fill, and optionally submit, one application form by driving TronBrowser's
 * `tron automate` MCP server over stdio.
 *
 * Fields are matched by label. The applicant's own rules come first, then the
 * built-ins; a required field neither answers stops the run with the label
 * named, so the fix is one `jobhunt profile answer` away. Three things always
 * stop it without submitting: a required question with no answer, a résumé the
 * page does not show as attached, and a required consent or arbitration box —
 * agreeing to those is the applicant's call, never the tool's.
 *
 * Greenhouse emails a security code before it accepts an application. The code
 * is read from the applicant's mailbox when a `mail` account for their address
 * is configured, and from a file otherwise; whichever arrives first is used.
 */

// ---------------------------------------------------------------------------
// The page, as the snapshot describes it
// ---------------------------------------------------------------------------

export interface Element {
  ref: string;
  role: string;
  name: string;
  required: boolean;
  value: string;
}

const SNAPSHOT_LINE = /^(@e\d+) (\S+) "((?:[^"\\]|\\.)*)"( \[required\])?(?: = "((?:[^"\\]|\\.)*)")?/;

const unquote = (text: string): string => {
  try {
    return JSON.parse(`"${text}"`) as string;
  } catch {
    return text;
  }
};

export function parseSnapshot(snapshot: string): Element[] {
  return snapshot.split('\n').flatMap((line) => {
    const match = SNAPSHOT_LINE.exec(line);
    if (!match) return [];
    return [{
      ref: match[1]!,
      role: match[2]!,
      name: unquote(match[3]!),
      required: Boolean(match[4]),
      value: match[5] ? unquote(match[5]) : '',
    }];
  });
}

// ---------------------------------------------------------------------------
// Rules: label → answer
// ---------------------------------------------------------------------------

export interface Rule {
  match: RegExp;
  kind: 'fill' | 'select' | 'upload';
  value: string | null;
}

/**
 * The label rules for one profile and one job. First match wins, so the
 * specific ("preferred name") precede the general ("name"), and the applicant's
 * own rules precede all of them.
 */
export function rulesFor(profile: Profile, why: string): Rule[] {
  const a = profile.applicant;
  const q = profile.answers;
  const full = [a.firstName, a.lastName].filter(Boolean).join(' ') || null;
  const doc = (path: string | null) => (path ? expandHome(path) : null);
  const custom: Rule[] = profile.rules.map((rule) => ({ match: new RegExp(rule.match, 'i'), kind: rule.kind, value: rule.value }));
  return [
    ...custom,
    { match: /preferred (first )?name/i, kind: 'fill', value: a.preferredName ?? a.firstName },
    { match: /first name/i, kind: 'fill', value: a.firstName },
    { match: /last name/i, kind: 'fill', value: a.lastName },
    { match: /^full name|^name\*?$|^name\b/i, kind: 'fill', value: full },
    { match: /e-?mail/i, kind: 'fill', value: a.email },
    { match: /phone/i, kind: 'fill', value: a.phone },
    { match: /linkedin/i, kind: 'fill', value: a.linkedin },
    { match: /github/i, kind: 'fill', value: a.github },
    { match: /website|portfolio|personal site/i, kind: 'fill', value: a.website },
    { match: /cover letter/i, kind: 'upload', value: doc(profile.cover) },
    { match: /resume|cv\b|^attach$/i, kind: 'upload', value: doc(profile.resume) },
    { match: /^country/i, kind: 'select', value: q.country },
    { match: /legally authorized|authorized to work|eligible to work/i, kind: 'select', value: q.workAuthorized },
    { match: /sponsorship|visa/i, kind: 'select', value: q.sponsorship },
    { match: /bay area|pst time zone|pacific time/i, kind: 'select', value: q.bayArea },
    { match: /previously applied|been involved in a recruitment|interviewed (with|at)/i, kind: 'select', value: q.previouslyApplied },
    { match: /large language models|llm/i, kind: 'select', value: q.llmExperience },
    { match: /large scale backend/i, kind: 'select', value: q.largeScaleBackend },
    { match: /client facing|customer handling|customer-facing/i, kind: 'select', value: q.clientFacing },
    { match: /how did you hear/i, kind: 'select', value: q.heardFrom },
    { match: /current location|where are you currently located|city and country/i, kind: 'fill', value: a.location },
    // Location fields are autocompletes that search on the city.
    { match: /^location\b/i, kind: 'select', value: a.city },
    { match: /^why\b|why .*(interested|excited|join|apply)|why (do you want|are you)|what (excites|interests) you/i, kind: 'fill', value: why || null },
  ];
}

/** Boxes the applicant must tick themselves. A required one stops the run. */
export const CONSENT = /agree|consent|acknowledge|certify|arbitrat|attest/i;

export interface Action {
  ref: string;
  label: string;
  kind: 'fill' | 'select' | 'upload' | 'click';
  value: string;
}

export interface Plan {
  actions: Action[];
  /** Required fields nothing answers: the reasons a human is needed. */
  unknown: string[];
}

/**
 * What to do to each field on the page. Pure, so the matching can be tested
 * without a browser; the caller performs the actions.
 */
export function planForm(elements: Element[], rules: Rule[], heardFrom: string | null): Plan {
  const actions: Action[] = [];
  const unknown: string[] = [];
  const done = new Set<string>();
  const needed = (el: Element, label: string) => el.required || /\*/.test(label);

  for (const el of elements) {
    if (!['textbox', 'combobox', 'file', 'checkbox'].includes(el.role)) continue;
    const label = el.name.replace(/\s+/g, ' ').trim();

    if (el.role === 'checkbox') {
      if (CONSENT.test(label)) {
        if (el.required) unknown.push(label);
        continue;
      }
      // Option boxes of a multi-select "How did you hear…": tick ours, leave the rest.
      if (heardFrom && label.toLowerCase().includes(heardFrom.toLowerCase()) && el.value !== 'checked') {
        actions.push({ ref: el.ref, label, kind: 'click', value: '' });
      }
      continue;
    }

    // "Please type your answer if you selected Other…" — some employers make it required for everyone.
    if (/^please (type|specify|explain).{0,40}if (you )?(selected|answered|chose)/i.test(label)) {
      if (!el.value && heardFrom) actions.push({ ref: el.ref, label, kind: 'fill', value: heardFrom });
      else if (!el.value && needed(el, label)) unknown.push(label);
      continue;
    }

    const rule = rules.find((candidate) => candidate.match.test(label) && (el.role === 'file') === (candidate.kind === 'upload'));
    if (!rule) {
      if (needed(el, label)) unknown.push(label || `(unlabeled ${el.role})`);
      continue;
    }
    if (!rule.value) {
      if (needed(el, label)) unknown.push(`${label} (no answer)`);
      continue;
    }
    const key = `${rule.kind}:${label}`;
    if (done.has(key)) continue;
    done.add(key);
    if (rule.kind === 'fill' && el.value) continue;
    actions.push({ ref: el.ref, label, kind: rule.kind, value: rule.value });
  }
  return { actions, unknown };
}

export const SUBMIT_BUTTON = /submit( application)?$/i;
export const SUCCESS = /thank you for applying|application (has been |was )?(successfully )?(received|submitted)|successfully submitted|thanks for (your )?(applying|application|submitting)|we.ve received your application/i;
export const FORM_ERRORS = /(missing entry for required field[^"\\]{0,80}|this field is required[^"\\]{0,40}|please complete[^"\\]{0,60}|[^"\\]{0,60}spam[^"\\]{0,60}|needs corrections[^"\\]{0,80})/gi;

// ---------------------------------------------------------------------------
// Tron over stdio
// ---------------------------------------------------------------------------

/**
 * How to start `tron automate`. An installed TronBrowser ships its runtime as
 * `<launcher>/sdk/automate-bin.js`, whose `@tronbrowser/*` imports resolve only
 * through `<launcher>/tron-node.mjs`; run bare, it dies with
 * ERR_MODULE_NOT_FOUND before speaking MCP. That is how `tron automate` itself
 * starts it, Obscura path included. A source checkout's dist/ build resolves
 * its own imports, so it runs directly.
 */
export function tronAutomateCommand(
  automateBin: string,
  chromiumBin: string | null,
  exists: (path: string) => boolean = existsSync,
): { args: string[]; env: Record<string, string> } {
  const tail = [automateBin, ...(chromiumBin ? ['--chromium-bin', chromiumBin] : [])];
  const launcher = dirname(dirname(automateBin));
  const loader = join(launcher, 'tron-node.mjs');
  if (!exists(loader)) return { args: tail, env: {} };
  const obscura = join(launcher, 'obscura-bin', 'obscura');
  return { args: [loader, ...tail], env: exists(obscura) ? { TRON_OBSCURA_BIN: obscura } : {} };
}

export class TronSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private nextId = 1;
  private exited = false;

  constructor(automateBin: string, chromiumBin: string | null, log: WriteStream) {
    const { args, env } = tronAutomateCommand(automateBin, chromiumBin);
    // Its own process group, so close() can take the browser down with it.
    this.child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true, env: { ...process.env, ...env } });
    this.child.stderr.pipe(log, { end: false });
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      const waiter = this.pending.get(message.id as number);
      if (waiter) {
        this.pending.delete(message.id as number);
        waiter.resolve(message);
      }
    });
    this.child.on('exit', (code) => {
      this.exited = true;
      for (const waiter of this.pending.values()) waiter.reject(new Error(`tron automate exited (${code ?? 'signal'})`));
      this.pending.clear();
    });
  }

  private rpc(method: string, params: { name?: string } & Record<string, unknown>, timeoutMs = 90_000): Promise<Record<string, unknown>> {
    if (this.exited) return Promise.reject(new Error('tron automate is not running'));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${params.name ?? method}: no answer from tron in ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async initialize(): Promise<void> {
    await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'jobhunt', version: '1' } });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const response = await this.rpc('tools/call', { name, arguments: args });
    const result = (response.result ?? {}) as { content?: { type: string; text?: string }[]; isError?: boolean };
    const text = (result.content ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
    const error = response.error as { message?: string } | undefined;
    if (error || result.isError) throw new Error(`${name}: ${error?.message ?? text}`);
    return text;
  }

  /** The process group tron and its browser run in, so a crashed run can still be cleaned up. */
  get group(): number | null {
    return this.child.pid ?? null;
  }

  async close(): Promise<void> {
    try {
      if (!this.exited) await this.rpc('tools/call', { name: 'browser_close', arguments: {} }, 5_000);
    } catch {
      // Closing is best effort; the group kill below is what counts.
    }
    const group = this.group;
    if (group === null) return;
    killGroup(group, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    killGroup(group, 'SIGKILL');
  }
}

/**
 * Signal a whole process group. tron does not take its Chromium down with it
 * when it is killed, so killing tron alone leaves a headless browser running
 * for every stopped or timed-out job; the browser inherits tron's group, so
 * the group is what gets the signal.
 */
export function killGroup(group: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-group, signal);
  } catch {
    // Already gone.
  }
}

// ---------------------------------------------------------------------------
// Security codes
// ---------------------------------------------------------------------------

/** The code in a Greenhouse "Security code for your application" email. */
export function extractCode(text: string): string | null {
  const labelled = /code (?:field )?on your application:\s*([A-Za-z0-9]{4,12})\b/i.exec(text);
  if (labelled) return labelled[1]!;
  const alone = /^\s*([A-Z0-9]{6,12})\s*$/m.exec(text);
  return alone ? alone[1]! : null;
}

/** Does "Security code for your application to <X>" name this company? */
export function subjectMatchesCompany(subject: string, company: string): boolean {
  const named = /application to (.+?)\s*$/i.exec(subject)?.[1];
  if (!named) return false;
  const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = norm(named);
  return company.split(/[/|,]/).map(norm).filter(Boolean).some((part) => target.includes(part) || part.includes(target));
}

export type CodeSource = (company: string, since: Date) => Promise<string | null>;

/** A code written to a file by whoever is watching the run. */
export function fileCodeSource(file: string): CodeSource {
  return async () => {
    try {
      const code = readFileSync(file, 'utf8').trim();
      return code || null;
    } catch {
      return null;
    }
  };
}

/**
 * The `mail` account that receives the applicant's codes: the one the profile
 * names, else the one whose address is the applicant's. Null (with why) when
 * there is none or it has no password, so the file is the only source.
 */
export function mailAccountFor(
  profile: Profile,
  config: MailConfig,
  env: NodeJS.ProcessEnv = process.env,
): { name: string } | { none: string } {
  const email = profile.applicant.email?.toLowerCase();
  const name = profile.mailAccount ??
    Object.keys(config.accounts).find((candidate) => email && config.accounts[candidate]!.email === email);
  if (!name) return { none: email ? `no \`mail\` account for ${email}` : 'the profile has no email' };
  const entry = config.accounts[name];
  if (!entry) return { none: `no \`mail\` account "${name}"` };
  try {
    const account = resolveAccount(name, entry, env);
    if (!account.password) return { none: `\`mail\` account "${name}" has no password` };
  } catch (error) {
    return { none: (error as Error).message };
  }
  return { name };
}

/**
 * Codes from the inbox. Searches by sender and day only and matches the
 * subject here: Forward Email's IMAP answers a multi-word SUBJECT search with
 * nothing, even for a subject that is in the mailbox verbatim.
 */
export function mailCodeSource(accountName: string, env: NodeJS.ProcessEnv = process.env): CodeSource {
  return async (company, since) => {
    const config = loadMailConfig(env);
    const account = resolveAccount(accountName, config.accounts[accountName]!, env);
    const box = await openMailbox(account);
    try {
      const day = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate()));
      const hits = await box.search('INBOX', { from: 'greenhouse-mail.io', since: day }, 20);
      for (const hit of hits) {
        if (!/security code/i.test(hit.subject) || !subjectMatchesCompany(hit.subject, company)) continue;
        if (hit.date && new Date(hit.date).getTime() < since.getTime() - 60_000) continue;
        const message = await box.read('INBOX', hit.uid);
        const code = extractCode(message.text);
        if (code) return code;
      }
      return null;
    } finally {
      await box.close().catch(() => undefined);
    }
  };
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });

/** Poll every source until one yields a code, the time runs out, or the run is stopped. */
export async function waitForCode(
  sources: { name: 'mail' | 'file'; source: CodeSource; everyMs: number }[],
  company: string,
  since: Date,
  signal: AbortSignal,
  { timeoutMs = 300_000, log = (_line: string) => {} } = {},
): Promise<{ code: string; source: 'mail' | 'file' } | null> {
  const due = new Map(sources.map((entry) => [entry.name, 0]));
  const started = Date.now();
  while (Date.now() - started < timeoutMs && !signal.aborted) {
    for (const entry of sources) {
      if (Date.now() < due.get(entry.name)!) continue;
      due.set(entry.name, Date.now() + entry.everyMs);
      try {
        const code = await entry.source(company, since);
        if (code) return { code, source: entry.name };
      } catch (error) {
        log(`code from ${entry.name}: ${(error as Error).message}`);
      }
    }
    await sleep(1500, signal);
  }
  return null;
}

// ---------------------------------------------------------------------------
// One application
// ---------------------------------------------------------------------------

export interface ApplyOptions {
  settings: Settings;
  dryRun: boolean;
  /** Off with --no-mail; otherwise used when an account for the applicant exists. */
  mailAccount: string | null;
  env?: NodeJS.ProcessEnv;
}

/** Check what an apply needs before a browser is started for nothing. */
export function preflight(settings: Settings): string[] {
  const problems: string[] = [];
  const { profile } = settings;
  if (!existsSync(settings.automateBin)) {
    problems.push(`no tron automate at ${settings.automateBin} — install TronBrowser or set TRON_AUTOMATE_BIN / tron.automateBin`);
  }
  if (settings.chromiumBin && !existsSync(settings.chromiumBin)) problems.push(`no browser at ${settings.chromiumBin} (TRON_CHROMIUM_BIN)`);
  if (!profile.resume) problems.push(`profile "${settings.profileName}" has no resume — \`jobhunt profile set ${settings.profileName} resume=<path>\``);
  else if (!existsSync(expandHome(profile.resume))) problems.push(`resume not found: ${profile.resume}`);
  if (profile.cover && !existsSync(expandHome(profile.cover))) problems.push(`cover letter not found: ${profile.cover}`);
  if (!profile.applicant.firstName || !profile.applicant.lastName || !profile.applicant.email) {
    problems.push(`profile "${settings.profileName}" needs firstName, lastName and email`);
  }
  return problems;
}

export function makeApplyJob(options: ApplyOptions): (job: RunJob, hooks: ApplyHooks) => Promise<Outcome> {
  return async (job, hooks) => {
    const { settings } = options;
    const file = logPath(settings.profileDir, job.key);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const log = createWriteStream(file, { flags: 'a', mode: 0o600 });
    const note = (line: string) => log.write(`[jobhunt] ${line}\n`);
    note(`${new Date().toISOString()} ${job.company} — ${job.title} ${options.dryRun ? '(dry run)' : ''}`);
    const tron = new TronSession(settings.automateBin, settings.chromiumBin, log);
    hooks.onBrowser?.(tron.group);
    try {
      await tron.initialize();
      return await fillAndSubmit(tron, job, hooks, options, note);
    } finally {
      await tron.close();
      hooks.onBrowser?.(null);
      log.end();
    }
  };
}

async function fillAndSubmit(
  tron: TronSession,
  job: RunJob,
  hooks: ApplyHooks,
  options: ApplyOptions,
  note: (line: string) => void,
): Promise<Outcome> {
  const { settings } = options;
  const { profile } = settings;
  const stopped = (): Outcome => ({ status: 'abandoned', reason: 'stopped before submitting' });

  await tron.call('browser_open', { url: job.applyUrl || job.url });
  await tron.call('browser_wait', { ms: 2500 });
  let elements = parseSnapshot(await tron.call('browser_snapshot'));
  // Ashby job pages keep the form behind an "Application" tab.
  const tab = elements.find((el) => /^application$/i.test(el.name) && /tab|link|button/.test(el.role));
  if (tab && !elements.some((el) => /first name|^name/i.test(el.name))) {
    await tron.call('browser_click', { ref: tab.ref });
    await tron.call('browser_wait', { ms: 1500 });
    elements = parseSnapshot(await tron.call('browser_snapshot'));
  }
  if (!elements.some((el) => el.role === 'textbox' || el.role === 'file')) {
    return { status: 'needs-human-review', unknown: ['no form on the page (posting closed or page not found?)'] };
  }

  const why = renderWhy(profile.why, job);
  const plan = planForm(elements, rulesFor(profile, why), profile.answers.heardFrom);
  const unknown = [...plan.unknown];
  for (const action of plan.actions) {
    if (hooks.signal.aborted) return stopped();
    try {
      if (action.kind === 'fill') await tron.call('browser_fill', { ref: action.ref, value: action.value });
      else if (action.kind === 'upload') await tron.call('browser_upload', { ref: action.ref, paths: [action.value] });
      else if (action.kind === 'click') await tron.call('browser_click', { ref: action.ref });
      else note(`${action.label} -> ${(await tron.call('browser_select', { ref: action.ref, value: action.value })).split('\n')[0]}`);
    } catch (error) {
      unknown.push(`${action.label} (${(error as Error).message.slice(0, 160)})`);
    }
  }

  elements = parseSnapshot(await tron.call('browser_snapshot'));
  note(`fields:\n  ${elements.filter((el) => ['textbox', 'combobox', 'file'].includes(el.role))
    .map((el) => `${el.role} ${el.name.slice(0, 60)} = ${el.value.slice(0, 40)}`).join('\n  ')}`);
  const pageText = JSON.stringify(await tron.call('browser_extract', { mode: 'text' }));
  if (profile.resume) {
    const resumeName = basename(profile.resume, extname(profile.resume));
    if (!pageText.includes(resumeName)) unknown.push('resume not shown as attached');
  }
  if (unknown.length) return { status: 'needs-human-review', unknown };
  if (options.dryRun) return { status: 'prepared' };
  if (hooks.signal.aborted) return stopped();

  const button = elements.find((el) => el.role === 'button' && SUBMIT_BUTTON.test(el.name.trim()));
  if (!button) return { status: 'needs-human-review', unknown: ['submit button not found'] };
  const submittedAt = new Date();
  hooks.onState('submitting');
  await tron.call('browser_click', { ref: button.ref });

  let codeDone = false;
  for (let i = 0; i < 12; i += 1) {
    await tron.call('browser_wait', { ms: 1500 });
    const text = JSON.stringify(await tron.call('browser_extract', { mode: 'text' }));
    if (!codeDone && /security code/i.test(text)) {
      const box = parseSnapshot(await tron.call('browser_snapshot')).find((el) => el.role === 'textbox' && /code/i.test(el.name) && !el.value);
      if (box) {
        const codeFile = codePath(settings.profileDir, job.key);
        mkdirSync(dirname(codeFile), { recursive: true, mode: 0o700 });
        rmSync(codeFile, { force: true });
        hooks.onState('awaiting-code', { codeFile });
        const sources: Parameters<typeof waitForCode>[0] = [{ name: 'file', source: fileCodeSource(codeFile), everyMs: 1500 }];
        if (options.mailAccount) sources.unshift({ name: 'mail', source: mailCodeSource(options.mailAccount, options.env), everyMs: 15_000 });
        const got = await waitForCode(sources, job.company, submittedAt, hooks.signal, { log: note });
        // Without the code nothing was submitted, so a stop here abandons cleanly.
        if (hooks.signal.aborted) return { status: 'abandoned', reason: 'stopped while waiting for the security code' };
        if (!got) return { status: 'needs-human-review', unknown: ['security code not provided'] };
        note(`security code from ${got.source}`);
        await tron.call('browser_fill', { ref: box.ref, value: got.code });
        const again = parseSnapshot(await tron.call('browser_snapshot')).find((el) => el.role === 'button' && SUBMIT_BUTTON.test(el.name.trim()));
        hooks.onState('submitting', { codeSource: got.source });
        if (again) await tron.call('browser_click', { ref: again.ref });
        codeDone = true;
        i = 0;
        continue;
      }
    }
    if (SUCCESS.test(text)) return { status: 'submitted' };
    const errors = text.match(FORM_ERRORS);
    if (errors && i >= 2) return { status: 'needs-human-review', unknown: errors.slice(0, 5) };
  }
  const tail = JSON.stringify(await tron.call('browser_extract', { mode: 'text' })).slice(-600);
  note(`no confirmation seen; page tail: ${tail}`);
  return { status: 'unverified', reason: 'submit clicked, no error and no thank-you seen' };
}
