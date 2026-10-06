import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DAILY_CAP,
  type Element,
  type Ledger,
  type Site,
  classify,
  loadCatalog,
  newsletterLink,
  notDue,
  pickEmailField,
  pickSubmitButton,
  planRun,
  record,
  subscribe,
} from '../src/dealsubs.ts';

const el = (ref: string, role: string, name: string, extra: Partial<Element> = {}): Element => ({ ref, role, name, required: false, value: '', ...extra });
const sites: Site[] = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id, url: `https://${id}.example/`, kind: 'deals' }));
const now = new Date('2026-10-06T12:00:00Z');

describe('dealsubs catalog', () => {
  it('ships a valid catalog with unique ids', () => {
    const catalog = loadCatalog(join(import.meta.dirname, '..', 'data', 'deal-newsletters.json'));
    expect(catalog.length).toBeGreaterThan(20);
    for (const s of catalog) expect(s.url).toMatch(/^https:\/\//);
  });
});

describe('dealsubs throttling', () => {
  it('plans due sites in order, within the run size', () => {
    const ledger: Ledger = { email: null, sites: {} };
    expect(planRun(sites, ledger, now, 2).map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('never retries a subscribed or CAPTCHA site, waits a week, and stops after two attempts', () => {
    const ledger: Ledger = { email: null, sites: {} };
    record(ledger, sites[0]!, 'subscribed', '', new Date('2026-09-01T00:00:00Z'));
    record(ledger, sites[1]!, 'captcha', '', new Date('2026-09-01T00:00:00Z'));
    record(ledger, sites[2]!, 'no-form', '', new Date('2026-10-04T00:00:00Z'));
    record(ledger, sites[3]!, 'error', '', new Date('2026-09-01T00:00:00Z'));
    record(ledger, sites[3]!, 'error', '', new Date('2026-09-10T00:00:00Z'));
    expect(notDue(ledger.sites.a, now)).toMatch(/subscribed/);
    expect(notDue(ledger.sites.b, now)).toMatch(/CAPTCHA/);
    expect(notDue(ledger.sites.c, now)).toMatch(/week/);
    expect(notDue(ledger.sites.d, now)).toMatch(/gave up/);
    expect(planRun(sites, ledger, now, 4)).toEqual([]);
    // A week later the no-form site is due again.
    expect(planRun(sites, ledger, new Date('2026-10-12T00:00:00Z'), 4).map((s) => s.id)).toEqual(['c']);
  });

  it('respects the daily cap across runs', () => {
    const many: Site[] = Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, name: '', url: 'https://x.example/', kind: 'deals' }));
    const ledger: Ledger = { email: null, sites: {} };
    for (const s of many.slice(0, DAILY_CAP - 1)) record(ledger, s, 'submitted', '', now);
    expect(planRun(many, ledger, now, 5)).toHaveLength(1);
  });
});

describe('dealsubs page reading', () => {
  it('prefers a newsletter email box over a login one, and skips search boxes', () => {
    const els = [el('@e1', 'searchbox', 'Search deals'), el('@e2', 'textbox', 'Email'), el('@e9', 'textbox', 'Email address for newsletter')];
    expect(pickEmailField(els)?.ref).toBe('@e9');
    expect(pickEmailField([el('@e1', 'textbox', 'Search')])).toBeNull();
  });

  it('picks the subscribe button after the field, never a deal tile or a login', () => {
    const field = el('@e5', 'textbox', 'Email');
    const els = [
      el('@e1', 'button', 'Sign In'),
      el('@e4', 'link', '15% Off Your First Order When You Join MAC Lover Loyalty Program'),
      field,
      el('@e6', 'button', 'Subscribe'),
    ];
    expect(pickSubmitButton(els, field)?.ref).toBe('@e6');
    expect(pickSubmitButton([el('@e4', 'link', '15% Off When You Join The Club Today Only'), field], field)).toBeNull();
  });

  it('classifies the page after submitting', () => {
    expect(classify('Thanks for subscribing!').status).toBe('subscribed');
    expect(classify('Please check your inbox to confirm').status).toBe('subscribed');
    expect(classify('You are already subscribed').status).toBe('subscribed');
    expect(classify('Please complete the reCAPTCHA').status).toBe('captcha');
    expect(classify('Hot deals today').status).toBe('submitted');
  });

  it('follows a same-site newsletter link, ranked over a store feature page', () => {
    const snap = [
      '@e1 link "Wayfair Email Sign Up" -> https://www.dealnews.com/features/wayfair/email-sign-up/',
      '@e2 link "Subscribe to our RSS feed" -> https://www.dealnews.com/pages/rss.html',
      '@e3 link "Email Alerts" -> https://www.dealnews.com/alerts/',
      '@e4 link "Newsletter" -> https://other.example/newsletter',
    ].join('\n');
    expect(newsletterLink(snap, 'https://www.dealnews.com/')).toBe('https://www.dealnews.com/alerts/');
  });
});

describe('dealsubs subscribe', () => {
  function fakeBrowser(pages: Record<string, { snapshot: string; text: string }>, afterSubmit: string) {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    let current = '';
    let submitted = false;
    return {
      calls,
      browser: {
        async call(name: string, args?: Record<string, unknown>) {
          calls.push([name, args]);
          if (name === 'browser_open') current = String(args?.url);
          if (name === 'browser_click' || name === 'browser_press') submitted = true;
          if (name === 'browser_snapshot') return pages[current]!.snapshot;
          if (name === 'browser_extract') return submitted ? afterSubmit : pages[current]!.text;
          return '';
        },
      },
    };
  }

  it('fills, clicks and reads the thank-you', async () => {
    const { browser, calls } = fakeBrowser(
      { 'https://a.example/': { snapshot: '@e1 textbox "Your email"\n@e2 button "Subscribe"', text: 'Deals' } },
      'Thank you for subscribing',
    );
    const r = await subscribe(browser, { id: 'a', name: 'A', url: 'https://a.example/', kind: 'deals' }, 'submit@c0upons.com');
    expect(r.status).toBe('subscribed');
    expect(calls).toContainEqual(['browser_fill', { ref: '@e1', value: 'submit@c0upons.com' }]);
    expect(calls).toContainEqual(['browser_click', { ref: '@e2' }]);
  });

  it('probe mode never types or clicks', async () => {
    const { browser, calls } = fakeBrowser(
      { 'https://a.example/': { snapshot: '@e1 textbox "Email"\n@e2 button "Sign up"', text: 'Deals' } },
      'Thank you',
    );
    const r = await subscribe(browser, { id: 'a', name: 'A', url: 'https://a.example/', kind: 'deals' }, 'x@y.z', { submit: false });
    expect(r.note).toMatch(/probe/);
    expect(calls.some(([n]) => n === 'browser_fill' || n === 'browser_click' || n === 'browser_press')).toBe(false);
  });

  it('reports a Cloudflare wall instead of guessing', async () => {
    const { browser } = fakeBrowser({ 'https://a.example/': { snapshot: '', text: 'Just a moment... Performing security verification' } }, '');
    const r = await subscribe(browser, { id: 'a', name: 'A', url: 'https://a.example/', kind: 'deals' }, 'x@y.z');
    expect(r).toEqual({ status: 'error', note: 'Cloudflare interstitial did not clear' });
  });
});
