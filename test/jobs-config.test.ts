import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  JobsError,
  checkDocuments,
  defaultFilters,
  emptyConfig,
  emptyProfile,
  jobsConfigPath,
  loadJobsConfig,
  normalizeConfig,
  parseAssignment,
  pickProfileName,
  renderWhy,
  resolveSettings,
  saveJobsConfig,
  setFilter,
  setProfileField,
  unsetFilter,
} from '../src/jobs-config.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jobs-config-'));
  dirs.push(dir);
  return dir;
}
const env = (extra: Record<string, string> = {}) => ({ XDG_CONFIG_HOME: '/xdg', XDG_DATA_HOME: '/data', ...extra }) as NodeJS.ProcessEnv;
const set = (text: string) => parseAssignment(text);

describe('config file', () => {
  it('lives under the user config dir unless $JOBS_CONFIG says otherwise', () => {
    expect(jobsConfigPath(env())).toBe('/xdg/cli-tools/jobs.json');
    expect(jobsConfigPath(env({ JOBS_CONFIG: '/x.json' }))).toBe('/x.json');
  });

  it('treats a missing file as an empty config, and malformed JSON as an error', () => {
    const dir = tmp();
    const missing = loadJobsConfig(env({ JOBS_CONFIG: join(dir, 'none.json') }));
    expect(missing.found).toBe(false);
    expect(missing.config.profiles).toEqual({});

    writeFileSync(join(dir, 'bad.json'), '{ nope');
    expect(() => loadJobsConfig(env({ JOBS_CONFIG: join(dir, 'bad.json') }))).toThrow(JobsError);
  });

  it('saves 0600 and reads back what it wrote', () => {
    const dir = tmp();
    const e = env({ JOBS_CONFIG: join(dir, 'sub', 'jobs.json') });
    const config = emptyConfig();
    config.profiles.a = setProfileField(emptyProfile(), set('firstName=Ada'));
    config.default = 'a';
    const path = saveJobsConfig(config, e);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const loaded = loadJobsConfig(e);
    expect(loaded.found).toBe(true);
    expect(loaded.config.profiles.a!.applicant.firstName).toBe('Ada');
    expect(loaded.config.default).toBe('a');
  });

  it('ships no identity: an empty profile answers nothing', () => {
    const profile = emptyProfile();
    expect(Object.values(profile.applicant).every((value) => value === null)).toBe(true);
    expect(Object.values(profile.answers).every((value) => value === null)).toBe(true);
    expect(profile.resume).toBeNull();
  });

  it('drops malformed entries rather than trusting them', () => {
    const config = normalizeConfig({
      default: 'missing',
      profiles: { 'Bad Name': {}, ok: { applicant: { firstName: 7 }, rules: [{ match: '(', value: 'x' }, { match: 'salary', value: '200k' }] } },
    });
    expect(Object.keys(config.profiles)).toEqual(['ok']);
    expect(config.default).toBeNull();
    expect(config.profiles.ok!.applicant.firstName).toBeNull();
    expect(config.profiles.ok!.rules).toEqual([{ match: 'salary', kind: 'fill', value: '200k' }]);
  });
});

describe('which profile', () => {
  const config = () => {
    const c = emptyConfig();
    c.profiles.a = emptyProfile();
    c.profiles.b = emptyProfile();
    return c;
  };

  it('prefers the flag, then $JOBS_PROFILE, then the default', () => {
    const c = config();
    c.default = 'a';
    expect(pickProfileName(c, 'b', env()).name).toBe('b');
    expect(pickProfileName(c, undefined, env({ JOBS_PROFILE: 'b' })).name).toBe('b');
    expect(pickProfileName(c, undefined, env()).name).toBe('a');
  });

  it('asks rather than guesses between several with no default', () => {
    expect(() => pickProfileName(config(), undefined, env())).toThrow(/which profile/);
  });

  it('uses the only one, or an implicit empty one when there are none', () => {
    const one = emptyConfig();
    one.profiles.solo = emptyProfile();
    expect(pickProfileName(one, undefined, env())).toEqual({ name: 'solo', implicit: false });
    expect(pickProfileName(emptyConfig(), undefined, env())).toEqual({ name: 'default', implicit: true });
  });

  it('refuses a profile that does not exist', () => {
    expect(() => pickProfileName(config(), 'zzz', env())).toThrow(/no profile "zzz"/);
  });
});

describe('resolveSettings', () => {
  it('keeps applied history global and the rest per profile', () => {
    const c = emptyConfig();
    c.profiles.a = emptyProfile();
    const settings = resolveSettings(c, 'a', env());
    expect(settings.stateDir).toBe('/data/cli-tools/jobs');
    expect(settings.profileDir).toBe('/data/cli-tools/jobs/profiles/a');
  });

  it('lets the environment override the file', () => {
    const c = emptyConfig();
    c.state = '/from-file';
    c.tron = { automateBin: '/file/automate.js', chromiumBin: '/file/chrome' };
    c.profiles.a = setProfileField(emptyProfile(), set('why=file'));
    const settings = resolveSettings(c, 'a', env({
      JOBS_STATE: '/from-env', TRON_AUTOMATE_BIN: '/env/automate.js', TRON_CHROMIUM_BIN: '/env/chrome', JOBS_WHY: 'env',
    }));
    expect(settings.stateDir).toBe('/from-env');
    expect(settings.automateBin).toBe('/env/automate.js');
    expect(settings.chromiumBin).toBe('/env/chrome');
    expect(settings.profile.why).toBe('env');
    expect(resolveSettings(c, 'a', env()).stateDir).toBe('/from-file');
  });

  it('runs the bundled browser when no chromium is named', () => {
    expect(resolveSettings(emptyConfig(), undefined, env()).chromiumBin).toBeNull();
  });
});

