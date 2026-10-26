#!/usr/bin/env node
/**
 * bookdl -- yt-dlp for the ebooks you are allowed to have as files.
 *
 * Public-domain libraries (Project Gutenberg, Standard Ebooks, the Internet
 * Archive's open items), your Humble Bundle library, and any direct DRM-free
 * link a store gives you (Leanpub, Gumroad, itch.io, Kobo/Google Play exports,
 * publishers). Every file is checked for DRM after it lands and refused if it
 * has any; nothing here removes DRM. Kindle and other locked stores get an
 * answer about what they do allow instead of a download.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { UsageError, parseArgs } from '../src/args.ts';
import {
  type Book,
  type BookFile,
  LockedError,
  archiveId,
  archiveKey,
  archivePath,
  chooseFiles,
  defaultLibrary,
  detectDrm,
  detectSource,
  directName,
  extensionOf,
  fileName,
  gutenbergFallback,
  gutenbergId,
  humbleKey,
  lockedStore,
  looksLikeHtml,
  looksLikeUrl,
  parseArchive,
  parseArchiveFile,
  parseFormats,
  parseGutendex,
  parseGutendexSearch,
  parseHumbleOrder,
  safeName,
  standardEbooks,
  EBOOK_EXTENSIONS,
  type HumbleOrder,
} from '../src/bookdl.ts';
import { resolveCredentials } from '../src/credentials.ts';
import { isMain } from '../src/is-main.ts';

const USAGE = `Usage:
  bookdl <url>...                download the book(s) at these URLs
  bookdl info <url>...           title, authors and formats; nothing downloaded
  bookdl search <query>          search Project Gutenberg
  bookdl humble [list]           every ebook in your Humble Bundle library
  bookdl humble get [--all]      download them (just new ones unless --force)
  bookdl check <file>...         does this file carry DRM?

Sources:
  gutenberg.org/ebooks/<id>      standardebooks.org/ebooks/<author>/<title>
  archive.org/details/<id>       (open items; lending-library books are refused)
  humblebundle.com/downloads?key=<key>    (needs \`cli-tools config set humble\`)
  any direct .epub/.pdf/.mobi/.azw3/.cbz link (Leanpub, Gumroad, itch.io,
  Kobo and Google Play DRM-free exports, publisher stores)

Options:
  -f, --format LIST   preference order (default: epub,pdf,azw3,mobi,cbz,txt)
      --all-formats   every format in LIST the book has, not just the first
      --to DIR        library directory (default: ~/Books, or $BOOKDL_DIR)
      --calibre       add each new file to Calibre with calibredb
      --force         download again even if the archive says you have it
      --json          info/search/humble list as JSON
      --help          show this help

Files are named "Author - Title.ext" and recorded in
~/.local/share/cli-tools/bookdl/archive.txt, so a second run fetches only what
is new. A file that turns out to have DRM (Adobe ADEPT, Readium LCP, Mobipocket,
KFX, or an .acsm ticket) is deleted and reported; bookdl never removes DRM.
`;

const UA = 'bookdl (+https://github.com/profullstack/cli-tools)';

async function get(url: string, headers: Record<string, string> = {}): Promise<Response> {
  const res = await fetch(url, { headers: { 'user-agent': UA, ...headers }, redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${new URL(url).host}`);
  return res;
}

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  return (await (await get(url, { accept: 'application/json', ...headers })).json()) as T;
}

function humbleHeaders(): Record<string, string> {
  const session = resolveCredentials(process.env).HUMBLE_SESSION;
  if (!session) {
    throw new Error(
      'Humble needs your session: in a logged-in humblebundle.com tab, copy the _simpleauth_sess cookie (DevTools > Application > Cookies), then `cli-tools config set humble`.',
    );
  }
  const value = session.replace(/^_simpleauth_sess=/, '').replace(/^"|"$/g, '');
  return { cookie: `_simpleauth_sess="${value}"`, 'x-requested-by': 'hb_android_app' };
}

async function humbleOrder(key: string): Promise<HumbleOrder> {
  return getJson<HumbleOrder>(`https://www.humblebundle.com/api/v1/order/${encodeURIComponent(key)}?all_tpkds=true`, humbleHeaders());
}

async function humbleLibrary(): Promise<Book[]> {
  let keys: { gamekey: string }[];
  try {
    keys = await getJson<{ gamekey: string }[]>('https://www.humblebundle.com/api/v1/user/order?ajax=true', humbleHeaders());
  } catch (err) {
    if (/^401/.test((err as Error).message)) {
      throw new Error('Humble said 401: the saved session cookie has expired. Copy a fresh _simpleauth_sess and `cli-tools config set humble`.');
    }
    throw err;
  }
  const books: Book[] = [];
  const seen = new Set<string>();
  for (const { gamekey } of keys) {
    for (const book of parseHumbleOrder(await humbleOrder(gamekey))) {
      if (seen.has(book.id)) continue;
      seen.add(book.id);
      books.push(book);
    }
  }
  return books;
}

/** Resolve a URL to a Book. Direct links have no metadata beyond their file name. */
async function resolve(url: string): Promise<Book[]> {
  const locked = lockedStore(url);
  if (locked && detectSource(url) === 'direct' && !/\.(epub|pdf|mobi|azw3|cbz)(\?|$)/i.test(url)) {
    throw new LockedError(locked);
  }
  switch (detectSource(url)) {
    case 'gutenberg': {
      const id = gutenbergId(url);
      try {
        return [parseGutendex(await getJson(`https://gutendex.com/books/${id}`))];
      } catch {
        return [gutenbergFallback(id)];
      }
    }
    case 'standardebooks': {
      let title: string | undefined;
      try {
        const html = await (await get(url)).text();
        title = html.match(/<title>([^<]*)<\/title>/)?.[1];
      } catch {
        // The slugs are enough to name and fetch it.
      }
      return [standardEbooks(url, title)];
    }
    case 'archive': {
      const id = archiveId(url);
      return [parseArchive(id, await getJson(`https://archive.org/metadata/${encodeURIComponent(id)}`))];
    }
    case 'humble':
      return parseHumbleOrder(await humbleOrder(humbleKey(url)));
    case 'direct': {
      const name = directName(url);
      const format = extensionOf(name);
      const stem = name.replace(/\.kepub\.epub$|\.[^.]+$/i, '');
      return [{ source: 'direct', id: url, title: stem || 'book', authors: [], files: [{ format, url }] }];
    }
  }
}

