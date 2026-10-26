import { inflateRawSync } from 'node:zlib';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * bookdl: the yt-dlp shape for ebooks you are allowed to have as files.
 *
 * Every extractor here reads a store or library that hands out DRM-free files
 * (public domain, or a store that sells without DRM), and every file is checked
 * for DRM after it lands. A file that turns out to carry Adobe ADEPT, Readium
 * LCP, Mobipocket or KFX protection is deleted and reported, never "fixed":
 * removing DRM is circumvention under DMCA 1201, and this tool does not do it.
 * Kindle, Apple Books and the DRM side of Kobo and Google Play are answered
 * with what they do allow instead (see `lockedStore`).
 */

export type Source = 'gutenberg' | 'standardebooks' | 'archive' | 'humble' | 'direct';

export interface BookFile {
  /** Lowercase extension without the dot: epub, pdf, azw3, mobi, txt... */
  format: string;
  url: string;
  size?: number;
  md5?: string;
}

export interface Book {
  source: Source;
  /** Stable per source: gutenberg id, archive identifier, SE slug, humble machine name. */
  id: string;
  title: string;
  authors: string[];
  files: BookFile[];
}

export const EBOOK_EXTENSIONS = ['epub', 'pdf', 'azw3', 'mobi', 'cbz', 'cbr', 'fb2', 'djvu', 'txt'] as const;

export const DEFAULT_FORMATS = ['epub', 'pdf', 'azw3', 'mobi', 'cbz', 'txt'];

export function defaultLibrary(env: NodeJS.ProcessEnv = process.env): string {
  return env.BOOKDL_DIR || join(homedir(), 'Books');
}

export function archivePath(env: NodeJS.ProcessEnv = process.env): string {
  const data = env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(data, 'cli-tools', 'bookdl', 'archive.txt');
}

/**
 * Stores whose books are DRM-locked by default, and what to do instead.
 *
 * Matched before any extractor so a pasted Kindle link gets an answer rather
 * than a download of the reader's HTML.
 */
export function lockedStore(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
  if (/(^|\.)amazon\.[a-z.]+$/.test(host) || host === 'read.amazon.com' || /(^|\.)kindle\./.test(host)) {
    return 'Kindle books are DRM-protected and bookdl does not remove DRM. Your highlights and notes export from https://read.amazon.com/notebook; a DRM-free edition, if the publisher sells one, will be on their own site, Humble, Leanpub or Gumroad.';
  }
  if (host === 'books.apple.com') {
    return 'Apple Books files are FairPlay-protected and bookdl does not remove DRM.';
  }
  if (host === 'play.google.com') {
    return 'Google Play Books: open the book in your library on the web, and if the publisher allowed it, "Export" offers a DRM-free EPUB or PDF link. Pass that link to bookdl. An .acsm file means the book is DRM-locked.';
  }
  if (host.endsWith('kobo.com')) {
    return 'Kobo: DRM-free titles show "DRM-Free" on the book page and download as a plain EPUB from My Books; pass that download link to bookdl. Others come as .acsm (Adobe DRM), which bookdl refuses.';
  }
  return null;
}

export function detectSource(url: string): Source {
  const u = new URL(url);
  const host = u.hostname.replace(/^www\./, '');
  if (host === 'gutenberg.org' && /^\/ebooks\/\d+/.test(u.pathname)) return 'gutenberg';
  if (host === 'standardebooks.org' && /^\/ebooks\/[^/]+\/[^/]+/.test(u.pathname)) return 'standardebooks';
  if (host === 'archive.org' && /^\/details\/[^/]+/.test(u.pathname)) return 'archive';
  if (host === 'humblebundle.com' && u.searchParams.has('key')) return 'humble';
  return 'direct';
}

export function looksLikeUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** "Austen, Jane" -> "Jane Austen"; anything without exactly one comma is left alone. */
export function naturalName(name: string): string {
  const parts = name.split(',').map((p) => p.trim());
  return parts.length === 2 && parts[0] && parts[1] ? `${parts[1]} ${parts[0]}` : name.trim();
}

