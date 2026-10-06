import { describe, expect, it } from 'vitest';

import { ExpleeError, briefOf, client, formatResult, leadsFromCsv, waitForImport, type ImportStatus } from '../src/explee.ts';

const csv = [
  'email,first_name,last_name,company_domain,job_title,linkedin_url',
  'Ada@Acme.com,Ada,Lovelace,acme.com,CTO,https://www.linkedin.com/in/ada',
  'bob@acme.com,Bob,,acme.com,CEO,',
  'ada@acme.com,Ada,Lovelace,acme.com,CTO,',
  '"cy@x.io",Cy,"Lee, Jr",x.io,"Head of Sales, EMEA",',
].join('\n');

describe('leadsFromCsv', () => {
  it('maps columns by name, reports rows Explee would skip, dedupes', () => {
    const r = leadsFromCsv(`﻿${csv}`);
    expect(r.leads).toEqual([
      { email: 'ada@acme.com', first_name: 'Ada', last_name: 'Lovelace', company_domain: 'acme.com', job_title: 'CTO', linkedin_url: 'https://www.linkedin.com/in/ada' },
      { email: 'cy@x.io', first_name: 'Cy', last_name: 'Lee, Jr', company_domain: 'x.io', job_title: 'Head of Sales, EMEA' },
    ]);
    expect(r.missing).toEqual([{ row: 3, email: 'bob@acme.com', missing: ['last_name'] }]);
  });

  it('refuses a CSV without the required columns', () => {
    expect(() => leadsFromCsv('email,name\na@b.com,A')).toThrow(/no first_name, last_name, company_domain, job_title columns/);
  });
});

describe('briefOf', () => {
  it('copies only the brief fields that are set', () => {
    expect(briefOf({ instructions: 'Pitch X', followup_instructions: null, language: 'en-US' })).toEqual({ instructions: 'Pitch X', language: 'en-US' });
  });
});

describe('client', () => {
  it('sends the key and the import payload, and surfaces HTTP errors', async () => {
    const calls: { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } }[] = [];
    const explee = client('k', {
      api: 'https://x',
      fetchImpl: async (url, init = {}) => {
        calls.push({ url, init });
        if (url.endsWith('/campaigns/9')) return { ok: false, status: 404, text: async () => 'nope' };
        return { ok: true, status: 200, text: async () => '{"task_id":"t1"}' };
      },
    });
    expect(await explee.startImport({ project_id: 1, name: 'n', leads: [], instructions: 'i' })).toEqual({ task_id: 't1' });
    expect(calls[0]!.url).toBe('https://x/public/api/v1/autogtm/campaigns/import');
    expect(calls[0]!.init.headers!['X-API-Key']).toBe('k');
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({ project_id: 1, name: 'n', leads: [], instructions: 'i' });
    await expect(explee.campaign(9)).rejects.toThrow(/HTTP 404 nope/);
  });
});

describe('waitForImport', () => {
  it('polls until completed', async () => {
    const result = { campaign_id: 5, project_id: 1, name: 'n', leads_total: 3, leads_imported: 2, deduped: 1, enriched_from_base: 0, skipped_missing: 0, skipped_invalid_email: 0, flagged_freemail: 0 };
    const states: ImportStatus[] = [
      { status: 'running', error: null, progress: { stage: 'enrich', done: 1, total: 3 }, result: null },
      { status: 'completed', error: null, progress: null, result },
    ];
    const seen: string[] = [];
    const done = await waitForImport({ importStatus: async () => states.shift()! }, 't', { intervalMs: 0, onProgress: (s) => seen.push(s.status) });
    expect(done.result).toEqual(result);
    expect(seen).toEqual(['running', 'completed']);
    expect(formatResult(result)).toContain('2 of 3 leads imported');
  });

  it('gives up after the timeout', async () => {
    const running: ImportStatus = { status: 'running', error: null, progress: null, result: null };
    await expect(waitForImport({ importStatus: async () => running }, 't', { intervalMs: 0, timeoutMs: -1 })).rejects.toBeInstanceOf(ExpleeError);
  });
});
