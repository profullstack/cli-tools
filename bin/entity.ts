#!/usr/bin/env node
/**
 * entity — keep a company in good standing, state and federal: its registered
 * agent, its compliance vendors and their renewals, the annual state filing,
 * and the steps for moving to a cheaper agent.
 *
 *   entity init                  # writes a profile template to fill in
 *   entity                       # status: agent, deadlines, switch progress
 *   entity si-draft              # the Statement of Information values to paste
 *
 * It plans, drafts and keeps dates. It never signs up, pays, cancels or files:
 * those stay with the owner.
 */

import { existsSync } from 'node:fs';

import { UsageError, parseArgs } from '../src/args.ts';
import {
  CA_VENDORS,
  EntityError,
  VENDORS_CHECKED,
  deadlines,
  federalObligations,
  filingWindow,
  profilePath,
  readProfile,
  readState,
  siDraft,
  statePath,
  switchPlan,
  templateProfile,
  writeJson,
  type Profile,
  type State,
} from '../src/entity.ts';
import { table } from '../src/format.ts';
import { isMain } from '../src/is-main.ts';

export const USAGE = `Usage:
  entity [status]              agent, renewals, filing window, switch progress
  entity deadlines             everything with a date, soonest first (state, federal, vendor)
  entity vendors               California registered agents, cheapest first
  entity federal               what applies federally, and what does not
  entity plan                  the steps for moving to profile.newAgent, in order
  entity done <step>           mark a step done (entity undo <step> reverses it)
  entity si-draft              Statement of Information values to paste into bizfile
  entity init                  write a profile template (never overwrites)

Options:
      --profile PATH   profile file (default: ~/.config/cli-tools/entity.json)
      --today DATE     pretend today is YYYY-MM-DD
      --json           machine-readable output, for agents and scripts
  -h, --help           show this help

The profile holds the company's facts and its subscriptions; it stays on this
machine. entity never logs in anywhere, never pays, cancels or files. Signing
the state's declaration and paying are the owner's to do.
`;

const VERBS = new Set(['status', 'deadlines', 'vendors', 'federal', 'plan', 'done', 'undo', 'si-draft', 'init']);

function today(values: Map<string, string>): string {
  const given = values.get('--today');
  if (given) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(given)) throw new UsageError('--today must be YYYY-MM-DD');
    return given;
  }
  return new Date().toISOString().slice(0, 10);
}

function when(days: number): string {
  if (days < 0) return `${-days}d ago`;
  if (days === 0) return 'TODAY';
  return `in ${days}d`;
}

function status(profile: Profile, state: State, now: string): string {
  const lines: string[] = [];
  lines.push(`${profile.name} (${profile.state} ${profile.kind}, formed ${profile.formed})`);
  lines.push(`agent: ${profile.agent.name}${profile.newAgent ? `  →  moving to ${profile.newAgent.name}` : ''}`);
  const spend = profile.subscriptions.filter((s) => s.status === 'active').reduce((sum, s) => sum + s.pricePerYear, 0);
  lines.push(`active compliance spend: $${spend}/yr`);
  lines.push('');
  lines.push(table(deadlines(profile, now).map((d) => [d.date, when(d.days), d.what])));
  if (profile.newAgent) {
    const steps = switchPlan(profile, now);
    const done = steps.filter((s) => state.done[s.id]).length;
    lines.push('');
    lines.push(`switch: ${done}/${steps.length} steps done`);
    const next = steps.find((s) => !state.done[s.id]);
    if (next) lines.push(`next: ${next.title}${next.dueBy ? ` (by ${next.dueBy})` : ''}  [entity plan]`);
  }
  return `${lines.join('\n')}\n`;
}

function plan(profile: Profile, state: State, now: string): string {
  const out: string[] = [];
  for (const [i, s] of switchPlan(profile, now).entries()) {
    const mark = state.done[s.id] ? `[x] ${state.done[s.id]!.slice(0, 10)}` : '[ ]';
    out.push(`${i + 1}. ${mark} ${s.title}${s.dueBy ? `  (by ${s.dueBy})` : ''}`);
    out.push(`   id: ${s.id}`);
    for (const h of s.how) out.push(`   - ${h}`);
  }
  return `${out.join('\n')}\n`;
}

