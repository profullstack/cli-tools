/**
 * The parts of `statements` that drive a real Chrome over the DevTools
 * protocol: sign-in windows, the fetch loop and assisted downloads. Everything
 * that can be decided without a browser lives in statements.ts and is tested
 * there.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  CLICK_RECORDER,
  COLLECT,
  type Downloaded,
  type FileResult,
  type Institution,
  type Manifest,
  OPEN_STATEMENTS,
  SECOND_STEP,
  SIGNED_OUT,
  StatementsError,
  candidateKey,
  clickScript,
  fileStatement,
  isSignInUrl,
  periodOf,
  preferPdfDownloads,
} from './statements.ts';
import { type Browser, type Cdp, launchBrowser } from './wcag.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface Candidate {
  index: number;
  label: string;
  context: string;
  href: string | null;
}

export async function openBrowser(options: { chrome: string; profile: string; headless: boolean; timeoutMs?: number }): Promise<Browser> {
  mkdirSync(options.profile, { recursive: true, mode: 0o700 });
  preferPdfDownloads(options.profile);
  try {
    return await launchBrowser({ chrome: options.chrome, profile: options.profile, headless: options.headless, timeoutMs: options.timeoutMs ?? 30_000 });
  } catch (error) {
    const message = (error as Error).message;
    if (/SingletonLock|ProcessSingleton|profile.*in use/i.test(message)) {
      throw new StatementsError(`the ${options.profile} profile is open in another Chrome; close that window first`);
    }
    throw error;
  }
}

/** Attach to the tab Chrome opened with, or a new one. */
async function attachPage(cdp: Cdp): Promise<{ sessionId: string; targetId: string }> {
  const { targetInfos } = (await cdp.send('Target.getTargets')) as { targetInfos: { targetId: string; type: string }[] };
  let targetId = targetInfos.find((target) => target.type === 'page')?.targetId;
  if (!targetId) ({ targetId } = (await cdp.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string });
  const { sessionId } = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string };
  await cdp.send('Page.enable', {}, sessionId);
  return { sessionId, targetId };
}

/** Headless Chrome says so in its user agent, and banks turn that away. */
async function hideHeadless(cdp: Cdp, sessionId: string): Promise<void> {
  const { userAgent } = (await cdp.send('Browser.getVersion')) as { userAgent: string };
  if (userAgent.includes('Headless')) {
    await cdp.send('Network.setUserAgentOverride', { userAgent: userAgent.replace('HeadlessChrome', 'Chrome') }, sessionId);
  }
}

async function evaluate<T>(cdp: Cdp, sessionId: string, expression: string): Promise<T | null> {
  try {
    const { result, exceptionDetails } = (await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId)) as {
      result: { value?: unknown };
      exceptionDetails?: unknown;
    };
    return exceptionDetails ? null : ((result.value ?? null) as T | null);
  } catch {
    // The page navigated away mid-evaluation; the caller polls again.
    return null;
  }
}

async function navigate(cdp: Cdp, sessionId: string, url: string, timeoutMs: number): Promise<void> {
  const loaded = cdp.waitFor('Page.loadEventFired', sessionId, timeoutMs).catch(() => undefined);
  const result = (await cdp.send('Page.navigate', { url }, sessionId)) as { errorText?: string };
  if (result.errorText && result.errorText !== 'net::ERR_ABORTED') throw new StatementsError(`could not open ${url}: ${result.errorText}`);
  // A hash route (Chase's dashboard) never fires a load event; the poll after this is what waits.
  await Promise.race([loaded, sleep(Math.min(timeoutMs, 15_000))]);
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

interface DownloadEvent {
  guid: string;
  suggestedName: string;
  state: 'begun' | 'completed' | 'canceled';
}

/** Browser-wide download events, saved under `dir/<guid>` by allowAndName. */
class Downloads {
  private readonly begun: DownloadEvent[] = [];
  private readonly finished = new Map<string, 'completed' | 'canceled'>();
  private readonly waiters = new Set<() => void>();
  private readonly stop: () => void;
  readonly dir: string;

  constructor(cdp: Cdp, dir: string) {
    this.dir = dir;
    this.stop = cdp.on(({ method, params }) => {
      if (method === 'Browser.downloadWillBegin') {
        this.begun.push({ guid: String(params.guid), suggestedName: String(params.suggestedFilename ?? 'statement.pdf'), state: 'begun' });
      } else if (method === 'Browser.downloadProgress' && (params.state === 'completed' || params.state === 'canceled')) {
        this.finished.set(String(params.guid), params.state);
      } else {
        return;
      }
      for (const wake of this.waiters) wake();
    });
  }

  static async start(cdp: Cdp, dir: string): Promise<Downloads> {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const downloads = new Downloads(cdp, dir);
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: dir, eventsEnabled: true });
    return downloads;
  }

  get count(): number {
    return this.begun.length;
  }

  private async until<T>(check: () => T | null, timeoutMs: number): Promise<T | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = check();
      if (value !== null) return value;
      const left = deadline - Date.now();
      if (left <= 0) return null;
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          this.waiters.delete(wake);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(wake, left);
        this.waiters.add(wake);
      });
    }
  }

  /** The first download to begin after `after` earlier ones, or null. */
  next(after: number, timeoutMs: number): Promise<DownloadEvent | null> {
    return this.until(() => this.begun[after] ?? null, timeoutMs);
  }

  /** The finished file's bytes, or null if it was cancelled or never finished. */
  async bytes(event: DownloadEvent, timeoutMs = 120_000): Promise<Uint8Array | null> {
    const state = await this.until(() => this.finished.get(event.guid) ?? null, timeoutMs);
    if (state !== 'completed') return null;
    const path = join(this.dir, event.guid);
    const bytes = readFileSync(path);
    rmSync(path, { force: true });
    return bytes;
  }

  close(): void {
    this.stop();
  }
}

