import { describe, expect, it } from 'vitest';

import { emptyProfile, parseAssignment, setProfileField } from '../src/jobs-config.ts';
import {
  extractCode,
  mailAccountFor,
  parseSnapshot,
  planForm,
  rulesFor,
  subjectMatchesCompany,
  waitForCode,
} from '../src/jobs-apply.ts';

const profile = () => {
  let p = emptyProfile();
  for (const text of [
    'firstName=Ada', 'lastName=Lovelace', 'email=ada@example.com', 'phone=555-0100',
    'answers.sponsorship=No', 'answers.workAuthorized=Yes', 'answers.heardFrom=Company website',
  ]) p = setProfileField(p, parseAssignment(text));
  return { ...p, resume: '/docs/cv.pdf' };
};

describe('parseSnapshot', () => {
  it('reads refs, roles, labels, required and values', () => {
    const elements = parseSnapshot([
      '@e1 textbox "First Name" [required]',
      '@e2 textbox "Email" = "a@b.c"',
      '@e3 combobox "Are you \\"authorized\\" to work?" [required]',
      'heading "Apply"',
    ].join('\n'));
    expect(elements).toEqual([
      { ref: '@e1', role: 'textbox', name: 'First Name', required: true, value: '' },
      { ref: '@e2', role: 'textbox', name: 'Email', required: false, value: 'a@b.c' },
      { ref: '@e3', role: 'combobox', name: 'Are you "authorized" to work?', required: true, value: '' },
    ]);
  });
});

describe('planForm', () => {
  const plan = (snapshot: string, p = profile(), why = '') =>
    planForm(parseSnapshot(snapshot), rulesFor(p, why), p.answers.heardFrom);

  it('fills, selects and uploads from the profile, and leaves filled fields alone', () => {
    const result = plan([
      '@e1 textbox "First Name" [required]',
      '@e2 textbox "Last Name" [required]',
      '@e3 textbox "Email" [required] = "already@there"',
      '@e4 file "Resume/CV" [required]',
      '@e5 combobox "Will you now or in the future require visa sponsorship?" [required]',
    ].join('\n'));
    expect(result.unknown).toEqual([]);
    expect(result.actions).toEqual([
      { ref: '@e1', label: 'First Name', kind: 'fill', value: 'Ada' },
      { ref: '@e2', label: 'Last Name', kind: 'fill', value: 'Lovelace' },
      { ref: '@e4', label: 'Resume/CV', kind: 'upload', value: '/docs/cv.pdf' },
      { ref: '@e5', label: 'Will you now or in the future require visa sponsorship?', kind: 'select', value: 'No' },
    ]);
  });

  it('never ticks a consent or arbitration box, and stops on a required one', () => {
    const result = plan([
      '@e1 checkbox "I agree to the arbitration agreement" [required]',
      '@e2 checkbox "I consent to marketing emails"',
    ].join('\n'));
    expect(result.actions).toEqual([]);
    expect(result.unknown).toEqual(['I agree to the arbitration agreement']);
  });

  it('names every required question it cannot answer', () => {
    const result = plan([
      '@e1 textbox "Salary expectations" [required]',
      '@e2 textbox "LinkedIn Profile" [required]',
      '@e3 textbox "Anything else?"',
      '@e4 textbox "Why do you want to join us?" [required]',
    ].join('\n'));
    expect(result.unknown).toEqual(['Salary expectations', 'LinkedIn Profile (no answer)', 'Why do you want to join us? (no answer)']);
  });

  it('answers a required question from a custom rule before the built-ins', () => {
    const p = { ...profile(), rules: [{ match: 'salary', kind: 'fill' as const, value: 'Open to discuss' }, { match: '^email', kind: 'fill' as const, value: 'jobs@example.com' }] };
    const result = plan('@e1 textbox "Salary expectations" [required]\n@e2 textbox "Email" [required]', p);
    expect(result.actions.map((action) => action.value)).toEqual(['Open to discuss', 'jobs@example.com']);
  });

  it('only uploads to file inputs, and ticks the how-did-you-hear option that is ours', () => {
    const result = plan([
      '@e1 textbox "Resume URL"',
      '@e2 checkbox "Company website"',
      '@e3 checkbox "LinkedIn"',
    ].join('\n'));
    expect(result.actions).toEqual([{ ref: '@e2', label: 'Company website', kind: 'click', value: '' }]);
  });

  it('fills the why-us answer when there is one', () => {
    const result = plan('@e1 textbox "Why Acme?" [required]', profile(), 'Because agents.');
    expect(result.actions).toEqual([{ ref: '@e1', label: 'Why Acme?', kind: 'fill', value: 'Because agents.' }]);
  });
});

describe('security codes', () => {
  it('extracts the code from a Greenhouse email', () => {
    const text = 'Copy and paste this code into the security code field on your application:\n\n7VF8BLTC\n\n  After you enter the code, resubmit your application.';
    expect(extractCode(text)).toBe('7VF8BLTC');
    expect(extractCode('nothing here')).toBeNull();
  });

  it('matches the company named in the subject', () => {
    expect(subjectMatchesCompany('Security code for your application to Acme AI', 'Acme AI')).toBe(true);
    expect(subjectMatchesCompany('Security code for your application to Example.com', 'Example.com')).toBe(true);
    expect(subjectMatchesCompany('Security code for your application to Cursor', 'Anysphere / Cursor')).toBe(true);
    expect(subjectMatchesCompany('Security code for your application to Initech', 'Acme AI')).toBe(false);
  });

  it('uses the mail account for the applicant address, or says why not', () => {
    const mail = { accounts: { work: { email: 'ada@example.com', provider: 'fastmail' as const, password: 'x' } } };
    expect(mailAccountFor(profile(), mail, {})).toEqual({ name: 'work' });
    expect(mailAccountFor(profile(), { accounts: {} }, {})).toEqual({ none: 'no `mail` account for ada@example.com' });
    const nopass = { accounts: { work: { email: 'ada@example.com', provider: 'fastmail' as const } } };
    expect(mailAccountFor(profile(), nopass, {})).toEqual({ none: '`mail` account "work" has no password' });
  });

  it('takes the first code any source yields, and gives up when stopped', async () => {
    let polls = 0;
    const got = await waitForCode([
      { name: 'mail', source: async () => null, everyMs: 0 },
      { name: 'file', source: async () => (++polls >= 2 ? 'ABC123' : null), everyMs: 0 },
    ], 'Acme', new Date(), new AbortController().signal, { timeoutMs: 10_000 });
    expect(got).toEqual({ code: 'ABC123', source: 'file' });

    const controller = new AbortController();
    controller.abort();
    expect(await waitForCode([{ name: 'file', source: async () => 'X', everyMs: 0 }], 'Acme', new Date(), controller.signal)).toBeNull();
  });
});
