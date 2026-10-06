/**
 * Explee's auto-GTM API, for the one thing its app cannot do: add more of your
 * own leads to a project after the first CSV.
 *
 * Explee has no "import into this campaign". Every import, in the app or over
 * the API, creates a new campaign. So "upload another CSV" becomes: read the
 * existing campaign's brief, create a new campaign in the same project with the
 * same brief and the new leads, and wait for Explee to finish. Explee drops
 * anyone the project has already contacted, so a CSV that overlaps the first
 * one is safe to send.
 *
 * Network access is injectable so the tests never touch it.
 */

import { parseCsv } from './user-export.ts';

export const EXPLEE_API = 'https://api.explee.com';
const BASE = '/public/api/v1/autogtm';

export class ExpleeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpleeError';
  }
}

export interface Lead {
  email: string;
  first_name: string;
  last_name: string;
  company_domain: string;
  job_title: string;
  linkedin_url?: string;
  company_name?: string;
}

/** The fields of a campaign that make up its copy brief. */
export interface Brief {
  instructions?: string | null;
  followup_instructions?: string | null;
  language?: string | null;
}

export interface Campaign extends Brief {
  id: number;
  project_id: number;
  name: string;
  status?: string;
}

export interface ImportResult {
  campaign_id: number;
  project_id: number;
  name: string;
  leads_total: number;
  leads_imported: number;
  deduped: number;
  enriched_from_base: number;
  skipped_missing: number;
  skipped_invalid_email: number;
  flagged_freemail: number;
  skipped?: unknown;
}

export interface ImportStatus {
  status: string;
  error: string | null;
  progress: { stage: string; done: number; total: number } | null;
  result: ImportResult | null;
}

export const REQUIRED = ['email', 'first_name', 'last_name', 'company_domain', 'job_title'] as const;
const OPTIONAL = ['linkedin_url', 'company_name'] as const;

export interface LeadsFromCsv {
  leads: Lead[];
  /** Rows Explee would skip anyway, with the required columns they lack. */
  missing: { row: number; email: string; missing: string[] }[];
}

/** Leads out of a CSV with a header row, by column name (case-insensitive). */
export function leadsFromCsv(text: string): LeadsFromCsv {
  const [header, ...records] = parseCsv(text.replace(/^﻿/, ''));
  if (!header) throw new ExpleeError('the CSV is empty');
  const index = new Map(header.map((h, i) => [h.trim().toLowerCase(), i]));
  const absent = REQUIRED.filter((c) => !index.has(c));
  if (absent.length) throw new ExpleeError(`the CSV has no ${absent.join(', ')} column${absent.length > 1 ? 's' : ''}`);

  const out: LeadsFromCsv = { leads: [], missing: [] };
  const seen = new Set<string>();
  records.forEach((values, n) => {
    const get = (c: string) => (index.has(c) ? (values[index.get(c)!] ?? '').trim() : '');
    const email = get('email').toLowerCase();
    const gaps = REQUIRED.filter((c) => !get(c));
    if (gaps.length) {
      out.missing.push({ row: n + 2, email, missing: [...gaps] });
      return;
    }
    if (seen.has(email)) return;
    seen.add(email);
    const lead: Lead = {
      email,
      first_name: get('first_name'),
      last_name: get('last_name'),
      company_domain: get('company_domain'),
      job_title: get('job_title'),
    };
    for (const c of OPTIONAL) if (get(c)) lead[c] = get(c);
    out.leads.push(lead);
  });
  return out;
}

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export function client(apiKey: string, { api = EXPLEE_API, fetchImpl = fetch as unknown as Fetch } = {}) {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetchImpl(`${api}${BASE}${path}`, {
      method,
      headers: { 'X-API-Key': apiKey, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new ExpleeError(`Explee ${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : null) as T;
  };
  return {
    projects: () => call<unknown>('GET', '/projects'),
    campaigns: (projectId?: number) => call<unknown>('GET', `/campaigns${projectId ? `?project_id=${projectId}` : ''}`),
    campaign: (id: number) => call<Campaign>('GET', `/campaigns/${id}`),
    startImport: (payload: { project_id: number; name: string; leads: Lead[] } & Brief) =>
      call<{ task_id: string }>('POST', '/campaigns/import', payload),
    importStatus: (taskId: string) => call<ImportStatus>('GET', `/campaigns/import/${encodeURIComponent(taskId)}`),
  };
}

export type ExpleeClient = ReturnType<typeof client>;

/** Only the brief fields that are set; Explee falls back to the project description for the rest. */
export function briefOf(campaign: Brief): Brief {
  const brief: Brief = {};
  if (campaign.instructions) brief.instructions = campaign.instructions;
  if (campaign.followup_instructions) brief.followup_instructions = campaign.followup_instructions;
  if (campaign.language) brief.language = campaign.language;
  return brief;
}

/** Poll an import until it completes or fails. */
export async function waitForImport(
  explee: Pick<ExpleeClient, 'importStatus'>,
  taskId: string,
  { intervalMs = 3000, timeoutMs = 15 * 60_000, onProgress = (_s: ImportStatus) => {} } = {},
): Promise<ImportStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await explee.importStatus(taskId);
    onProgress(status);
    if (status.status === 'completed' || status.status === 'failed' || status.error) return status;
    if (Date.now() > deadline) throw new ExpleeError(`import ${taskId} still ${status.status} after ${timeoutMs / 60_000} min`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export function formatResult(r: ImportResult): string {
  return [
    `campaign ${r.campaign_id} "${r.name}" in project ${r.project_id}`,
    `  ${r.leads_imported} of ${r.leads_total} leads imported`,
    `  ${r.deduped} already contacted in this project (dropped)`,
    `  ${r.skipped_missing} missing a required column, ${r.skipped_invalid_email} invalid email`,
    `  ${r.flagged_freemail} on a free mail domain (flagged), ${r.enriched_from_base} enriched from Explee's base`,
  ].join('\n');
}
