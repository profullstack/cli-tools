import { describe, expect, it } from 'vitest';

import {
  CRITERIA,
  EVALUATION_CONTEXT,
  type PageResult,
  type Report,
  type RuleFinding,
  axeTags,
  browserEnv,
  chooseSample,
  chromeCandidates,
  compareNums,
  criteriaFor,
  criteriaFromTags,
  criterionFromTag,
  criterionId,
  discoverSample,
  findChrome,
  formatSummary,
  hasFailures,
  isReport,
  normalizeUrl,
  pageOutcomes,
  pageTitles,
  parseSitemap,
  sameOriginLinks,
  sitemapsFromRobots,
  summarize,
  toEvaluation,
  toMarkdown,
  totals,
  withinTarget,
} from '../src/wcag.ts';

// ---------------------------------------------------------------------------
// Criteria and tags
// ---------------------------------------------------------------------------

describe('the criteria table', () => {
  it('carries WCAG 2.1 as 78 criteria and 2.2 as 86, like the report tool', () => {
    expect(criteriaFor('2.1')).toHaveLength(78);
    expect(criteriaFor('2.2')).toHaveLength(86);
  });

  it('drops 4.1.1 from 2.2 and adds the nine new ones', () => {
    const nums22 = criteriaFor('2.2').map((criterion) => criterion.num);
    const nums21 = criteriaFor('2.1').map((criterion) => criterion.num);
    expect(nums21).toContain('4.1.1');
    expect(nums22).not.toContain('4.1.1');
    expect(nums22.filter((num) => !nums21.includes(num))).toEqual([
      '2.4.11', '2.4.12', '2.4.13', '2.5.7', '2.5.8', '3.2.6', '3.3.7', '3.3.8', '3.3.9',
    ]);
  });

  it('uses the report tool ids, which differ for 2.5.5 between versions', () => {
    const contrast = CRITERIA.find((criterion) => criterion.num === '1.4.3')!;
    expect(criterionId(contrast, '2.2')).toBe('WCAG22:contrast-minimum');
    expect(criterionId(contrast, '2.1')).toBe('WCAG21:contrast-minimum');
    const target = CRITERIA.find((criterion) => criterion.num === '2.5.5')!;
    expect(criterionId(target, '2.1')).toBe('WCAG21:target-size');
    expect(criterionId(target, '2.2')).toBe('WCAG22:target-size-enhanced');
  });

  it('has no duplicate numbers', () => {
    const nums = CRITERIA.map((criterion) => criterion.num);
    expect(new Set(nums).size).toBe(nums.length);
  });

  it('sorts 1.4.3 before 1.4.10', () => {
    expect(['1.4.10', '1.4.3', '2.1.1', '1.1.1'].sort(compareNums)).toEqual(['1.1.1', '1.4.3', '1.4.10', '2.1.1']);
  });

  it('nests the levels: AA includes A, AAA includes both', () => {
    expect(withinTarget('A', 'AA')).toBe(true);
    expect(withinTarget('AAA', 'AA')).toBe(false);
    expect(withinTarget('AA', 'AAA')).toBe(true);
  });
});

describe('criterionFromTag', () => {
  it('reads principle, guideline and criterion off an axe tag', () => {
    expect(criterionFromTag('wcag111')).toBe('1.1.1');
    expect(criterionFromTag('wcag143')).toBe('1.4.3');
    expect(criterionFromTag('wcag1412')).toBe('1.4.12');
    expect(criterionFromTag('wcag2411')).toBe('2.4.11');
  });

  it('ignores level and category tags', () => {
    expect(criterionFromTag('wcag2aa')).toBeNull();
    expect(criterionFromTag('wcag21a')).toBeNull();
    expect(criterionFromTag('best-practice')).toBeNull();
    expect(criterionFromTag('cat.color')).toBeNull();
  });

  // axe tags `wcag2a-obsolete` on the 4.1.1 rules and other tags name
  // criteria WCAG does not have; neither should invent a row.
  it('refuses a number that is not a criterion', () => {
    expect(criterionFromTag('wcag199')).toBeNull();
    expect(criterionFromTag('wcag2a-obsolete')).toBeNull();
  });

  it('collects the criteria of a rule in order, once each', () => {
    expect(criteriaFromTags(['cat.color', 'wcag2aa', 'wcag143', 'wcag1411', 'wcag143', 'ACT'])).toEqual(['1.4.3', '1.4.11']);
  });
});