/** Close every tab but ours: a statement opened in a new tab leaves one behind per click. */
async function closeStrays(cdp: Cdp, keep: string): Promise<void> {
  const { targetInfos } = (await cdp.send('Target.getTargets')) as { targetInfos: { targetId: string; type: string }[] };
  for (const target of targetInfos) {
    if (target.type === 'page' && target.targetId !== keep) await cdp.send('Target.closeTarget', { targetId: target.targetId }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

export interface FetchOptions {
  start: string;
  outDir: string;
  manifest: Manifest;
  /** YYYY-MM: skip statements that closed before this month. */
  since: string | null;
  max: number;
  /** How long to give a statements page to render its list. */
  renderMs: number;
  log: (line: string) => void;
}

export interface FetchResult {
  status: 'ok' | 'login-needed' | 'no-statements';
  /** Where the page ended up, for the message. */
  url: string;
  candidates: number;
  results: FileResult[];
  /** Candidates that were clicked and never produced a download. */
  silent: string[];
}

async function currentUrl(cdp: Cdp, sessionId: string): Promise<string> {
  return (await evaluate<string>(cdp, sessionId, 'location.href')) ?? '';
}

/** Wait for the page to show statements, follow its Statements link once, or notice it wants a password. */
async function findCandidates(cdp: Cdp, sessionId: string, renderMs: number): Promise<{ signedOut: boolean; candidates: Candidate[] }> {
  const deadline = Date.now() + renderMs;
  let followed = false;
  for (;;) {
    if (await evaluate<boolean>(cdp, sessionId, SIGNED_OUT)) return { signedOut: true, candidates: [] };
    const raw = await evaluate<string>(cdp, sessionId, COLLECT);
    const candidates = raw ? (JSON.parse(raw) as Candidate[]) : [];
    if (candidates.length) return { signedOut: false, candidates };
    if (!followed && Date.now() > deadline - renderMs / 2) {
      followed = (await evaluate<string>(cdp, sessionId, OPEN_STATEMENTS)) !== null;
    }
    if (Date.now() > deadline) return { signedOut: false, candidates: [] };
    await sleep(1500);
  }
}

export async function fetchInstitution(browser: Browser, institution: Institution, options: FetchOptions): Promise<FetchResult> {
  const { cdp } = browser;
  const { sessionId, targetId } = await attachPage(cdp);
  await hideHeadless(cdp, sessionId);
  const staging = mkdtempSync(join(options.outDir, '.incoming-'));
  const downloads = await Downloads.start(cdp, staging);
  const seen = new Set(options.manifest.entries.filter((entry) => entry.institution === institution.key && entry.key).map((entry) => entry.key!));

  try {
    await navigate(cdp, sessionId, options.start, 45_000);
    let found = await findCandidates(cdp, sessionId, options.renderMs);
    const url = await currentUrl(cdp, sessionId);
    if (found.signedOut) return { status: 'login-needed', url, candidates: 0, results: [], silent: [] };
    if (!found.candidates.length) return { status: 'no-statements', url, candidates: 0, results: [], silent: [] };

    const todo = found.candidates
      .map((candidate) => ({ candidate, key: candidateKey(candidate), period: periodOf(candidate.context, candidate.label) }))
      .filter(({ key }) => !seen.has(key))
      .filter(({ period }) => !options.since || !period || period.month >= options.since)
      // Same row offered twice (an icon and a text link): one click is enough.
      .filter((item, index, all) => all.findIndex((other) => other.key === item.key) === index)
      .slice(0, options.max);

    const results: FileResult[] = [];
    const silent: string[] = [];
    for (const { candidate, key } of todo) {
      const label = `${candidate.label} — ${candidate.context}`.slice(0, 160);
      let clicked = await evaluate<boolean>(cdp, sessionId, clickScript(candidate.index));
      if (!clicked) {
        // The last click navigated the tab; come back and find the same row again.
        await navigate(cdp, sessionId, options.start, 45_000);
        found = await findCandidates(cdp, sessionId, options.renderMs);
        const again = found.candidates.find((other) => candidateKey(other) === key);
        clicked = again ? await evaluate<boolean>(cdp, sessionId, clickScript(again.index)) : false;
      }
      if (!clicked) {
        silent.push(label);
        continue;
      }

      const before = downloads.count;
      let event = await downloads.next(before, 8000);
      if (!event && (await evaluate<string>(cdp, sessionId, SECOND_STEP))) event = await downloads.next(before, 12_000);
      if (!event) {
        silent.push(label);
        await closeStrays(cdp, targetId);
        continue;
      }
      const bytes = await downloads.bytes(event);
      await closeStrays(cdp, targetId);
      if (!bytes) {
        silent.push(label);
        continue;
      }
      const download: Downloaded = { bytes, suggestedName: event.suggestedName, label: candidate.label, context: candidate.context, key };
      const result = fileStatement(options.outDir, options.manifest, institution, download, 'fetch');
      if (result.status === 'duplicate' && !result.entry.key) result.entry.key = key;
      results.push(result);
      options.log(describe(result));
      // A bank that sees forty clicks a second ends the session.
      await sleep(1200);
    }
    return { status: 'ok', url, candidates: found.candidates.length, results, silent };
  } finally {
    downloads.close();
    rmSync(staging, { recursive: true, force: true });
  }
}

export function describe(result: FileResult): string {
  if (result.status === 'not-pdf') return `  skipped ${result.suggestedName}: not a PDF`;
  const where = result.entry.path;
  return result.status === 'filed' ? `  + ${where}${result.entry.accountId ? '' : '  (account not recognised)'}` : `  = ${where} (already have it)`;
}

// ---------------------------------------------------------------------------
// login and assist: a window a person uses
// ---------------------------------------------------------------------------

/** Follow the URL of every tab until the window closes; the last real page wins. */
function trackUrls(cdp: Cdp): { last: () => string | null; stop: () => void } {
  let last: string | null = null;
  const stop = cdp.on(({ method, params }) => {
    if (method !== 'Target.targetInfoChanged' && method !== 'Target.targetCreated') return;
    const info = params.targetInfo as { type?: string; url?: string } | undefined;
    if (info?.type === 'page' && info.url && /^https:/.test(info.url)) last = info.url;
  });
  return { last: () => last, stop };
}

/** Open the bank's sign-in page in a window and wait for the person to close it. Returns the last page they were on. */
export async function loginWindow(browser: Browser, url: string): Promise<string | null> {
  const { cdp } = browser;
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  const urls = trackUrls(cdp);
  const { sessionId } = await attachPage(cdp);
  await navigate(cdp, sessionId, url, 45_000).catch(() => undefined);
  await browser.exited;
  urls.stop();
  const last = urls.last();
  return last && !isSignInUrl(last) ? last : null;
}

/** A window on the statements page; every PDF the person downloads is filed until they close it. */
export async function assistWindow(
  browser: Browser,
  institution: Institution,
  options: { start: string; outDir: string; manifest: Manifest; log: (line: string) => void; save: () => void },
): Promise<FileResult[]> {
  const { cdp } = browser;
  const { sessionId } = await attachPage(cdp);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: CLICK_RECORDER }, sessionId);
  const staging = mkdtempSync(join(options.outDir, '.incoming-'));
  const downloads = await Downloads.start(cdp, staging);
  const results: FileResult[] = [];
  let handled = 0;
  let open = true;
  void browser.exited.then(() => {
    open = false;
  });

  try {
    await navigate(cdp, sessionId, options.start, 45_000).catch(() => undefined);
    await evaluate(cdp, sessionId, CLICK_RECORDER);
    while (open) {
      const event = await downloads.next(handled, 1000);
      if (!event) continue;
      handled += 1;
      const clickedRaw = await evaluate<string>(cdp, sessionId, 'window.__statementsLastClick || null');
      const clicked = clickedRaw ? (JSON.parse(clickedRaw) as { label: string; context: string }) : { label: '', context: '' };
      const bytes = await downloads.bytes(event);
      if (!bytes) continue;
      const result = fileStatement(options.outDir, options.manifest, institution, { bytes, suggestedName: event.suggestedName, label: clicked.label, context: clicked.context, key: null }, 'assist');
      results.push(result);
      options.log(describe(result));
      options.save();
    }
    return results;
  } finally {
    downloads.close();
    rmSync(staging, { recursive: true, force: true });
  }
}