interface Options {
  formats: string[];
  all: boolean;
  dir: string;
  calibre: boolean;
  force: boolean;
}

function loadArchive(): Set<string> {
  try {
    return parseArchiveFile(readFileSync(archivePath(), 'utf8'));
  } catch {
    return new Set();
  }
}

function record(key: string): void {
  const path = archivePath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${key}\n`);
}

/** Fetch one file to its place in the library. Returns the path, or null when skipped. */
async function fetchFile(book: Book, file: BookFile, opts: Options, archive: Set<string>): Promise<string | null> {
  const key = archiveKey(book, file.format);
  if (!opts.force && archive.has(key)) {
    process.stderr.write(`skip  ${book.title} (${file.format}): already downloaded\n`);
    return null;
  }

  // Humble's download links are signed CDN URLs: no cookie needed or wanted.
  const res = await get(file.url);
  const buf = Buffer.from(await res.arrayBuffer());

  // A direct link that answered with a page is a login wall, an interstitial
  // or a store page: say so instead of saving HTML as "book.epub".
  if (looksLikeHtml(buf)) {
    throw new Error(`${file.url} returned a web page, not a book file (a login page or a store page?). Copy the file's own download link.`);
  }

  let format = file.format;
  let title = book.title;
  if (book.source === 'direct') {
    const name = directName(res.url || file.url, res.headers.get('content-disposition'));
    format = extensionOf(name) || format;
    title = name.replace(/\.kepub\.epub$|\.[^.]+$/i, '') || title;
    if (!(EBOOK_EXTENSIONS as readonly string[]).includes(format) && format !== 'kepub') {
      const sniff = detectDrm(buf);
      if (sniff.drm) throw new LockedError(`${file.url}: ${sniff.scheme}. bookdl does not remove DRM.`);
      throw new Error(`${file.url}: "${name}" is not an ebook format bookdl knows (${EBOOK_EXTENSIONS.join(', ')}).`);
    }
  }

  const verdict = detectDrm(buf);
  if (verdict.drm) {
    throw new LockedError(`${title} (${format}) has DRM: ${verdict.scheme}. Not saved; bookdl does not remove DRM.`);
  }
  if (file.md5) {
    const got = createHash('md5').update(buf).digest('hex');
    if (got !== file.md5) throw new Error(`${title} (${format}): md5 ${got} does not match the store's ${file.md5}`);
  }

  mkdirSync(opts.dir, { recursive: true });
  const target = join(
    opts.dir,
    book.source === 'direct' ? `${safeName(title)}.${format === 'kepub' ? 'kepub.epub' : format}` : fileName(book, format),
  );
  if (existsSync(target) && !opts.force) {
    process.stderr.write(`skip  ${target}: exists\n`);
    record(key);
    return null;
  }
  const part = `${target}.part`;
  writeFileSync(part, buf);
  renameSync(part, target);
  record(key);
  archive.add(key);
  process.stdout.write(`saved ${target}  (${(buf.length / 1048576).toFixed(1)} MB)\n`);

  if (opts.calibre) {
    const r = spawnSync('calibredb', ['add', '--duplicates', target], { stdio: 'inherit' });
    if (r.error) process.stderr.write('bookdl: --calibre: calibredb is not on PATH (install Calibre)\n');
  }
  return target;
}

