import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import {
  LockedError,
  archiveKey,
  chooseFiles,
  detectDrm,
  detectSource,
  directName,
  extensionOf,
  fileName,
  gutenbergFallback,
  lockedStore,
  looksLikeHtml,
  naturalName,
  parseArchive,
  parseArchiveFile,
  parseFormats,
  parseGutendex,
  parseHumbleOrder,
  safeName,
  standardEbooks,
} from '../src/bookdl.ts';

/** A minimal zip: deflated entries, a central directory, an end record. */
function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name);
    const data = deflateRawSync(Buffer.from(text));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(text.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(text.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const EPUB = { mimetype: 'application/epub+zip', 'META-INF/container.xml': '<container/>' };

function encryption(algorithm: string): string {
  return `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><EncryptionMethod Algorithm="${algorithm}"/></EncryptedData></encryption>`;
}

function mobi(encryptionType: number): Buffer {
  const buf = Buffer.alloc(200);
  buf.write('BOOKMOBI', 60, 'latin1');
  buf.writeUInt32BE(100, 78);
  buf.writeUInt16BE(encryptionType, 112);
  return buf;
}

describe('detectDrm', () => {
  it('passes a plain EPUB', () => {
    expect(detectDrm(zip(EPUB))).toEqual({ drm: false });
  });

  /*
   * Font obfuscation lives in encryption.xml in a large share of retail and
   * Standard Ebooks EPUBs. Treating it as DRM would refuse half of every
   * DRM-free library.
   */
  it('passes EPUB font obfuscation, which is not DRM', () => {
    const idpf = zip({ ...EPUB, 'META-INF/encryption.xml': encryption('http://www.idpf.org/2008/embedding') });
    const adobe = zip({ ...EPUB, 'META-INF/encryption.xml': encryption('http://ns.adobe.com/pdf/enc#RC') });
    expect(detectDrm(idpf).drm).toBe(false);
    expect(detectDrm(adobe).drm).toBe(false);
  });

  it('flags Adobe ADEPT, Readium LCP and encrypted content', () => {
    expect(detectDrm(zip({ ...EPUB, 'META-INF/rights.xml': '<rights/>' }))).toEqual({ drm: true, scheme: 'Adobe ADEPT' });
    expect(detectDrm(zip({ ...EPUB, 'META-INF/license.lcpl': '{}' }))).toEqual({ drm: true, scheme: 'Readium LCP' });
    const aes = zip({ ...EPUB, 'META-INF/encryption.xml': encryption('http://www.w3.org/2001/04/xmlenc#aes128-cbc') });
    expect(detectDrm(aes).drm).toBe(true);
  });

  it('reads the PDF security handler', () => {
    expect(detectDrm(Buffer.from('%PDF-1.7\n1 0 obj<</Title(x)>>endobj')).drm).toBe(false);
    // A password-only /Standard handler is permissions, not a store's DRM.
    expect(detectDrm(Buffer.from('%PDF-1.7\n<</Filter /Standard /V 2>>')).drm).toBe(false);
    expect(detectDrm(Buffer.from('%PDF-1.7\n<</Filter /EBX_HANDLER /V 4>>'))).toEqual({ drm: true, scheme: 'Adobe ADEPT' });
  });

  it('reads the MOBI encryption field', () => {
    expect(detectDrm(mobi(0)).drm).toBe(false);
    expect(detectDrm(mobi(2))).toEqual({ drm: true, scheme: 'Mobipocket DRM' });
  });

  it('refuses KFX and an .acsm ticket', () => {
    expect(detectDrm(Buffer.from('êDRMIONî....', 'latin1')).drm).toBe(true);
    const acsm = Buffer.from('<?xml version="1.0"?><fulfillmentToken xmlns="http://ns.adobe.com/adept">');
    expect(detectDrm(acsm).drm).toBe(true);
  });
});

describe('lockedStore', () => {
  it('answers Kindle, Apple, Google Play and Kobo links', () => {
    expect(lockedStore('https://read.amazon.com/?asin=B0GY3BMFKK')).toMatch(/Kindle/);
    expect(lockedStore('https://www.amazon.co.uk/dp/B0X')).toMatch(/Kindle/);
    expect(lockedStore('https://books.apple.com/us/book/x/id1')).toMatch(/FairPlay/);
    expect(lockedStore('https://play.google.com/store/books/details?id=x')).toMatch(/Export/);
    expect(lockedStore('https://www.kobo.com/us/en/ebook/x')).toMatch(/DRM-Free/);
    expect(lockedStore('https://www.gutenberg.org/ebooks/1')).toBeNull();
  });
});

describe('detectSource', () => {
  it('routes each library and falls back to a direct link', () => {
    expect(detectSource('https://www.gutenberg.org/ebooks/345')).toBe('gutenberg');
    expect(detectSource('https://standardebooks.org/ebooks/jane-austen/emma')).toBe('standardebooks');
    expect(detectSource('https://archive.org/details/prideprejudice00aust')).toBe('archive');
    expect(detectSource('https://www.humblebundle.com/downloads?key=abc')).toBe('humble');
    expect(detectSource('https://leanpub.com/s/x.epub')).toBe('direct');
  });
});

describe('names', () => {
  it('turns catalogue names around and keeps file names safe', () => {
    expect(naturalName('Austen, Jane')).toBe('Jane Austen');
    expect(naturalName('Plato')).toBe('Plato');
    expect(safeName('a/b: c?')).toBe('a b c');
    expect(fileName({ title: 'Dracula', authors: ['Bram Stoker', 'Editor'] }, 'epub')).toBe('Bram Stoker - Dracula.epub');
    expect(fileName({ title: 'Emma', authors: [] }, 'kepub')).toBe('Emma.kepub.epub');
  });

  it('reads a direct link name from Content-Disposition first', () => {
    expect(directName('https://x.test/dl/123', 'attachment; filename="My Book.epub"')).toBe('My Book.epub');
    expect(directName('https://x.test/dl/123', "attachment; filename*=UTF-8''Caf%C3%A9.pdf")).toBe('Café.pdf');
    expect(directName('https://x.test/files/Book%20One.pdf?sig=1')).toBe('Book One.pdf');
    expect(extensionOf('x.kepub.epub')).toBe('kepub');
  });
});

describe('formats', () => {
  const files = [
    { format: 'pdf', url: 'p' },
    { format: 'epub', url: 'e' },
    { format: 'pdf', url: 'p2' },
  ];

  it('takes the first preferred format, or each one once with --all-formats', () => {
    expect(chooseFiles(files, ['epub', 'pdf']).map((f) => f.url)).toEqual(['e']);
    expect(chooseFiles(files, ['epub', 'pdf'], true).map((f) => f.url)).toEqual(['e', 'p']);
    expect(chooseFiles(files, ['mobi'])).toEqual([]);
    expect(parseFormats('.EPUB, pdf')).toEqual(['epub', 'pdf']);
  });
});

describe('extractors', () => {
  it('parses gutendex, and has a fallback when it is down', () => {
    const book = parseGutendex({
      id: 345,
      title: 'Dracula',
      authors: [{ name: 'Stoker, Bram' }],
      formats: {
        'application/epub+zip': 'https://www.gutenberg.org/ebooks/345.epub3.images',
        'text/plain; charset=utf-8': 'https://www.gutenberg.org/ebooks/345.txt.utf-8',
        'image/jpeg': 'cover.jpg',
      },
    });
    expect(book.authors).toEqual(['Bram Stoker']);
    expect(book.files.map((f) => f.format)).toEqual(['epub', 'txt']);
    expect(gutenbergFallback('1').files[0]!.url).toBe('https://www.gutenberg.org/ebooks/1.epub3.images');
  });

  /*
   * A bare Standard Ebooks .epub link answers with a thank-you page; only
   * `?source=download` returns the file. Every URL we build must carry it.
   */
  it('builds Standard Ebooks download links that return the file', () => {
    const book = standardEbooks(
      'https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice/downloads/jane-austen_pride-and-prejudice.epub',
      'Pride and Prejudice, by Jane Austen - Free ebook download - Standard Ebooks: ...',
    );
    expect(book.id).toBe('jane-austen/pride-and-prejudice');
    expect(book.title).toBe('Pride and Prejudice');
    expect(book.files[0]!.url).toBe(
      'https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice/downloads/jane-austen_pride-and-prejudice.epub?source=download',
    );
  });

  it('takes open archive.org files and refuses lending-library items', () => {
    const open = parseArchive('pp', {
      metadata: { title: 'Pride and prejudice', creator: ['Austen, Jane, 1775-1817'] },
      files: [
        { name: 'pp.epub', format: 'EPUB', size: '10' },
        { name: 'pp_lcp.epub', format: 'LCP Encrypted EPUB' },
        { name: 'pp.jpg', format: 'JPEG' },
      ],
    });
    expect(open.authors).toEqual(['Jane Austen']);
    expect(open.files.map((f) => f.url)).toEqual(['https://archive.org/download/pp/pp.epub']);

    const lending = {
      metadata: { title: 'x', 'access-restricted-item': 'true' },
      files: [{ name: 'x.epub', format: 'EPUB', private: 'true' }],
    };
    expect(() => parseArchive('x', lending)).toThrow(LockedError);
  });

  it('keeps only the ebooks from a Humble order', () => {
    const books = parseHumbleOrder({
      gamekey: 'k',
      subproducts: [
        {
          machine_name: 'pythonbook',
          human_name: 'Python Book',
          payee: { human_name: 'No Starch Press' },
          downloads: [
            {
              platform: 'ebook',
              download_struct: [
                { name: 'EPUB', url: { web: 'https://dl.humble.com/pythonbook.epub?gamekey=k&ttl=1' }, md5: 'abc' },
                { name: 'PDF', url: { web: 'https://dl.humble.com/pythonbook.pdf?gamekey=k' } },
                { name: 'Supplement', url: { web: 'https://dl.humble.com/code.zip' } },
              ],
            },
          ],
        },
        { machine_name: 'game', human_name: 'A Game', downloads: [{ platform: 'windows', download_struct: [] }] },
      ],
    });
    expect(books).toHaveLength(1);
    expect(books[0]!.files.map((f) => f.format)).toEqual(['epub', 'pdf']);
    expect(books[0]!.files[0]!.md5).toBe('abc');
  });
});

describe('archive file', () => {
  it('keys by source, id and format', () => {
    const key = archiveKey({ source: 'gutenberg', id: '345' }, 'epub');
    expect(parseArchiveFile(`${key}\n\nother 1 pdf\n`).has('gutenberg 345 epub')).toBe(true);
  });
});

describe('looksLikeHtml', () => {
  it('spots a login wall saved as a book', () => {
    expect(looksLikeHtml(Buffer.from('  <!DOCTYPE html><html>'))).toBe(true);
    expect(looksLikeHtml(Buffer.from('%PDF-1.7'))).toBe(false);
  });
});
