#!/usr/bin/env node
/**
 * wcag — the automated half of a WCAG-EM evaluation, from the terminal.
 *
 *   wcag audit https://example.org                 sample 5 pages, run axe, print the criteria
 *   wcag audit https://example.org --pages 12 --level AAA --md audit.md
 *   wcag report wcag-report.json                   the W3C report tool's evaluation file
 *   wcag open                                      how to load it into the tool
 *
 * The W3C WCAG-EM Report Tool has no CLI; src/wcag.ts says what this does
 * instead and why nothing here is ever marked "passed".
 */

import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { UsageError, integer, parseArgs } from '../src/args.ts';
import { isMain } from '../src/is-main.ts';
import {
  DEFAULT_LEVEL,
  DEFAULT_VERSION,
  NO_CHROME,
  OPEN_STEPS,
  REPORT_TOOL_URL,
  type SampleMethod,
  WcagError,
  audit,
  discoverSample,
  findChrome,
  formatSummary,
  hasFailures,
  isLevel,
  isReport,
  isSampleMethod,
  isWcagVersion,
  launchBrowser,
  summarize,
  toEvaluation,
  toMarkdown,
} from '../src/wcag.ts';

const DEFAULT_PAGES = 5;
const DEFAULT_REPORT = 'wcag-report.json';
const DEFAULT_EVALUATION = 'evaluation.json';

const USAGE = `Usage:
  wcag audit <url> [options]          sample the site, run axe-core on each page in headless Chrome,
                                      print one row per success criterion, write the report
  wcag report <report.json> [options] turn a report into the W3C WCAG-EM Report Tool's evaluation file
  wcag open                           how to load that file into ${REPORT_TOOL_URL}

Options for audit:
  -n, --pages N        how many pages to audit, including the start page (default: ${DEFAULT_PAGES})
  --sample METHOD      auto | sitemap | links | list (default: auto — the sitemap, then the
                       start page's own links when the sitemap is short)
  --url URL            a page to include whatever the sample says; repeatable
  --level A|AA|AAA     the conformance target (default: ${DEFAULT_LEVEL})
  --wcag 2.1|2.2       which WCAG (default: ${DEFAULT_VERSION})
  -o, --out FILE       where the report goes (default: ${DEFAULT_REPORT})
  --md FILE            also write a Markdown summary
  --timeout S          seconds to give each page to load (default: 30)
  --chrome PATH        the browser to use (default: CHROME_PATH, then the usual places)
  --json               print the report to stdout instead of the table
  --quiet              no per-page progress on stderr

Options for report:
  -o, --out FILE       where the evaluation goes (default: ${DEFAULT_EVALUATION})
  --site NAME          the site's name in the report (default: its host)
  --title T            the evaluation's title
  --evaluator NAME     who is evaluating
  --commissioner NAME  who asked for it

  --help               show this help

Exit status is 1 when a criterion within the target fails on any page, 2 on
a usage error or when no Chrome can be found. A criterion with no failure has
not passed: axe covers a part of each one, and the rest is the evaluator's.

  CHROME_PATH          a Chrome or Chromium binary, when the usual places have none
  CHROME_NO_SANDBOX    set to run Chrome without its sandbox (containers, root)
`;

function fail(message: string, code = 2): never {
  process.stderr.write(`wcag: ${message}\n`);
  process.exit(code);
}

function out(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function note(text: string): void {
  process.stderr.write(`${text}\n`);
}

/** `--url a --url b` is two values; parseArgs keeps the last, so they are read off argv directly. */
function repeated(argv: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === flag) {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('-')) values.push(next);
    } else if (argument.startsWith(`${flag}=`)) {
      values.push(argument.slice(flag.length + 1));
    }
  }
  return values;
}

function assertUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.includes('://') ? value : `https://${value}`);
  } catch {
    throw new UsageError(`not a URL: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UsageError(`only http and https pages can be audited, got ${url.protocol}`);
  }
  return url.href;
}

async function runAudit(argv: string[]): Promise<number> {
  const { flags, values, positional } = parseArgs(argv, {
    boolean: ['--json', '--quiet', '--help'],
    string: ['-n', '--pages', '--sample', '--url', '--level', '--wcag', '-o', '--out', '--md', '--timeout', '--chrome'],
  });
  if (flags.has('--help')) {
    out(USAGE);
    return 0;
  }
  if (positional.length !== 1) throw new UsageError('audit takes one URL: the page to start from');

  const start = assertUrl(positional[0]!);
  const pages = integer(values, values.has('-n') ? '-n' : '--pages', DEFAULT_PAGES, { min: 1, max: 200 });
  const method = values.get('--sample') ?? 'auto';
  if (!isSampleMethod(method)) throw new UsageError(`--sample must be auto, sitemap, links or list, got ${method}`);
  const level = values.get('--level')?.toUpperCase() ?? DEFAULT_LEVEL;
  if (!isLevel(level)) throw new UsageError(`--level must be A, AA or AAA, got ${level}`);
  const version = values.get('--wcag') ?? DEFAULT_VERSION;
  if (!isWcagVersion(version)) throw new UsageError(`--wcag must be 2.1 or 2.2, got ${version}`);
  const timeoutMs = integer(values, '--timeout', 30, { min: 1, max: 600 }) * 1000;
  const extra = repeated(argv, '--url').map(assertUrl);
  const outFile = values.get('-o') ?? values.get('--out') ?? DEFAULT_REPORT;
  const quiet = flags.has('--quiet') || flags.has('--json');

  const chrome = values.get('--chrome') ?? findChrome();
  if (!chrome) throw new WcagError(NO_CHROME);

  if (!quiet) note(`sampling ${start} (${method})…`);
  const sample = await discoverSample(start, { pages, method: method as SampleMethod, extra });
  if (!quiet) {
    note(`${sample.pages.length} pages from ${sample.from === 'start' ? 'the start page alone' : `the ${sample.from}`}` +
      (sample.candidates > sample.pages.length ? ` (${sample.candidates} candidates)` : ''));
  }

  const browser = await launchBrowser({ chrome, timeoutMs });
  try {
    const report = await audit(browser, sample, {
      version,
      level,
      timeoutMs,
      onPage: (result, index, total) => {
        if (quiet) return;
        const status = result.ok
          ? `${result.violations.length} rules failing, ${result.incomplete.length} to review`
          : `could not load: ${result.error ?? 'unknown'}`;
        note(`  [${index + 1}/${total}] ${result.url} — ${status} (${result.ms} ms)`);
      },
    });

    writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
    const markdown = values.get('--md');
    if (markdown) writeFileSync(markdown, toMarkdown(report));

    if (flags.has('--json')) {
      out(JSON.stringify(report, null, 2));
    } else {
      out(formatSummary(report, summarize(report)));
      out(`report: ${outFile}${markdown ? `, summary: ${markdown}` : ''}. Next: wcag report ${outFile}`);
    }
    return hasFailures(report) ? 1 : 0;
  } finally {
    await browser.close();
  }
}

async function runReport(argv: string[]): Promise<number> {
  const { flags, values, positional } = parseArgs(argv, {
    boolean: ['--help'],
    string: ['-o', '--out', '--site', '--title', '--evaluator', '--commissioner'],
  });
  if (flags.has('--help')) {
    out(USAGE);
    return 0;
  }
  if (positional.length !== 1) throw new UsageError('report takes one file: the report `wcag audit` wrote');

  const file = positional[0]!;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new WcagError(`cannot read ${file}: ${(error as Error).message}`);
  }
  if (!isReport(parsed)) throw new WcagError(`${file} is not a report written by \`wcag audit\``);

  const evaluation = toEvaluation(parsed, {
    ...(values.has('--site') ? { site: values.get('--site')! } : {}),
    ...(values.has('--title') ? { title: values.get('--title')! } : {}),
    ...(values.has('--evaluator') ? { evaluator: values.get('--evaluator')! } : {}),
    ...(values.has('--commissioner') ? { commissioner: values.get('--commissioner')! } : {}),
  });
  const outFile = values.get('-o') ?? values.get('--out') ?? DEFAULT_EVALUATION;
  writeFileSync(outFile, `${JSON.stringify(evaluation, null, 2)}\n`);

  const assertions = (evaluation.auditSample as unknown[]).length;
  const sampled = ((evaluation.selectSample as { structuredSample: unknown[] }).structuredSample).length;
  out(`${outFile}: ${sampled} pages in the sample, ${assertions} assertions. Open it at ${REPORT_TOOL_URL} with "Open evaluation".`);
  return 0;
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const verb = argv[0];
  try {
    if (verb === undefined || verb === '--help' || verb === '-h' || verb === 'help') {
      out(USAGE);
      process.exit(verb === undefined ? 1 : 0);
    }
    let code: number;
    if (verb === 'audit') code = await runAudit(argv.slice(1));
    else if (verb === 'report') code = await runReport(argv.slice(1));
    else if (verb === 'open') {
      out(OPEN_STEPS);
      code = 0;
    } else throw new UsageError(`unknown command: ${verb}`);
    process.exit(code);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`wcag: ${error.message}\n\n${USAGE}`);
      process.exit(2);
    }
    fail((error as Error).message, error instanceof WcagError ? 2 : 1);
  }
}