async function download(books: Book[], opts: Options): Promise<number> {
  const archive = loadArchive();
  let failed = 0;
  for (const book of books) {
    const files = chooseFiles(book.files, opts.formats, opts.all);
    if (files.length === 0) {
      process.stderr.write(`bookdl: ${book.title}: none of ${opts.formats.join(',')} (has ${book.files.map((f) => f.format).join(',') || 'nothing'})\n`);
      failed += 1;
      continue;
    }
    for (const file of files) {
      try {
        await fetchFile(book, file, opts, archive);
      } catch (err) {
        // One bad file does not stop a library run; the exit code reports it.
        process.stderr.write(`bookdl: ${(err as Error).message}\n`);
        failed += 1;
      }
    }
  }
  return failed === 0 ? 0 : 1;
}

function describe(books: Book[], json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(books, null, 2)}\n`);
    return;
  }
  for (const b of books) {
    const who = b.authors.length ? ` -- ${b.authors.join(', ')}` : '';
    process.stdout.write(`${b.title}${who}  [${b.source} ${b.id}]\n  ${b.files.map((f) => f.format).join(', ') || '(no files)'}\n`);
  }
}

if (isMain(import.meta.url)) {
  try {
    const { flags, values, positional } = parseArgs(process.argv.slice(2), {
      boolean: ['--help', '--all-formats', '--all', '--calibre', '--force', '--json'],
      string: ['-f', '--format', '--to'],
    });
    if (flags.has('--help') || positional.length === 0) {
      process.stdout.write(USAGE);
      process.exit(positional.length === 0 ? 1 : 0);
    }

    const opts: Options = {
      formats: parseFormats(values.get('-f') ?? values.get('--format')),
      all: flags.has('--all-formats'),
      dir: values.get('--to') ?? defaultLibrary(),
      calibre: flags.has('--calibre'),
      force: flags.has('--force'),
    };
    const json = flags.has('--json');
    const [verb, ...rest] = positional as [string, ...string[]];

    if (verb === 'check') {
      if (rest.length === 0) throw new UsageError('check needs a file');
      let locked = 0;
      for (const path of rest) {
        const v = detectDrm(readFileSync(path));
        if (v.drm) locked += 1;
        process.stdout.write(`${v.drm ? `DRM (${v.scheme})` : 'DRM-free'}  ${path}\n`);
      }
      process.exit(locked === 0 ? 0 : 3);
    }

    if (verb === 'search') {
      if (rest.length === 0) throw new UsageError('search needs a query');
      const found = parseGutendexSearch(await getJson(`https://gutendex.com/books?search=${encodeURIComponent(rest.join(' '))}`));
      if (json) describe(found, true);
      else for (const b of found) process.stdout.write(`https://www.gutenberg.org/ebooks/${b.id}  ${b.title}${b.authors[0] ? ` -- ${b.authors[0]}` : ''}\n`);
      process.exit(found.length === 0 ? 1 : 0);
    }

    if (verb === 'humble') {
      const sub = rest[0] ?? 'list';
      const books = await humbleLibrary();
      if (sub === 'list') {
        describe(books, json);
        process.exit(0);
      }
      if (sub === 'get') process.exit(await download(books, { ...opts, all: opts.all || flags.has('--all') }));
      throw new UsageError(`unknown humble command: ${sub}`);
    }

    const info = verb === 'info';
    const urls = info ? rest : positional;
    if (urls.length === 0) throw new UsageError('info needs a URL');
    const books: Book[] = [];
    let failed = 0;
    let locked = 0;
    for (const url of urls) {
      if (!looksLikeUrl(url)) throw new UsageError(`not a URL: ${url}`);
      try {
        books.push(...(await resolve(url)));
      } catch (err) {
        process.stderr.write(`bookdl: ${(err as Error).message}\n`);
        if (err instanceof LockedError) locked += 1;
        else failed += 1;
      }
    }
    // 3 = refused because of DRM or a lending library, so a script can tell
    // "this book is locked" from "this download broke".
    const refusal = failed === 0 && locked > 0 ? 3 : failed > 0 ? 1 : 0;
    if (info) {
      describe(books, json);
      process.exit(refusal);
    }
    const code = await download(books, opts);
    process.exit(refusal || code);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`bookdl: ${err.message}\n\n${USAGE}`);
      process.exit(1);
    }
    process.stderr.write(`bookdl: ${(err as Error).message}\n`);
    process.exit(err instanceof LockedError ? 3 : 1);
  }
}
