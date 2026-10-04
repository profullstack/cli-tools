/**
 * The part of `ftb` that drives Chrome over the DevTools protocol: one loop
 * that reads a MyFTB page, fills it from the rules in ftb.ts, and presses its
 * Continue/Submit, until FTB says the account exists, is active, or no.
 *
 * Headless works against MyFTB's bot screen once the user agent stops saying
 * HeadlessChrome (the same trick src/statements-run.ts uses on banks).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

import { type Action, CODE_LABEL, type Field, FtbError, type Outcome, type Plan, type Rule, decide, outcomeOf } from './ftb.ts';
import { promptLine, promptSecret } from './prompt.ts';
import { type Browser, type Cdp, launchBrowser } from './wcag.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface Page {
  url: string;
  title: string;
  text: string;
  errors: string[];
  fields: Field[];
}

/** Every visible, enabled control, with the label a person would read for it. */
const READ_PAGE = `(() => {
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';
  const clean = (s) => (s || '').replace(/\\*\\s*Required Field/gi, '').replace(/\\s+/g, ' ').trim();
  const labelOf = (el) => {
    const byFor = el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    const wrap = el.closest('label');
    const group = el.closest('.form-group, fieldset, .row');
    const legend = group && group.querySelector('legend, .col-form-label');
    return clean((byFor && byFor.innerText) || el.getAttribute('aria-label') || (wrap && wrap.innerText) || (legend && legend.innerText) || el.placeholder || '');
  };
  const selectorOf = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    if (el.name) return el.tagName.toLowerCase() + '[name="' + el.name + '"]' + (el.type === 'radio' || el.type === 'checkbox' ? '[value="' + el.value + '"]' : '');
    return null;
  };
  const controls = [...document.querySelectorAll('form input, form select, form textarea')]
    .filter((el) => !['hidden', 'submit', 'button', 'image', 'reset'].includes(el.type) && !el.disabled && visible(el) && !el.closest('#timer, .modal'));
  let lastSelect = null;
  const fields = [];
  for (const el of controls) {
    const selector = selectorOf(el);
    if (el.tagName === 'SELECT') lastSelect = el;
    if (!selector) continue;
    const label = labelOf(el);
    const group = el.closest('.form-group, fieldset');
    const printed = group ? clean([...group.querySelectorAll('p, span, div')].map((n) => n.children.length ? '' : n.innerText).join(' ')) : '';
    fields.push({
      selector,
      id: el.id || '',
      name: el.name || '',
      type: el.type,
      label: el.type === 'radio' || el.type === 'checkbox' ? clean((el.closest('label') || document.querySelector('label[for="' + CSS.escape(el.id) + '"]') || {}).innerText || label) : label,
      required: el.required || el.getAttribute('aria-required') === 'true' || /required field/i.test((document.querySelector('label[for="' + CSS.escape(el.id || '-') + '"]') || {}).innerText || ''),
      options: el.tagName === 'SELECT' ? [...el.options].map((o) => ({ value: o.value, text: o.text.trim() })) : undefined,
      question: el.tagName !== 'SELECT' && lastSelect && lastSelect.selectedIndex > 0 ? lastSelect.options[lastSelect.selectedIndex].text.trim() : (printed || undefined),
    });
  }
  const errors = [...document.querySelectorAll('.alert-danger, .validation-summary-errors li, .field-validation-error')]
    .filter(visible).map((n) => clean(n.innerText)).filter(Boolean);
  return { url: location.href, title: document.title, text: clean(document.body.innerText).slice(0, 6000), errors: [...new Set(errors)], fields };
})()`;

function fillScript(selector: string, action: Action): string {
  const target = `document.querySelector(${JSON.stringify(selector)})`;
  if (action.kind === 'check' || action.kind === 'declare') {
    return `(() => { const el = ${target}; if (el && !el.checked) el.click(); return !!el && el.checked; })()`;
  }
  // The native setter, then the events a jQuery/MVC page listens for.
  return `(() => {
    const el = ${target}; if (!el) return false;
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(action.value)});
    for (const type of ['input', 'change', 'blur']) el.dispatchEvent(new Event(type, { bubbles: true }));
    return el.value === ${JSON.stringify(action.value)};
  })()`;
}