describe('axeTags', () => {
  it('selects every version up to the target at every level within it', () => {
    expect(axeTags('2.2', 'AA')).toEqual(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa']);
    expect(axeTags('2.1', 'A')).toEqual(['wcag2a', 'wcag21a']);
    expect(axeTags('2.2', 'AAA')).toContain('wcag2aaa');
  });

  it('never asks for best practices', () => {
    expect(axeTags('2.2', 'AAA')).not.toContain('best-practice');
  });
});

// ---------------------------------------------------------------------------
// The sample
// ---------------------------------------------------------------------------

describe('parseSitemap', () => {
  it('reads a urlset', () => {
    const xml = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://example.org/</loc><lastmod>2026-01-01</lastmod></url>
      <url><loc>https://example.org/about?a=1&amp;b=2</loc></url>
    </urlset>`;
    expect(parseSitemap(xml)).toEqual({ urls: ['https://example.org/', 'https://example.org/about?a=1&b=2'], sitemaps: [] });
  });

  it('reads an index into its children', () => {
    const xml = `<sitemapindex><sitemap><loc>https://example.org/sitemap-1.xml</loc></sitemap>
      <sitemap><loc><![CDATA[https://example.org/sitemap-2.xml]]></loc></sitemap></sitemapindex>`;
    expect(parseSitemap(xml)).toEqual({ urls: [], sitemaps: ['https://example.org/sitemap-1.xml', 'https://example.org/sitemap-2.xml'] });
  });

  it('yields nothing for a page that is not a sitemap', () => {
    expect(parseSitemap('<!doctype html><html><body>404</body></html>')).toEqual({ urls: [], sitemaps: [] });
  });

  it('reads the sitemaps robots.txt names', () => {
    expect(sitemapsFromRobots('User-agent: *\nDisallow: /admin\nSitemap: https://example.org/a.xml\nsitemap:https://example.org/b.xml\n')).toEqual([
      'https://example.org/a.xml',
      'https://example.org/b.xml',
    ]);
  });
});

describe('normalizeUrl', () => {
  it('drops the fragment, index.html and a trailing slash', () => {
    expect(normalizeUrl('https://example.org/docs/#top')).toBe('https://example.org/docs');
    expect(normalizeUrl('https://example.org/docs/index.html')).toBe('https://example.org/docs');
    expect(normalizeUrl('https://example.org/')).toBe('https://example.org/');
  });

  it('refuses anything that is not a web page', () => {
    expect(normalizeUrl('mailto:hi@example.org')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
  });
});

describe('sameOriginLinks', () => {
  const html = `<nav>
    <a href="/">Home</a>
    <a href='/about/'>About</a>
    <a href="https://example.org/pricing#plans">Pricing</a>
    <a href="https://other.example/">Elsewhere</a>
    <a href="/brochure.pdf">Brochure</a>
    <a href="mailto:hi@example.org">Mail</a>
    <a href="#top">Top</a>
    <a class="x" href=/about>About again</a>
    <a href="/docs?page=2&amp;sort=asc">Docs</a>
  </nav>`;

  it('keeps same-origin pages, absolute, in order, once each', () => {
    expect(sameOriginLinks(html, 'https://example.org/start')).toEqual([
      'https://example.org/',
      'https://example.org/about',
      'https://example.org/pricing',
      'https://example.org/docs?page=2&sort=asc',
    ]);
  });
});

describe('chooseSample', () => {
  const candidates = [
    'https://example.org/posts/1',
    'https://example.org/posts/2',
    'https://example.org/posts/3',
    'https://example.org/about',
    'https://example.org/docs/intro',
    'https://example.org/docs/api',
    'https://example.org/pricing',
  ];

  it('starts with the start page and spreads across sections before repeating one', () => {
    expect(chooseSample('https://example.org/', candidates, 5)).toEqual([
      'https://example.org/',
      'https://example.org/posts/1',
      'https://example.org/about',
      'https://example.org/docs/intro',
      'https://example.org/pricing',
    ]);
  });

  it('puts hand-picked pages before the crawl and never repeats one', () => {
    expect(chooseSample('https://example.org/', candidates, 3, ['https://example.org/pricing', 'https://example.org/#x'])).toEqual([
      'https://example.org/',
      'https://example.org/pricing',
      'https://example.org/posts/1',
    ]);
  });

  it('is capped by the limit even when the extras alone exceed it', () => {
    expect(chooseSample('https://example.org/', candidates, 2, ['https://example.org/a', 'https://example.org/b'])).toHaveLength(2);
  });
});

describe('discoverSample', () => {
  const site: Record<string, string> = {
    'https://example.org/robots.txt': 'Sitemap: https://example.org/extra.xml\n',
    'https://example.org/sitemap.xml': '<urlset><url><loc>https://example.org/</loc></url><url><loc>https://example.org/about</loc></url></urlset>',
    'https://example.org/extra.xml': '<urlset><url><loc>https://example.org/pricing</loc></url><url><loc>https://example.org/file.pdf</loc></url></urlset>',
    'https://example.org/': '<a href="/blog">Blog</a><a href="/careers">Careers</a>',
  };
  const get = async (url: string): Promise<string | null> => site[url] ?? null;

  it('reads the sitemap and the ones robots.txt adds, skipping files', async () => {
    const sample = await discoverSample('https://example.org/', { pages: 10, method: 'sitemap', fetch: get });
    expect(sample.from).toBe('sitemap');
    expect(sample.pages).toEqual(['https://example.org/', 'https://example.org/about', 'https://example.org/pricing']);
    expect(sample.candidates).toBe(3);
  });

  it('falls back to the start page links when auto finds too few', async () => {
    const sample = await discoverSample('https://example.org/', { pages: 5, method: 'auto', fetch: get });
    expect(sample.pages).toEqual([
      'https://example.org/',
      'https://example.org/about',
      'https://example.org/pricing',
      'https://example.org/blog',
      'https://example.org/careers',
    ]);
  });

  it('audits only the start page when there is no sitemap and no links', async () => {
    const sample = await discoverSample('https://example.org/', { pages: 5, method: 'auto', fetch: async () => null });
    expect(sample).toEqual({ pages: ['https://example.org/'], from: 'start', candidates: 0 });
  });

  it('takes the list as given', async () => {
    const sample = await discoverSample('https://example.org/', { pages: 5, method: 'list', extra: ['https://example.org/x'], fetch: get });
    expect(sample.pages).toEqual(['https://example.org/', 'https://example.org/x']);
    expect(sample.from).toBe('list');
  });
});

// ---------------------------------------------------------------------------
// Finding Chrome
// ---------------------------------------------------------------------------

describe('findChrome', () => {
  it('takes CHROME_PATH first, then PATH, then the caches', () => {
    const candidates = chromeCandidates({ CHROME_PATH: '/x/chrome', PATH: '/usr/bin' }, '/home/nobody');
    expect(candidates[0]).toBe('/x/chrome');
    expect(candidates).toContain('/usr/bin/google-chrome');
    expect(candidates).toContain('/opt/google/chrome/chrome');
  });

  it('reports none when nothing is executable', () => {
    expect(findChrome({ PATH: '/nowhere' }, '/home/nobody', () => false)).toBeNull();
  });

  it('returns the first executable candidate', () => {
    expect(findChrome({ PATH: '/a:/b' }, '/home/nobody', (path) => path === '/b/chromium')).toBe('/b/chromium');
  });

  it('leaves the environment alone when there is no staged library directory', () => {
    const env = browserEnv({ PATH: '/usr/bin' }, '/nowhere/chrome-deps');
    expect(env).toEqual({ PATH: '/usr/bin' });
  });
});

// ---------------------------------------------------------------------------
// Reading a report
// ---------------------------------------------------------------------------

const finding = (rule: string, criteria: string[], nodes: number, impact: string | null = 'serious'): RuleFinding => ({
  rule,
  impact,
  help: `Help for ${rule}`,
  helpUrl: `https://dequeuniversity.com/rules/axe/4.13/${rule}`,
  criteria,
  nodes,
  targets: ['.hero > p', 'footer a'].slice(0, Math.min(2, nodes)),
});

const page = (url: string, title: string, overrides: Partial<PageResult> = {}): PageResult => ({
  url,
  finalUrl: url,
  title,
  ok: true,
  violations: [],
  incomplete: [],
  passes: [],
  inapplicable: [],
  ms: 100,
  ...overrides,
});

const report = (): Report => ({
  tool: 'cli-tools wcag',
  axeVersion: '4.13.0',
  wcagVersion: '2.2',
  level: 'AA',
  site: 'https://example.org',
  startedAt: '2026-09-13T10:00:00.000Z',
  finishedAt: '2026-09-13T10:00:30.000Z',
  sample: { from: 'sitemap', candidates: 40 },
  pages: [
    page('https://example.org/', 'Example', {
      violations: [finding('color-contrast', ['1.4.3'], 18), finding('image-alt', ['1.1.1'], 2, 'critical')],
      incomplete: [finding('color-contrast', ['1.4.3'], 3, null)],
      passes: [finding('html-has-lang', ['3.1.1'], 1, null), finding('document-title', ['2.4.2'], 1, null)],
      inapplicable: ['video-caption'],
    }),
    page('https://example.org/about', 'About', {
      violations: [finding('color-contrast', ['1.4.3'], 4)],
      incomplete: [finding('link-in-text-block', ['1.4.1'], 2, null)],
      passes: [finding('html-has-lang', ['3.1.1'], 1, null)],
    }),
    page('https://example.org/pricing', 'Example', {
      passes: [finding('html-has-lang', ['3.1.1'], 1, null), finding('color-contrast', ['1.4.3'], 40, null)],
    }),
    page('https://example.org/broken', '', { ok: false, error: 'net::ERR_NAME_NOT_RESOLVED' }),
  ],
});

describe('pageOutcomes', () => {
  it('fails on a violation, cannot tell otherwise, and never passes', () => {
    const outcomes = pageOutcomes(report().pages[0]!);
    expect(outcomes.get('1.4.3')?.outcome).toBe('failed');
    expect(outcomes.get('1.1.1')?.outcome).toBe('failed');
    expect(outcomes.get('3.1.1')?.outcome).toBe('cantTell');
    expect(outcomes.get('2.4.2')?.outcome).toBe('cantTell');
    expect(outcomes.has('1.2.2')).toBe(false);
  });
});

describe('summarize', () => {
  it('counts pages per criterion and names the rule with the most elements', () => {
    const rows = summarize(report());
    expect(rows.map((row) => row.num)).toEqual(['1.1.1', '1.4.1', '1.4.3', '2.4.2', '3.1.1']);
    const contrast = rows.find((row) => row.num === '1.4.3')!;
    expect(contrast).toMatchObject({ level: 'AA', failing: 2, review: 0, passing: 1, nodes: 22 });
    expect(contrast.worst).toEqual({ rule: 'color-contrast', nodes: 22, impact: 'serious' });
    expect(rows.find((row) => row.num === '1.4.1')).toMatchObject({ failing: 0, review: 1, passing: 0, worst: null });
    expect(rows.find((row) => row.num === '3.1.1')).toMatchObject({ failing: 0, review: 0, passing: 3 });
  });

  it('skips pages that did not load', () => {
    expect(totals(report())).toEqual({ pages: 4, loaded: 3, failingPages: 2, failingCriteria: 2, reviewCriteria: 1, nodes: 24 });
  });

  it('only counts failures within the target', () => {
    const strict = report();
    strict.level = 'A';
    expect(totals(strict).failingCriteria).toBe(1);
    expect(hasFailures(strict)).toBe(true);
    const clean = report();
    clean.pages = [page('https://example.org/', 'Example', { passes: [finding('html-has-lang', ['3.1.1'], 1, null)] })];
    expect(hasFailures(clean)).toBe(false);
  });
});

describe('formatSummary', () => {
  it('prints a row per criterion and a totals line with the pages that broke', () => {
    const text = formatSummary(report());
    expect(text).toContain('SC     Level  Criterion');
    expect(text).toMatch(/1\.4\.3\s+AA\s+Contrast \(Minimum\)\s+2\s+-\s+1\s+color-contrast \(22 elements, serious\)/);
    expect(text).toContain('WCAG 2.2 level AA: 2 criteria failing on 2 pages of 3 (24 elements), 1 to review by hand. axe-core 4.13.0.');
    expect(text).toContain('could not load https://example.org/broken: net::ERR_NAME_NOT_RESOLVED');
  });

  it('says one criterion, not one criteria', () => {
    const one = report();
    one.pages = [page('https://example.org/', 'Example', { violations: [finding('image-alt', ['1.1.1'], 1)] })];
    expect(formatSummary(one)).toContain('1 criterion failing on 1 page of 1 (1 element)');
  });
});

describe('toMarkdown', () => {
  it('lists the sample, the failing rules under each criterion, and what needs a person', () => {
    const md = toMarkdown(report());
    expect(md).toContain('# Accessibility audit of https://example.org');
    expect(md).toContain('- [Example](https://example.org/)');
    expect(md).toContain('- https://example.org/broken — could not load');
    expect(md).toContain('### 1.4.3 Contrast (Minimum) (AA) — fails on 2 pages');
    expect(md).toContain('**color-contrast** (serious): Help for color-contrast. [How to fix](https://dequeuniversity.com/rules/axe/4.13/color-contrast). 2 pages, e.g. `.hero > p`.');
    expect(md).toContain('- 1.4.1 Use of Color (A), 1 page');
  });
});

// ---------------------------------------------------------------------------
// The report tool's evaluation file
// ---------------------------------------------------------------------------

describe('pageTitles', () => {
  it('tells two pages with the same title apart by path, and names an untitled page by its path', () => {
    expect(pageTitles([page('https://example.org/', 'Blog'), page('https://example.org/blog', 'Blog'), page('https://example.org/x', '  ')])).toEqual([
      'Blog',
      'Blog (/blog)',
      '/x',
    ]);
  });
});

describe('toEvaluation', () => {
  const evaluation = toEvaluation(report(), { evaluator: 'Anthony' }) as Record<string, any>;

  it('is the report tool\'s own shape: its context, type and five steps', () => {
    expect(evaluation['@type']).toBe('Evaluation');
    expect(evaluation['@context']).toEqual(EVALUATION_CONTEXT);
    // The tool's context has no WCAG22 term and its importer relies on that:
    // a defined prefix expands the ids into IRIs it cannot fold back.
    expect(evaluation['@context'].WCAG22).toBeUndefined();
    expect(Object.keys(evaluation)).toEqual(expect.arrayContaining(['defineScope', 'exploreTarget', 'selectSample', 'auditSample', 'reportFindings']));
    expect(evaluation.defineScope).toMatchObject({ wcagVersion: '2.2', conformanceTarget: 'AA' });
    expect(evaluation.defineScope.scope).toMatchObject({ type: ['TestSubject', 'Website'], title: 'example.org' });
    expect(evaluation.reportFindings.evaluator).toBe('Anthony');
  });

  // The tool derives a sampled page's id from the URL in its description and
  // finds it again by title, so both have to be exactly this.
  it('puts every loaded page in the structured sample with its URL as id and description', () => {
    const sample = evaluation.selectSample.structuredSample as Record<string, unknown>[];
    expect(sample).toHaveLength(3);
    expect(sample[0]).toEqual({
      id: 'https://example.org/',
      type: ['TestSubject', 'Webpage'],
      date: '2026-09-13T10:00:30.000Z',
      title: 'Example',
      description: 'https://example.org/',
    });
    expect(sample[2]?.title).toBe('Example (/pricing)');
    expect(evaluation.selectSample.randomSample).toEqual([]);
  });

  it('writes one assertion per page and criterion, against the tool\'s criterion ids', () => {
    const assertions = evaluation.auditSample as Record<string, any>[];
    expect(assertions).toHaveLength(4 + 3 + 2);
    const contrast = assertions.find((assertion) => assertion.subject.id === 'https://example.org/' && assertion.test.id === 'WCAG22:contrast-minimum');
    expect(contrast).toMatchObject({
      type: ['Assertion'],
      mode: 'earl:automatic',
      subject: { title: 'Example' },
      test: { type: ['TestCriterion', 'TestRequirement'], num: '1.4.3' },
      result: { outcome: { id: 'earl:failed', type: ['OutcomeValue', 'Fail'] } },
    });
    expect(contrast?.result.description).toContain('color-contrast [serious]: Help for color-contrast — 18 elements. e.g. .hero > p | footer a');
    const lang = assertions.find((assertion) => assertion.subject.id === 'https://example.org/' && assertion.test.id === 'WCAG22:language-of-page');
    expect(lang?.result.outcome.id).toBe('earl:cantTell');
    expect(lang?.result.description).toContain('Passing checks: html-has-lang.');
    expect(assertions.every((assertion) => assertion.result.outcome.id !== 'earl:passed')).toBe(true);
  });

  it('uses the 2.1 ids and leaves 2.2-only criteria out under 2.1', () => {
    const older = report();
    older.wcagVersion = '2.1';
    older.pages = [page('https://example.org/', 'Example', { violations: [finding('target-size', ['2.5.8'], 1), finding('color-contrast', ['1.4.3'], 1)] })];
    const assertions = (toEvaluation(older) as Record<string, any>).auditSample as Record<string, any>[];
    expect(assertions.map((assertion) => assertion.test.id)).toEqual(['WCAG21:contrast-minimum']);
  });
});

describe('isReport', () => {
  it('recognises what audit writes and nothing else', () => {
    expect(isReport(report())).toBe(true);
    expect(isReport({ pages: [] })).toBe(false);
    expect(isReport(null)).toBe(false);
  });
});
