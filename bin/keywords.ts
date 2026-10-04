#!/usr/bin/env node
/**
 * keywords — the keywords and phrases a page repeats, ranked by count.
 *
 *   keywords https://example.org                 the bookmarklet's plaintext report
 *   keywords example.org --limit 50 --copy       top 50, also on the clipboard
 *   keywords https://example.org --json          the ranked rows as JSON
 *
 * src/keywords.ts says why this needs a browser and what is counted.
 */

import { spawnSync } from 'node:child_process';

import { UsageError, integer, parseArgs } from '../src/args.ts';
import { isMain } from '../src/is-main.ts';
import { CLIPBOARD_COMMANDS, DEFAULT_LIMIT, KeywordsError, formatReport, readPage, report } from '../src/keywords.ts';
import { NO_CHROME, WcagError, findChrome, launchBrowser } from '../src/wcag.ts';

const USAGE = `Usage:
  keywords <url> [options]    load the page in headless Chrome and rank the 1-, 2- and 3-word
                              phrases its visible text repeats

Options:
  -n, --limit N        how many keywords/phrases to rank (default: ${DEFAULT_LIMIT})
  --json               print {title, url, blocks, keywords: [{keyword, words, count}]} instead
  --copy               also put the output on the clipboard (wl-copy, xclip, xsel or pbcopy)
  --timeout S          seconds to give the page to load (default: 30)
  --wait MS            milliseconds to let the page render after load (default: 1000)
  --chrome PATH        the browser to use (default: CHROME_PATH, then the usual places)
  --help               show this help

A phrase counts once per text block it appears in. Single words need 3 blocks
and phrases 2 to rank; a page too short for that has everything ranked.
Navigation, header, footer, forms and hidden text are never read.

  CHROME_PATH          a Chrome or Chromium binary, when the usual places have none
  CHROME_NO_SANDBOX    set to run Chrome without its sandbox (containers, root)
`;

function out(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

export function assertUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.includes('://') ? value : `https://${value}`);
  } catch {
    throw new UsageError(`not a URL: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UsageError(`only http and https pages can be read, got ${url.protocol}`);
  }
  return url.href;
}

/** Hand text to the first clipboard command that exists. The name of the one used, or null. */
function copy(text: string): string | null {
  for (const [command, ...args] of CLIPBOARD_COMMANDS) {
    const result = spawnSync(command!, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000 });
    if (!result.error && result.status === 0) return command!;
  }
  return null;
}

async function main(argv: string[]): Promise<number> {
  const { flags, values, positional } = parseArgs(argv, {
    boolean: ['--json', '--copy', '--help', '-h'],
    string: ['-n', '--limit', '--timeout', '--wait', '--chrome'],
  });
  if (flags.has('--help') || flags.has('-h')) {
    out(USAGE);
    return 0;
  }
  if (positional.length !== 1) throw new UsageError('keywords takes one URL: the page to read');

  const url = assertUrl(positional[0]!);
  const limit = integer(values, values.has('-n') ? '-n' : '--limit', DEFAULT_LIMIT, { min: 1, max: 100_000 });
  const timeoutMs = integer(values, '--timeout', 30, { min: 1, max: 600 }) * 1000;
  const settleMs = integer(values, '--wait', 1000, { max: 120_000 });

  const chrome = values.get('--chrome') ?? findChrome();
  if (!chrome) throw new KeywordsError(NO_CHROME);

  const browser = await launchBrowser({ chrome, timeoutMs });
  let text: string;
  try {
    const page = await readPage(browser, url, { timeoutMs, settleMs });
    const result = report(page, limit);
    text = flags.has('--json') ? JSON.stringify(result, null, 2) : formatReport(result);
  } finally {
    await browser.close();
  }

  out(text);
  if (flags.has('--copy')) {
    const used = copy(text);
    process.stderr.write(used ? `keywords: copied to the clipboard (${used})\n` : 'keywords: no clipboard command found (wl-copy, xclip, xsel, pbcopy)\n');
  }
  return 0;
}

if (isMain(import.meta.url)) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`keywords: ${error.message}\n\n${USAGE}`);
      process.exit(2);
    }
    process.stderr.write(`keywords: ${(error as Error).message}\n`);
    process.exit(error instanceof KeywordsError || error instanceof WcagError ? 2 : 1);
  }
}