/**
 * The page's own forward button, never the session-timeout dialog's "Continue
 * Session" nor Back/Cancel. Known labels first, then the page's only other
 * submit; when neither fits, the labels seen come back as `?a|b` for the error.
 */
const SUBMIT = `(() => {
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const text = (b) => (b.innerText || b.value || '').trim();
  const buttons = [...document.querySelectorAll('form button, form input[type=submit], form input[type=button]')]
    .filter((b) => visible(b) && !b.closest('#timer, .modal') && b.id !== 'continue' && text(b) && !/^(back|cancel|end session|previous)$/i.test(text(b)));
  const pick = buttons.find((b) => /^(submit|continue|next|log ?in|login|activate|send( code| me a code)?|verify|confirm)$/i.test(text(b))) || (buttons.length === 1 ? buttons[0] : null);
  if (!pick) return '?' + buttons.map(text).join('|');
  pick.click();
  return text(pick);
})()`;

export interface Session {
  browser: Browser;
  cdp: Cdp;
  sessionId: string;
}

/**
 * One Chrome profile kept between runs: once the browser has passed FTB's bot
 * check its cookie stays good, so a later login POST is not challenged and
 * resubmitted without its password (which FTB counts as a failed attempt).
 */
export async function openSession(options: { chrome?: string | undefined; headless: boolean; timeoutMs?: number; profile?: string | undefined }): Promise<Session> {
  if (options.profile) mkdirSync(options.profile, { recursive: true, mode: 0o700 });
  const browser = await launchBrowser({
    ...(options.chrome ? { chrome: options.chrome } : {}),
    ...(options.profile ? { profile: options.profile } : {}),
    headless: options.headless,
    timeoutMs: options.timeoutMs ?? 30_000,
  });
  const { cdp } = browser;
  const { targetInfos } = (await cdp.send('Target.getTargets')) as { targetInfos: { targetId: string; type: string }[] };
  let targetId = targetInfos.find((target) => target.type === 'page')?.targetId;
  if (!targetId) ({ targetId } = (await cdp.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string });
  const { sessionId } = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string };
  await cdp.send('Page.enable', {}, sessionId);
  const { userAgent } = (await cdp.send('Browser.getVersion')) as { userAgent: string };
  if (userAgent.includes('Headless')) {
    await cdp.send('Network.setUserAgentOverride', { userAgent: userAgent.replace('HeadlessChrome', 'Chrome') }, sessionId);
  }
  return { browser, cdp, sessionId };
}

async function evaluate<T>(session: Session, expression: string): Promise<T | null> {
  try {
    const { result, exceptionDetails } = (await session.cdp.send('Runtime.evaluate', { expression, returnByValue: true }, session.sessionId)) as {
      result: { value?: unknown };
      exceptionDetails?: unknown;
    };
    return exceptionDetails ? null : ((result.value ?? null) as T | null);
  } catch {
    return null;
  }
}

async function settle(session: Session, timeoutMs: number): Promise<void> {
  const loaded = session.cdp.waitFor('Page.loadEventFired', session.sessionId, timeoutMs).catch(() => undefined);
  await Promise.race([loaded, sleep(timeoutMs)]);
  await sleep(1_500);
}

export async function goto(session: Session, url: string, timeoutMs = 30_000): Promise<void> {
  const loaded = session.cdp.waitFor('Page.loadEventFired', session.sessionId, timeoutMs).catch(() => undefined);
  const result = (await session.cdp.send('Page.navigate', { url }, session.sessionId)) as { errorText?: string };
  if (result.errorText) throw new FtbError(`could not open ${url}: ${result.errorText}`);
  await Promise.race([loaded, sleep(timeoutMs)]);
  await sleep(1_500);
}

/**
 * Akamai's "Challenge Validation" interstitial is a proof-of-work the page's own
 * script solves in ~20-30 s before resubmitting; a person waits it out too.
 */
