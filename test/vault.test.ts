import { existsSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TARGET,
  parseEnvFile,
  pullVault,
  vaultTarget,
  type Runner,
} from '../src/vault.ts';

/** A runner that writes the given dotenv text where logicsrc would have. */
function writing(text: string): { run: Runner; seen: { args: string[]; dir: string | null } } {
  const seen = { args: [] as string[], dir: null as string | null };
  const run: Runner = (args, envPath) => {
    seen.args = [...args];
    seen.dir = dirname(envPath);
    writeFileSync(envPath, text);
    return { status: 0, stderr: '' };
  };
  return { run, seen };
}

describe('vaultTarget', () => {
  it('defaults to the shared team vault', () => {
    expect(vaultTarget({} as NodeJS.ProcessEnv)).toEqual(DEFAULT_TARGET);
    expect(DEFAULT_TARGET.project).toBe('profullstack-sharable-keys');
  });

  it('can be pointed elsewhere', () => {
    const target = vaultTarget({
      CLI_TOOLS_VAULT_TEAM: 'other',
      CLI_TOOLS_VAULT_PROJECT: 'thing',
      CLI_TOOLS_VAULT_ENV: 'staging',
    } as NodeJS.ProcessEnv);
    expect(target).toEqual({ team: 'other', project: 'thing', env: 'staging' });
  });
});

describe('parseEnvFile', () => {
  it('reads KEY=value lines', () => {
    expect(parseEnvFile('A=1\nB=two\n')).toEqual({ A: '1', B: 'two' });
  });

  it('strips matching quotes', () => {
    expect(parseEnvFile('A="quoted"\nB=\'single\'')).toEqual({ A: 'quoted', B: 'single' });
  });

  // A key is base64 or a URL as often as not; splitting on every = would
  // truncate exactly the values that matter.
  it('keeps equals signs inside a value', () => {
    expect(parseEnvFile('TOKEN=abc==def=').TOKEN).toBe('abc==def=');
  });

  it('ignores comments, blanks and malformed lines', () => {
    expect(parseEnvFile('# note\n\nNOEQUALS\n=novalue\nA=1')).toEqual({ A: '1' });
  });

  it('drops empty values rather than storing a blank key', () => {
    expect(parseEnvFile('A=\nB=2')).toEqual({ B: '2' });
  });
});

describe('pullVault', () => {
  it('returns the vault contents', () => {
    const { run } = writing('OPENAI_API_KEY=sk-vault-value\nOTHER=x\n');
    expect(pullVault(DEFAULT_TARGET, run)).toEqual({
      OPENAI_API_KEY: 'sk-vault-value',
      OTHER: 'x',
    });
  });

  it('asks logicsrc for the right vault', () => {
    const { run, seen } = writing('A=1');
    pullVault({ team: 't', project: 'p', env: 'e' }, run);
    expect(seen.args).toEqual(['teams', 'pull', 't', 'p', 'e']);
  });

  // The decrypted file is the whole risk of this function; it must not outlive
  // the call, including when the call fails.
  it('removes the decrypted file and its directory', () => {
    const { run, seen } = writing('A=1');
    pullVault(DEFAULT_TARGET, run);
    expect(existsSync(seen.dir!)).toBe(false);
  });

  it('removes the directory even when the pull fails', () => {
    let dir: string | null = null;
    const run: Runner = (_args, envPath) => {
      dir = dirname(envPath);
      return { status: 1, stderr: 'access denied' };
    };

    expect(() => pullVault(DEFAULT_TARGET, run)).toThrow(/access denied/);
    expect(existsSync(dir!)).toBe(false);
  });

  it('names the vault in the failure', () => {
    const run: Runner = () => ({ status: 1, stderr: 'nope' });
    expect(() => pullVault({ team: 't', project: 'p', env: 'e' }, run)).toThrow(/t p e/);
  });

  // Reporting success while writing nothing would otherwise surface as an empty
  // import with no explanation.
  it('complains when logicsrc succeeds but writes no file', () => {
    const run: Runner = () => ({ status: 0, stderr: '' });
    expect(() => pullVault(DEFAULT_TARGET, run)).toThrow(/wrote no file/);
  });
});
