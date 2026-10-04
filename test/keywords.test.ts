import { describe, expect, it } from 'vitest';

import { assertUrl } from '../bin/keywords.ts';
import { formatReport, rank, readPage, report, tokenize } from '../src/keywords.ts';
import { findChrome, launchBrowser } from '../src/wcag.ts';

describe('tokenize', () => {
  it('lowercases, drops stop words, numbers and one-letter words', () => {
    expect(tokenize('The 2026 Guide to SEO & Content in a Day')).toEqual(['guide', 'seo', 'content', 'day']);
  });

  it('keeps + # and inner hyphens, strips apostrophes and edge hyphens', () => {
    expect(tokenize("C++ and C# aren't -server-side- tools")).toEqual(['c++', 'c#', 'arent', 'server-side', 'tools']);
  });

  it('normalizes compatibility forms', () => {
    expect(tokenize('ｆｕｌｌwidth Ｒｅａｃｔ')).toEqual(['fullwidth', 'react']);
  });
});

describe('rank', () => {
  it('counts a phrase once per block and needs 3 blocks for a word, 2 for a phrase', () => {
    const rows = rank([
      'Keyword research tools keyword research',
      'Keyword research for beginners',
      'Keyword tools compared',
      'Unrelated sentence entirely',
    ]);
    expect(rows).toEqual([
      { keyword: 'keyword', words: 1, count: 3 },
      { keyword: 'keyword research', words: 2, count: 2 },
    ]);
  });

  it('ranks everything when nothing clears the bar', () => {
    const rows = rank(['Lonely phrase words']);
    expect(rows.map((row) => row.keyword)).toEqual(['lonely phrase words', 'lonely phrase', 'phrase words', 'lonely', 'phrase', 'words']);
  });

  it('sorts by count, then longer phrases, then alphabetically, and honours the limit', () => {
    const blocks = ['alpha beta', 'alpha beta', 'alpha beta gamma'];
    expect(rank(blocks).map((row) => row.keyword)).toEqual(['alpha beta', 'alpha', 'beta']);
    expect(rank(blocks, 1)).toHaveLength(1);
  });
});

describe('formatReport', () => {
  it('prints the bookmarklet plaintext', () => {
    const text = formatReport(report({ title: 'T', href: 'https://x.test/', blocks: ['alpha beta', 'alpha beta', 'alpha beta'] }));
    expect(text).toBe(
      'KEYWORDS — SORTED BY COUNT\n\nalpha beta\nalpha\nbeta\n\nCOUNTS\n\n3\talpha beta\n3\talpha\n3\tbeta\n\n' +
        'SUBTOTALS\n\nPage: T\nURL: https://x.test/\nText blocks scanned: 3\nRanked keywords/phrases: 3\n' +
        '1-word keywords: 2\n1-word occurrences: 6\n2-word keywords: 1\n2-word occurrences: 3\n3-word keywords: 0\n3-word occurrences: 0',
    );
  });

  it('says so when there is nothing', () => {
    const text = formatReport(report({ title: '', href: 'about:blank', blocks: [] }));
    expect(text).toContain('SORTED BY COUNT\n\n(no keywords found)\n\nCOUNTS\n\n(no keywords found)');
  });
});

describe('assertUrl', () => {
  it('adds https to a bare host and refuses other schemes', () => {
    expect(assertUrl('example.org/a')).toBe('https://example.org/a');
    expect(() => assertUrl('file:///etc/passwd')).toThrow(/only http and https/);
  });
});

const chrome = findChrome();

describe.skipIf(!chrome)('readPage in headless Chrome', () => {
  it('reads visible content and skips nav, hidden and aria-hidden text', async () => {
    const html = `<title>Fixture</title>
      <nav><a href="/x">Navigation link text here</a></nav>
      <main>
        <h1>Visible heading about keywords</h1>
        <p>A paragraph about keyword extraction.</p>
        <p style="display:none">Hidden paragraph never counted</p>
        <p aria-hidden="true">Aria hidden paragraph text</p>
        <img alt="Alt text describing a chart" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="10" height="10">
      </main>`;
    const browser = await launchBrowser({ chrome: chrome!, timeoutMs: 20_000 });
    try {
      const page = await readPage(browser, `data:text/html,${encodeURIComponent(html)}`, { settleMs: 0 });
      expect(page.title).toBe('Fixture');
      expect(page.blocks).toContain('Visible heading about keywords');
      expect(page.blocks).toContain('A paragraph about keyword extraction.');
      expect(page.blocks).toContain('Alt text describing a chart');
      expect(page.blocks.join(' ')).not.toMatch(/Navigation|Hidden|Aria/);
    } finally {
      await browser.close();
    }
  }, 30_000);
});
