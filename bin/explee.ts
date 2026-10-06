#!/usr/bin/env node
/**
 * explee — add more of your own leads to an Explee project.
 *
 *   explee import more.csv --project 38837 --brief-from 222092
 *   explee campaigns --project 38837
 *   explee status <task_id>
 *
 * Explee's app takes a CSV once, when a campaign is made. Every later import
 * creates a new campaign, so this copies the brief of the campaign you name
 * into the new one and lets Explee drop anyone the project already contacted.
 * src/explee.ts has the rest.
 */

import { readFileSync } from 'node:fs';

import { UsageError, parseArgs } from '../src/args.ts';
import { isMain } from '../src/is-main.ts';
import { ExpleeError, briefOf, client, formatResult, leadsFromCsv, waitForImport } from '../src/explee.ts';
import { secretResolver } from '../src/user-export.ts';

const USAGE = `Usage:
  explee import FILE.csv --project ID [--brief-from CAMPAIGN_ID] [--name NAME] [--no-wait] [--dry-run]
  explee campaigns [--project ID]
  explee status TASK_ID

import   creates a new campaign in the project from your CSV (Explee has no
         "add to this campaign"; every import is a new campaign). Columns by
         name: email, first_name, last_name, company_domain, job_title
         (required by Explee, rows without them are reported and left out),
         linkedin_url and company_name (optional). user-export --format explee
         writes exactly this. --brief-from copies that campaign's first-email
         brief, follow-up brief and language, so the new leads get the same
         pitch. Leads the project already contacted are dropped by Explee.
         Waits for the import and prints what Explee kept and skipped.

Options:
      --project ID        project to import into (from the app URL: /p/<ID>/)
      --brief-from ID     campaign whose brief to copy (the app URL's segments/<ID>)
      --name NAME         campaign name (default: "<brief campaign> + YYYY-MM-DD")
      --no-wait           print the task id and return
      --dry-run           parse and check the CSV, send nothing
      --json              machine-readable output
  -h, --help

The API key comes from $EXPLEE_API_KEY, or from a secret reference in
$EXPLEE_API_KEY_REF (env:NAME, vault:<team>/<project>/<env>/<KEY>, cmd:<shell>).
Create one at https://explee.com/app-auto-gtm/api-keys. Importing is free;
sending is billed by Explee as usual.
`;

const id = (value: string | undefined, flag: string): number | undefined => {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new UsageError(`${flag} takes a number`);
  return Number(value);
};

if (isMain(import.meta.url)) {
  try {
    const { flags, values, positional } = parseArgs(process.argv.slice(2), {
      boolean: ['-h', '--help', '--no-wait', '--dry-run', '--json'],
      string: ['--project', '--brief-from', '--name'],
    });
    const [command, arg] = positional;
    if (!command || flags.has('-h') || flags.has('--help')) {
      process.stdout.write(USAGE);
      process.exit(command ? 0 : 1);
    }
    const json = flags.has('--json');
    const print = (value: unknown, text: string) => process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${text}\n`);
    const apiKey = () => {
      const ref = process.env.EXPLEE_API_KEY_REF || 'env:EXPLEE_API_KEY';
      return secretResolver(process.env)(ref, 'Explee API key');
    };

    if (command === 'import') {
      if (!arg) throw new UsageError('import needs a CSV file');
      const project = id(values.get('--project'), '--project');
      if (!project) throw new UsageError('import needs --project ID (the number after /p/ in the app URL)');
      const { leads, missing } = leadsFromCsv(readFileSync(arg, 'utf8'));
      for (const m of missing) process.stderr.write(`row ${m.row} ${m.email || '(no email)'}: no ${m.missing.join(', ')}\n`);
      process.stderr.write(`${leads.length} leads ready, ${missing.length} rows left out for a missing required column\n`);
      if (leads.length === 0) throw new ExpleeError('no importable leads in the CSV');
      if (leads.length > 30_000) throw new ExpleeError(`Explee takes at most 30,000 leads per import, the CSV has ${leads.length}`);
      if (flags.has('--dry-run')) process.exit(0);

      const explee = client(apiKey());
      const from = id(values.get('--brief-from'), '--brief-from');
      const source = from ? await explee.campaign(from) : undefined;
      if (source && source.project_id !== project) {
        throw new UsageError(`campaign ${from} is in project ${source.project_id}, not ${project}`);
      }
      const name = values.get('--name') || `${source?.name ?? 'Import'} + ${new Date().toISOString().slice(0, 10)}`;
      const { task_id } = await explee.startImport({ project_id: project, name, leads, ...(source ? briefOf(source) : {}) });
      process.stderr.write(`import started: task ${task_id}${source ? `, brief copied from campaign ${from}` : ''}\n`);
      if (flags.has('--no-wait')) {
        print({ task_id }, task_id);
        process.exit(0);
      }
      const status = await waitForImport(explee, task_id, {
        onProgress: (s) => s.progress && !json && process.stderr.write(`  ${s.progress.stage} ${s.progress.done}/${s.progress.total}\n`),
      });
      if (!status.result) throw new ExpleeError(`import ${task_id} ${status.status}: ${status.error ?? 'no result'}`);
      print(status.result, formatResult(status.result));
    } else if (command === 'campaigns') {
      const result = await client(apiKey()).campaigns(id(values.get('--project'), '--project'));
      print(result, JSON.stringify(result, null, 2));
    } else if (command === 'status') {
      if (!arg) throw new UsageError('status needs a task id');
      const status = await client(apiKey()).importStatus(arg);
      print(status, status.result ? formatResult(status.result) : `${status.status}${status.error ? `: ${status.error}` : ''}`);
    } else {
      throw new UsageError(`unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError || error instanceof ExpleeError) {
      process.stderr.write(`explee: ${error.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`explee: ${error instanceof Error ? error.message : error}\n`);
    process.exit(2);
  }
}