if (isMain(import.meta.url)) {
  try {
    const { flags, values, positional } = parseArgs(process.argv.slice(2), {
      boolean: ['-h', '--help', '--json'],
      string: ['--profile', '--today'],
    });
    if (flags.has('-h') || flags.has('--help')) {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    const verb = (positional[0] ?? 'status').toLowerCase();
    if (!VERBS.has(verb)) throw new UsageError(`unknown verb "${verb}" — see entity --help`);
    const json = flags.has('--json');
    const print = (data: unknown, text: string): void => {
      process.stdout.write(json ? `${JSON.stringify(data, null, 2)}\n` : text);
    };
    const path = values.get('--profile') ?? profilePath();
    const now = today(values);

    if (verb === 'init') {
      if (existsSync(path)) throw new UsageError(`${path} already exists — edit it instead`);
      writeJson(path, templateProfile());
      process.stderr.write(`wrote ${path} — fill in the company, agent and subscriptions\n`);
      process.exit(0);
    }

    if (verb === 'vendors') {
      const rows = [...CA_VENDORS].sort((a, b) => a.renewal - b.renewal);
      print(
        { checked: VENDORS_CHECKED, vendors: rows },
        `${table([
          ['vendor', '1st yr', 'renewal', 'annual filing', 'api', 'signup'],
          ...rows.map((v) => [v.name, `$${v.firstYear}`, `$${v.renewal}`, v.filesAnnualReport, v.api, v.signup]),
        ])}\nprices as published ${VENDORS_CHECKED}; none advertises crypto or PayPal or names its card processor\n`,
      );
      process.exit(0);
    }

    const profile = readProfile(path);
    const sPath = statePath();
    const state = readState(sPath);

    if (verb === 'status') {
      print(
        { profile: profile.name, agent: profile.agent, newAgent: profile.newAgent ?? null, deadlines: deadlines(profile, now), done: state.done },
        status(profile, state, now),
      );
    } else if (verb === 'deadlines') {
      const fed = federalObligations(profile);
      const list = deadlines(profile, now);
      print(
        { deadlines: list, federal: fed },
        `${table([['date', 'when', 'scope', 'what', 'if nothing is done'], ...list.map((d) => [d.date, when(d.days), d.scope, d.what, d.consequence])])}\n`,
      );
    } else if (verb === 'federal') {
      const fed = federalObligations(profile);
      print(fed, fed.map((o) => `${o.item}\n  applies: ${o.applies}\n  action:  ${o.action}\n  source:  ${o.source}`).join('\n\n') + '\n');
    } else if (verb === 'plan') {
      print({ steps: switchPlan(profile, now), done: state.done }, plan(profile, state, now));
    } else if (verb === 'done' || verb === 'undo') {
      const id = positional[1];
      const ids = switchPlan(profile, now).map((s) => s.id);
      if (!id || !ids.includes(id)) throw new UsageError(`which step? one of: ${ids.join(', ')}`);
      if (verb === 'done') state.done[id] = new Date().toISOString();
      else delete state.done[id];
      writeJson(sPath, state);
      process.stdout.write(plan(profile, state, now));
    } else if (verb === 'si-draft') {
      const rows = siDraft(profile);
      const w = profile.state === 'CA' ? filingWindow(profile, now) : null;
      const missing = rows.filter((r) => r.missing).length;
      print(
        { form: w?.form, window: w, fields: rows },
        `${table(rows.map((r) => [r.field, r.missing ? '<fill in>' : r.value]))}\n` +
          (w ? `\n${w.form}, $${w.fee} in the window ${w.opens} to ${w.closes} (an agent-only change outside it is free)\n` : '') +
          (missing ? `${missing} field(s) missing from the profile; nothing is guessed\n` : '') +
          'bizfile: https://bizfileonline.sos.ca.gov — an officer reviews and signs the declaration\n',
      );
    }
  } catch (error) {
    if (error instanceof UsageError || error instanceof EntityError) {
      process.stderr.write(`entity: ${error.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`entity: ${error instanceof Error ? error.message : error}\n`);
    process.exit(2);
  }
}