async function waitOutChallenge(session: Session, say: (line: string) => void, timeoutMs = 90_000): Promise<void> {
  const challenged = `document.title === 'Challenge Validation' || !!document.getElementById('sec-cpt-if')`;
  if (!(await evaluate<boolean>(session, challenged))) return;
  say('  (FTB bot check: waiting for the browser to finish it)');
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await sleep(3_000);
    if ((await evaluate<boolean>(session, challenged)) === false) {
      await sleep(1_500);
      return;
    }
  }
  throw new FtbError(`FTB's bot check did not clear in ${timeoutMs / 1000}s`);
}

export async function readPage(session: Session): Promise<Page> {
  const page = await evaluate<Page>(session, READ_PAGE);
  if (!page) throw new FtbError('could not read the page');
  return page;
}

export interface WalkOptions {
  plan: Plan;
  rules: Rule[];
  /** Walk every page up to the one with the declaration, fill it, print its labels, and stop before Submit. */
  dryRun: boolean;
  /** Where each page's fields (never values) are appended, for tuning the rules. */
  log: string;
  /** Ask at the terminal for a required field no rule fills. */
  interactive: boolean;
  say: (line: string) => void;
  /** Where a verification code can be dropped when nobody is at a terminal. */
  codeFile: string;
  timeoutMs?: number;
}

/**
 * The code FTB just texted: typed at a terminal, or written to `codeFile` by
 * whoever has the phone (riotcoder, relaying a message). The browser session
 * stays open meanwhile; the code expires in minutes, so the wait is 15.
 */
async function waitForCode(options: WalkOptions): Promise<string> {
  if (options.interactive) return promptLine('Verification code FTB sent: ');
  rmSync(options.codeFile, { force: true });
  options.say(`  WAITING for the code FTB texted: write it to ${options.codeFile} (15 minutes)`);
  const until = Date.now() + 15 * 60_000;
  while (Date.now() < until) {
    await sleep(3_000);
    if (!existsSync(options.codeFile)) continue;
    const code = readFileSync(options.codeFile, 'utf8').trim();
    rmSync(options.codeFile, { force: true });
    if (/^\w{4,10}$/.test(code)) return code;
  }
  throw new FtbError('no verification code arrived in 15 minutes');
}

export interface WalkResult {
  outcome: Outcome | 'dry-run';
  page: Page;
}

function describe(field: Field): string {
  return `${field.label || field.name || field.id} (${field.type}${field.required ? ', required' : ''})`;
}