const UNSAFE = /[\\/:*?"<>|\u0000-\u001f]/g;

export function safeName(value: string, max = 120): string {
  const cleaned = value.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  return cleaned.length > max ? cleaned.slice(0, max).trim() : cleaned || 'untitled';
}

/** "Author - Title.ext", the shape Calibre and most readers sort well. */
export function fileName(book: Pick<Book, 'title' | 'authors'>, format: string): string {
  // First author only: archive.org "creators" include illustrators and editors.
  const author = book.authors[0] ? safeName(book.authors[0], 60) : '';
  const title = safeName(book.title);
  const ext = format === 'kepub' ? 'kepub.epub' : format;
  return `${author ? `${author} - ` : ''}${title}.${ext}`;
}

/**
 * Pick the files to fetch: the first format in `wanted` the book has, or every
 * wanted format when `all` is set.
 */
export function chooseFiles(files: readonly BookFile[], wanted: readonly string[], all = false): BookFile[] {
  const order = wanted.map((w) => w.toLowerCase());
  const ranked = files
    .filter((f) => order.includes(f.format))
    .sort((a, b) => order.indexOf(a.format) - order.indexOf(b.format));
  if (all) {
    const seen = new Set<string>();
    return ranked.filter((f) => !seen.has(f.format) && seen.add(f.format));
  }
  return ranked.slice(0, 1);
}

export function parseFormats(value: string | undefined): string[] {
  if (!value) return DEFAULT_FORMATS;
  return value
    .split(',')
    .map((v) => v.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Extractors: pure parsers over what each site's API returns.         */
/* ------------------------------------------------------------------ */

interface GutendexBook {
  id: number;
  title: string;
  authors: { name: string }[];
  formats: Record<string, string>;
  copyright?: boolean | null;
}

const GUTENBERG_TYPES: [string, string][] = [
  ['application/epub+zip', 'epub'],
  ['application/x-mobipocket-ebook', 'azw3'],
  ['text/plain; charset=utf-8', 'txt'],
  ['text/plain; charset=us-ascii', 'txt'],
  ['application/pdf', 'pdf'],
];

export function gutenbergId(url: string): string {
  const m = new URL(url).pathname.match(/^\/ebooks\/(\d+)/);
  if (!m) throw new Error(`not a Project Gutenberg book URL: ${url}`);
  return m[1]!;
}

export function parseGutendex(json: GutendexBook): Book {
  const files: BookFile[] = [];
  for (const [mime, format] of GUTENBERG_TYPES) {
    const url = json.formats[mime];
    if (url && !files.some((f) => f.format === format)) files.push({ format, url });
  }
  return {
    source: 'gutenberg',
    id: String(json.id),
    title: json.title,
    authors: json.authors.map((a) => naturalName(a.name)),
    files,
  };
}

/** When gutendex is down: the URLs gutenberg.org itself redirects from. */
export function gutenbergFallback(id: string): Book {
  return {
    source: 'gutenberg',
    id,
    title: `Project Gutenberg ${id}`,
    authors: [],
    files: [
      { format: 'epub', url: `https://www.gutenberg.org/ebooks/${id}.epub3.images` },
      { format: 'azw3', url: `https://www.gutenberg.org/ebooks/${id}.kf8.images` },
      { format: 'txt', url: `https://www.gutenberg.org/ebooks/${id}.txt.utf-8` },
    ],
  };
}

export function parseGutendexSearch(json: { results: GutendexBook[] }): Book[] {
  return json.results.map(parseGutendex);
}

function titleCase(slug: string): string {
  return slug
    .split('-')
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * Standard Ebooks: /ebooks/<author>/<title>[/<translator>...]. The download
 * file is the path segments joined with "_", and a bare link answers with a
 * thank-you page: `?source=download` is what returns the file itself.
 */
export function standardEbooks(url: string, pageTitle?: string): Book {
  const u = new URL(url);
  const segments = u.pathname
    .replace(/^\/ebooks\//, '')
    .replace(/\/(downloads|text)(\/.*)?$/, '')
    .split('/')
    .filter(Boolean);
  if (segments.length < 2) throw new Error(`not a Standard Ebooks book URL: ${url}`);
  const base = `https://standardebooks.org/ebooks/${segments.join('/')}/downloads/${segments.join('_')}`;
  const q = '?source=download';
  let title = titleCase(segments[1]!);
  let authors = [titleCase(segments[0]!)];
  const m = pageTitle?.match(/^(.*?), by (.*?) - Free ebook download/);
  if (m) {
    title = m[1]!.trim();
    authors = m[2]!.split(/,\s*|\s+and\s+/).map((a) => a.trim()).filter(Boolean);
  }
  return {
    source: 'standardebooks',
    id: segments.join('/'),
    title,
    authors,
    files: [
      { format: 'epub', url: `${base}.epub${q}` },
      { format: 'azw3', url: `${base}.azw3${q}` },
      { format: 'kepub', url: `${base}.kepub.epub${q}` },
    ],
  };
}

interface ArchiveFile {
  name: string;
  format?: string;
  size?: string;
  md5?: string;
  private?: string | boolean;
}

interface ArchiveMetadata {
  metadata?: {
    identifier?: string;
    title?: string | string[];
    creator?: string | string[];
    'access-restricted-item'?: string | boolean;
  };
  files?: ArchiveFile[];
}

export class LockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockedError';
  }
}

const ARCHIVE_FORMATS: Record<string, string> = {
  EPUB: 'epub',
  'Text PDF': 'pdf',
  'Additional Text PDF': 'pdf',
  'Image Container PDF': 'pdf',
  'Grayscale PDF': 'pdf',
  'Comic Book ZIP': 'cbz',
  'Comic Book RAR': 'cbr',
  DjVu: 'djvu',
  DjVuTXT: 'txt',
  Mobi: 'mobi',
  'Kindle (AZW3)': 'azw3',
};

export function archiveId(url: string): string {
  const m = new URL(url).pathname.match(/^\/details\/([^/]+)/);
  if (!m) throw new Error(`not an Internet Archive item URL: ${url}`);
  return decodeURIComponent(m[1]!);
}

/**
 * An archive.org item. Lending-library books (access-restricted, or only
 * "LCP/ACS Encrypted" copies) are borrowed, not owned, and refused.
 */
export function parseArchive(id: string, json: ArchiveMetadata): Book {
  const meta = json.metadata;
  if (!meta || !json.files) throw new Error(`archive.org has no item ${id}`);
  const restricted = String(meta['access-restricted-item'] ?? '') === 'true';
  const files: BookFile[] = [];
  for (const f of json.files) {
    const format = f.format ? ARCHIVE_FORMATS[f.format] : undefined;
    if (!format || String(f.private ?? '') === 'true' || /encrypted/i.test(f.format ?? '')) continue;
    files.push({
      format,
      url: `https://archive.org/download/${encodeURIComponent(id)}/${f.name.split('/').map(encodeURIComponent).join('/')}`,
      ...(f.size ? { size: Number(f.size) } : {}),
      ...(f.md5 ? { md5: f.md5 } : {}),
    });
  }
  if (restricted || files.length === 0) {
    throw new LockedError(
      `archive.org item ${id} is a lending-library book (borrow it in the browser; its files are LCP/ACS encrypted), or has no ebook files.`,
    );
  }
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []);
  return {
    source: 'archive',
    id,
    title: first(meta.title)[0] ?? id,
    authors: first(meta.creator).map((c) => naturalName(c.replace(/,\s*\d{4}-(\d{4})?.*$/, ''))),
    files,
  };
}

interface HumbleDownloadStruct {
  name?: string;
  url?: { web?: string };
  md5?: string;
  file_size?: number;
}

interface HumbleSubproduct {
  machine_name: string;
  human_name: string;
  payee?: { human_name?: string };
  downloads?: { platform: string; download_struct?: HumbleDownloadStruct[] }[];
}

export interface HumbleOrder {
  gamekey: string;
  product?: { human_name?: string };
  subproducts?: HumbleSubproduct[];
}

/** Humble's "name" is the button label: EPUB, PDF, MOBI, "PDF (HQ)", "CBZ"... */
function humbleFormat(name: string | undefined, url: string): string | null {
  const fromUrl = new URL(url).pathname.split('.').pop()?.toLowerCase();
  if (fromUrl && (EBOOK_EXTENSIONS as readonly string[]).includes(fromUrl)) return fromUrl;
  const label = (name ?? '').toLowerCase();
  return (EBOOK_EXTENSIONS as readonly string[]).find((ext) => label.includes(ext)) ?? null;
}

/** The ebooks in one Humble order. Games, audio and video are skipped. */
export function parseHumbleOrder(order: HumbleOrder): Book[] {
  const books: Book[] = [];
  for (const sub of order.subproducts ?? []) {
    const files: BookFile[] = [];
    for (const d of sub.downloads ?? []) {
      if (d.platform !== 'ebook') continue;
      for (const s of d.download_struct ?? []) {
        const url = s.url?.web;
        if (!url) continue;
        const format = humbleFormat(s.name, url);
        if (!format) continue;
        files.push({
          format,
          url,
          ...(s.md5 ? { md5: s.md5 } : {}),
          ...(s.file_size ? { size: s.file_size } : {}),
        });
      }
    }
    if (files.length === 0) continue;
    books.push({
      source: 'humble',
      id: sub.machine_name,
      title: sub.human_name,
      authors: sub.payee?.human_name ? [sub.payee.human_name] : [],
      files,
    });
  }
  return books;
}

export function humbleKey(url: string): string {
  const key = new URL(url).searchParams.get('key');
  if (!key) throw new Error(`no ?key= in Humble URL: ${url}`);
  return key;
}

/** A direct file link: the name comes from Content-Disposition, else the path. */
export function directName(url: string, disposition?: string | null): string {
  const star = disposition?.match(/filename\*\s*=\s*[^']*''([^;]+)/i);
  const plain = disposition?.match(/filename\s*=\s*"?([^";]+)"?/i);
  const raw = star ? decodeURIComponent(star[1]!) : plain ? plain[1]! : decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
  return raw.trim();
}

export function extensionOf(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.kepub.epub')) return 'kepub';
  return lower.split('.').pop() ?? '';
}

/* ------------------------------------------------------------------ */
/* Download archive: one line per fetched file, like yt-dlp's.          */
/* ------------------------------------------------------------------ */

export function archiveKey(book: Pick<Book, 'source' | 'id'>, format: string): string {
  return `${book.source} ${book.id} ${format}`;
}

export function parseArchiveFile(text: string): Set<string> {
  return new Set(
    text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

/* ------------------------------------------------------------------ */
/* DRM detection. Detect and refuse; never remove.                      */
/* ------------------------------------------------------------------ */

export type DrmVerdict = { drm: false } | { drm: true; scheme: string };

/** Font obfuscation, which is in every other EPUB and is not DRM. */
const FONT_OBFUSCATION = ['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC'];

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

/** Central directory of a zip, enough to find and read META-INF files. */
export function zipEntries(buf: Buffer): ZipEntry[] {
  // End of central directory: last 22 bytes plus up to 64 KiB of comment.
  const min = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count && p + 46 <= buf.length; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function zipRead(buf: Buffer, entry: ZipEntry): Buffer {
  const p = entry.localOffset;
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const data = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`unsupported zip method ${entry.method}`);
}

export function epubDrm(buf: Buffer): DrmVerdict {
  const entries = zipEntries(buf);
  const names = new Set(entries.map((e) => e.name));
  if (names.has('META-INF/rights.xml')) return { drm: true, scheme: 'Adobe ADEPT' };
  if (names.has('META-INF/license.lcpl')) return { drm: true, scheme: 'Readium LCP' };
  const enc = entries.find((e) => e.name === 'META-INF/encryption.xml');
  if (enc) {
    const xml = zipRead(buf, enc).toString('utf8');
    const algorithms = [...xml.matchAll(/Algorithm\s*=\s*"([^"]+)"/g)].map((m) => m[1]!);
    // An EncryptionMethod that is not font obfuscation encrypts content.
    const real = algorithms.filter(
      (a) => !FONT_OBFUSCATION.includes(a) && !/xmldsig|#sha|#rsa|keyinfo/i.test(a),
    );
    if (real.length > 0) return { drm: true, scheme: `encrypted content (${real[0]})` };
  }
  return { drm: false };
}

export function pdfDrm(buf: Buffer): DrmVerdict {
  // Look at the head and tail, where the trailer and /Encrypt dictionary live,
  // plus a cheap scan of the whole file for the handler names.
  const text = buf.toString('latin1');
  if (/\/Filter\s*\/(EBX_HANDLER|Adobe\.APS|FOPN_\w+)/.test(text)) {
    const m = text.match(/\/Filter\s*\/(EBX_HANDLER|Adobe\.APS|FOPN_\w+)/)!;
    return { drm: true, scheme: m[1] === 'EBX_HANDLER' ? 'Adobe ADEPT' : `PDF DRM (${m[1]})` };
  }
  return { drm: false };
}

/** Mobipocket / AZW: the encryption type in the MOBI header of record 0. */
export function mobiDrm(buf: Buffer): DrmVerdict {
  if (buf.length < 86) return { drm: false };
  const type = buf.toString('latin1', 60, 68);
  if (type !== 'BOOKMOBI' && type !== 'TEXtREAd') return { drm: false };
  const rec0 = buf.readUInt32BE(78);
  if (rec0 + 14 > buf.length) return { drm: false };
  const encryption = buf.readUInt16BE(rec0 + 12);
  return encryption === 0 ? { drm: false } : { drm: true, scheme: 'Mobipocket DRM' };
}

/** Sniff the container and check it. Unknown types pass: there is nothing to say about them. */
export function detectDrm(buf: Buffer): DrmVerdict {
  const head = buf.subarray(0, 512).toString('latin1');
  if (head.includes('DRMION')) return { drm: true, scheme: 'Kindle KFX' };
  if (/<fulfillmentToken|adept:fulfillmentToken/.test(head) || head.includes('ns.adobe.com/adept')) {
    return { drm: true, scheme: 'Adobe ACSM (a DRM download ticket, not a book)' };
  }
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) {
    try {
      return epubDrm(buf);
    } catch {
      return { drm: false };
    }
  }
  if (head.startsWith('%PDF')) return pdfDrm(buf);
  return mobiDrm(buf);
}

/** Bytes that are an HTML page, not a book: a login wall or an interstitial. */
export function looksLikeHtml(buf: Buffer): boolean {
  const head = buf.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html');
}
