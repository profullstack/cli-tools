import { describe, expect, it } from 'vitest';

import {
  CA_VENDORS,
  EntityError,
  daysUntil,
  deadlines,
  federalObligations,
  filingWindow,
  siDraft,
  switchPlan,
  templateProfile,
  validateProfile,
  type Profile,
} from '../src/entity.ts';

// Made-up company: this repository is public.
function profile(over: Partial<Profile> = {}): Profile {
  return {
    name: 'Example, Inc.',
    state: 'CA',
    kind: 'corporation',
    formed: '2018-12',
    agent: { name: 'Old Agent, Inc.', corporate: true },
    newAgent: { name: 'California Corporate Agents, Inc.', corporate: true },
    notifyEmail: 'bot@example.com',
    subscriptions: [
      {
        vendor: 'OldCo',
        service: 'Registered Agent',
        pricePerYear: 499,
        renews: '2026-11-05',
        kind: 'agent',
        status: 'active',
        cancel: { phone: '(800) 555-0100' },
      },
      {
        vendor: 'OldCo',
        service: 'Compliance Filings',
        pricePerYear: 299,
        renews: '2026-10-07',
        kind: 'compliance',
        status: 'active',
        cancel: { url: 'https://example.com/subscriptions' },
      },
    ],
    ...over,
  };
}

describe('filingWindow', () => {
  it('is the six months ending with the formation month, every year for a corporation', () => {
    expect(filingWindow(profile(), '2026-10-06')).toEqual({ opens: '2026-07-01', closes: '2026-12-31', form: 'SI-550', fee: 25 });
    // The day after it closes, the next one is reported.
    expect(filingWindow(profile(), '2027-01-01').closes).toBe('2027-12-31');
  });

  it('crosses a year boundary for an early formation month', () => {
    const w = filingWindow(profile({ formed: '2020-03' }), '2026-02-10');
    expect(w).toMatchObject({ opens: '2025-10-01', closes: '2026-03-31' });
  });

  it('is every other year for an LLC, in years of the formation parity', () => {
    const llc = profile({ kind: 'llc', formed: '2019-05' });
    expect(filingWindow(llc, '2026-06-01')).toMatchObject({ closes: '2027-05-31', form: 'LLC-12', fee: 20 });
    expect(filingWindow(llc, '2025-04-01')).toMatchObject({ opens: '2024-12-01', closes: '2025-05-31' });
  });

  it('refuses a state it does not model rather than guessing', () => {
    expect(() => filingWindow(profile({ state: 'DE' }), '2026-10-06')).toThrow(EntityError);
  });
});

describe('deadlines', () => {
  it('lists cancel-before dates and the state filing, soonest first', () => {
    const list = deadlines(profile(), '2026-10-06');
    expect(list.map((d) => d.date)).toEqual(['2026-10-07', '2026-11-05', '2026-12-31']);
    expect(list[0]).toMatchObject({ days: 1, scope: 'vendor' });
    expect(list[1]!.what).toContain('only after the new agent is on file');
    expect(list[2]!.what).toContain('window open now');
  });

  it('drops cancelled subscriptions', () => {
    const p = profile();
    p.subscriptions[1]!.status = 'cancelled';
    expect(deadlines(p, '2026-10-06').some((d) => d.what.includes('Compliance'))).toBe(false);
  });

  it('counts days across a month', () => {
    expect(daysUntil('2026-11-05', '2026-10-06')).toBe(30);
  });
});

describe('switchPlan', () => {
  it('never lets the old agent go before the new one is on the record', () => {
    const ids = switchPlan(profile(), '2026-10-06').map((s) => s.id);
    expect(ids[0]).toBe('cancel-oldco-compliance-filings');
    expect(ids.indexOf('file-si')).toBeLessThan(ids.indexOf('cancel-oldco-agent'));
    expect(ids.indexOf('save-si-pdf')).toBeLessThan(ids.indexOf('cancel-oldco-agent'));
  });

  it('dates the steps off the renewals', () => {
    const steps = switchPlan(profile(), '2026-10-06');
    expect(steps.find((s) => s.id === 'cancel-oldco-compliance-filings')!.dueBy).toBe('2026-10-06');
    expect(steps.find((s) => s.id === 'file-si')!.dueBy).toBe('2026-10-29');
    expect(steps.find((s) => s.id === 'cancel-oldco-agent')!.dueBy).toBe('2026-11-04');
  });

  it('links the known vendor and routes scans to the notify address', () => {
    const signup = switchPlan(profile(), '2026-10-06').find((s) => s.id === 'signup-agent')!;
    expect(signup.how.join('\n')).toContain('cacorporateagents.com/order-now');
    expect(signup.how.join('\n')).toContain('bot@example.com');
  });

  it('says the filing doubles as the annual one inside the window, and is free outside it', () => {
    const inside = switchPlan(profile(), '2026-10-06').find((s) => s.id === 'file-si')!;
    expect(inside.how.join(' ')).toContain('$25');
    const outside = switchPlan(profile({ formed: '2018-06' }), '2026-10-06').find((s) => s.id === 'file-si')!;
    expect(outside.how.join(' ')).toContain('free');
  });

  it('needs a new agent', () => {
    const p = profile();
    delete p.newAgent;
    expect(() => switchPlan(p, '2026-10-06')).toThrow(/newAgent/);
  });
});

describe('siDraft', () => {
  it('names a corporate agent without an address and flags what is missing', () => {
    const rows = siDraft(profile());
    const agent = rows.find((r) => r.field.startsWith('Agent'))!;
    expect(agent).toMatchObject({ value: 'California Corporate Agents, Inc.', missing: false });
    expect(rows.some((r) => r.field.includes('street address'))).toBe(false);
    expect(rows.find((r) => r.field === 'Chief Executive Officer')!.missing).toBe(true);
  });

  it('asks for a street address when the agent is a person', () => {
    const rows = siDraft(profile(), { name: 'Pat Doe', corporate: false });
    expect(rows.find((r) => r.field === 'Agent street address in CA')!.missing).toBe(true);
  });
});

describe('profile', () => {
  it('accepts the template', () => {
    expect(validateProfile(templateProfile()).state).toBe('CA');
  });

  it('rejects a malformed renewal date instead of hiding a deadline', () => {
    const p = profile();
    p.subscriptions[0]!.renews = '11/05/2026';
    expect(() => validateProfile(p)).toThrow(/renews must be YYYY-MM-DD/);
  });
});

describe('federal and vendors', () => {
  it('says there is no federal registered agent and carries no amounts', () => {
    const fed = federalObligations(profile());
    expect(fed[0]!.applies).toContain('no federal requirement');
    expect(JSON.stringify(fed)).not.toMatch(/\$\d/);
  });

  it('keeps a source for every vendor price', () => {
    for (const v of CA_VENDORS) expect(v.source).toMatch(/^https:\/\//);
  });
});