function logPage(path: string, page: Page): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fields = page.fields.map(({ selector, type, label, required, options }) => ({ selector, type, label, required, options: options?.slice(0, 12) }));
  // A page with nothing to fill is a result page; its words are the result. Form pages keep fields only.
  const text = page.fields.length ? undefined : page.text.replace(/^.*?Franchise Tax Board\s*(e-Services)?/s, '').slice(0, 2000);
  appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), url: page.url, title: page.title, errors: page.errors, fields, text })}\n`, { mode: 0o600 });
}

/**
 * Fill and submit pages until FTB answers. Selects, radios and checkboxes go
 * first and the page is read again, because choosing a security question is
 * what tells the answer box which answer it wants.
 */
export async function walk(session: Session, options: WalkOptions): Promise<WalkResult> {
  const { plan, rules, say } = options;
  const timeoutMs = options.timeoutMs ?? 30_000;
  let lastUrl = '';
  let sameUrl = 0;
  let replayed = false;

  for (let step = 0; step < 15; step += 1) {
    await waitOutChallenge(session, say);
    let page = await readPage(session);
    logPage(options.log, page);

    // A wrong or late code leaves the code page up with an error: wait for the next code, do not end the run.
    // The bot check fired on a POST and replayed it without its typed values: fill the page again, once.
    if (page.url.includes('akamai-challenge-resubmit') && page.errors.length && !replayed) {
      replayed = true;
      say('  (the bot check replayed the form without its values; filling it again)');
      page.errors = [];
    }
    const codeRetry = page.errors.length > 0 && page.errors.every((e) => /code you entered/i.test(e)) && page.fields.some((f) => CODE_LABEL.test(f.label));
    if (codeRetry) say(`  FTB: ${page.errors[0]}`);
    const outcome = codeRetry ? 'continue' : outcomeOf(`${page.errors.join(' ')} ${page.errors.length ? '' : page.text}`);
    if (outcome === 'rejected' || (page.errors.length && step > 0 && !codeRetry)) return { outcome: 'rejected', page };
    if (outcome !== 'continue') return { outcome, page };

    sameUrl = page.url === lastUrl ? sameUrl + 1 : 0;
    if (sameUrl >= 2 && !codeRetry) throw new FtbError(`stuck on ${page.url}: the page did not move after Continue (see ${options.log})`);
    lastUrl = page.url;
    say(`  ${page.title.split('|')[1]?.trim() || page.title}  ${page.url}`);

    const filled: string[] = [];
    const missing: Field[] = [];
    let declared = false;
    for (const pass of ['choices', 'text'] as const) {
      if (pass === 'text') {
        // A select can rewrite the page around it (FTB's form type does); let that land first.
        await sleep(2_500);
        page = await readPage(session);
      }
      for (const field of page.fields) {
        const choice = ['select-one', 'radio', 'checkbox'].includes(field.type);
        if ((pass === 'choices') !== choice) continue;
        const decision = decide(rules, field);
        if (!decision) {
          if (field.required && field.type !== 'radio') missing.push(field);
          continue;
        }
        const { rule, action } = decision;
        if (action.kind === 'declare') declared = true;
        if (action.kind === 'declare' && !plan.declare && !options.dryRun) {
          throw new FtbError(
            `this page asks you to declare, under penalty of perjury, that what is entered is true:\n  "${field.label}"\n` +
              'That statement is yours to make. Rerun with --declare once you have checked the values above.',
          );
        }
        if (!(await evaluate<boolean>(session, fillScript(field.selector, action)))) throw new FtbError(`could not fill ${describe(field)} on ${page.url}`);
        filled.push(`${rule.name}${action.kind === 'text' ? ` = ${action.secret ? '••••' : action.value}` : action.kind === 'select' ? ` = ${field.options?.find((o) => o.value === action.value)?.text ?? action.value}` : ''}`);
      }
    }

    for (const field of missing) {
      if (CODE_LABEL.test(field.label)) {
        const code = await waitForCode(options);
        await evaluate(session, fillScript(field.selector, { kind: 'text', value: code }));
        filled.push('verification code = ••••');
        continue;
      }
      if (!options.interactive) {
        throw new FtbError(`no rule fills ${describe(field)} on ${page.url}; run it in a terminal to answer by hand, or add a rule (fields logged to ${options.log})`);
      }
      const value = field.type === 'password' ? await promptSecret(`${field.label}: `) : await promptLine(`${field.label}${field.options ? ` [${field.options.map((o) => o.text).join(' | ')}]` : ''}: `);
      const action: Action = field.options ? { kind: 'select', value: field.options.find((o) => o.text === value)?.value ?? value } : { kind: 'text', value };
      await evaluate(session, fillScript(field.selector, action));
      filled.push(`${field.label} = (typed)`);
    }

    for (const line of filled) say(`    ${line}`);

    // The page with the declaration is the one that creates the account; a dry run shows it and stops.
    if (options.dryRun && declared) {
      for (const field of page.fields) if (field.type !== 'checkbox') say(`    [${field.label}]`);
      return { outcome: 'dry-run', page };
    }

    const pressed = await evaluate<string>(session, SUBMIT);
    if (!pressed || pressed.startsWith('?')) {
      throw new FtbError(`no forward button on ${page.url}; buttons seen: ${pressed?.slice(1) || 'none'} (fields logged to ${options.log})`);
    }
    say(`    -> ${pressed}`);
    await settle(session, timeoutMs);
  }
  throw new FtbError(`gave up after 15 pages (see ${options.log})`);
}