describe('filters', () => {
  it('default to the search the tool shipped with', () => {
    const f = defaultFilters();
    expect(f.workplace).toEqual(['remote']);
    expect(f.countries).toEqual(['US']);
    expect(f.minScore).toBe(7);
    expect(f.pay).toEqual({ min: null, currency: 'USD', require: false });
    expect(f.exclude).toEqual([]);
  });

  it('parse lists, list edits, numbers with k, and booleans', () => {
    let f = defaultFilters();
    f = setFilter(f, set('workplace=remote,hybrid'));
    expect(f.workplace).toEqual(['remote', 'hybrid']);
    f = setFilter(f, set('workplace=any'));
    expect(f.workplace).toEqual(['remote', 'hybrid', 'onsite']);
    f = setFilter(f, set('countries=us,ca'));
    expect(f.countries).toEqual(['US', 'CA']);
    f = setFilter(f, set('countries-=CA'));
    expect(f.countries).toEqual(['US']);
    f = setFilter(f, set('title.exclude+=staff'));
    expect(f.title.exclude.at(-1)).toBe('staff');
    f = setFilter(f, set('pay.min=150k'));
    expect(f.pay.min).toBe(150_000);
    f = setFilter(f, set('pay.require=yes'));
    expect(f.pay.require).toBe(true);
    f = setFilter(f, set('minScore=10'));
    expect(f.minScore).toBe(10);
  });

  it('reject what they cannot mean', () => {
    const f = defaultFilters();
    expect(() => setFilter(f, set('workplace=moon'))).toThrow(/workplace/);
    expect(() => setFilter(f, set('title.include=(unclosed'))).toThrow(/regular expression/);
    expect(() => setFilter(f, set('pay.min=lots'))).toThrow(/number/);
    expect(() => setFilter(f, set('pay.min+=5'))).toThrow(/not a list/);
    expect(() => setFilter(f, set('colour=blue'))).toThrow(/unknown filter/);
  });

  it('add, change and remove boosts', () => {
    let f = setFilter(defaultFilters(), set('boost.rust.terms=rust,tokio'));
    f = setFilter(f, set('boost.rust.weight=6'));
    expect(f.boost.rust).toEqual({ terms: ['rust', 'tokio'], weight: 6, in: 'any' });
    f = unsetFilter(f, 'boost.rust');
    expect(f.boost.rust).toBeUndefined();
  });

  it('keep a removed default boost removed after a save and load', () => {
    const f = unsetFilter(defaultFilters(), 'boost.agents');
    const config = normalizeConfig({ profiles: { a: { filters: JSON.parse(JSON.stringify(f)) } } });
    expect(config.profiles.a!.filters.boost.agents).toBeUndefined();
    expect(config.profiles.a!.filters.boost['ai-tools']).toBeDefined();
  });

  it('unset back to the default', () => {
    const f = unsetFilter(setFilter(defaultFilters(), set('countries=GB')), 'countries');
    expect(f.countries).toEqual(['US']);
  });
});

describe('profile edits', () => {
  it('set applicant, answers, documents and filters', () => {
    const exists = (path: string) => path === '/cv.pdf';
    let p = emptyProfile();
    p = setProfileField(p, set('email=a@example.com'), exists);
    p = setProfileField(p, set('applicant.city=Springfield'), exists);
    p = setProfileField(p, set('answers.sponsorship=No'), exists);
    p = setProfileField(p, set('resume=/cv.pdf'), exists);
    p = setProfileField(p, set('filters.pay.min=120k'), exists);
    expect(p.applicant.email).toBe('a@example.com');
    expect(p.applicant.city).toBe('Springfield');
    expect(p.answers.sponsorship).toBe('No');
    expect(p.resume).toBe('/cv.pdf');
    expect(p.filters.pay.min).toBe(120_000);
  });

  it('refuse a resume or cover that does not exist', () => {
    expect(() => setProfileField(emptyProfile(), set('resume=/nope.pdf'), () => false)).toThrow(/no file/);
    const p = { ...emptyProfile(), cover: '/gone.pdf' };
    expect(() => checkDocuments(p, () => false)).toThrow(/cover/);
  });

  it('clear a field with an empty value', () => {
    const p = setProfileField(setProfileField(emptyProfile(), set('phone=555')), set('phone='));
    expect(p.applicant.phone).toBeNull();
  });

  it('point unknown answers at custom rules', () => {
    expect(() => setProfileField(emptyProfile(), set('answers.salary=1'))).toThrow(/profile answer/);
  });

  it('never mutate the profile they are given', () => {
    const p = emptyProfile();
    setProfileField(p, set('firstName=X'));
    expect(p.applicant.firstName).toBeNull();
  });
});

describe('renderWhy', () => {
  it('fills company and focus, and is empty without a template', () => {
    expect(renderWhy("{company}'s work on {focus}.", { company: 'Acme', focus: 'agents' })).toBe("Acme's work on agents.");
    expect(renderWhy(null, { company: 'Acme' })).toBe('');
  });
});
