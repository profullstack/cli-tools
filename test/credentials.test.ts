import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  credentialsPath,
  keyStates,
  keyVariable,
  loadStored,
  mask,
  resolveCredentials,
  saveStored,
} from '../src/credentials.ts';
import { resolveProvider } from '../src/generate-names.ts';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function sandbox(): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(join(tmpdir(), 'credentials-'));
  dirs.push(dir);
  return { XDG_CONFIG_HOME: dir } as NodeJS.ProcessEnv;
}

describe('credentialsPath', () => {
  it('lives under the XDG config dir', () => {
    expect(credentialsPath({ XDG_CONFIG_HOME: '/xdg' } as NodeJS.ProcessEnv)).toBe(
      '/xdg/cli-tools/credentials.json',
    );
  });

  it('falls back to ~/.config', () => {
    expect(credentialsPath({} as NodeJS.ProcessEnv)).toMatch(
      /\.config\/cli-tools\/credentials\.json$/,
    );
  });

  it('honours an explicit override', () => {
    expect(credentialsPath({ CLI_TOOLS_CREDENTIALS: '/tmp/k.json' } as NodeJS.ProcessEnv)).toBe(
      '/tmp/k.json',
    );
  });
});

describe('keyVariable', () => {
  it('accepts the friendly name, with or without a key suffix', () => {
    expect(keyVariable('openai')).toBe('OPENAI_API_KEY');
    expect(keyVariable('openai-key')).toBe('OPENAI_API_KEY');
    expect(keyVariable('openai_api_key')).toBe('OPENAI_API_KEY');
    expect(keyVariable('Anthropic')).toBe('ANTHROPIC_API_KEY');
  });

  it('accepts the environment variable name itself', () => {
    expect(keyVariable('OPENAI_API_KEY')).toBe('OPENAI_API_KEY');
    expect(keyVariable('anthropic_api_key')).toBe('ANTHROPIC_API_KEY');
  });

  it('rejects anything else rather than inventing a variable', () => {
    expect(keyVariable('gemini')).toBeNull();
    expect(keyVariable('')).toBeNull();
  });
});

describe('mask', () => {
  it('shows enough to recognise a key and not enough to use it', () => {
    const masked = mask('sk-proj-abcdefghijklmnop1234');
    expect(masked).toContain('sk-pr');
    expect(masked).toContain('1234');
    expect(masked).not.toContain('abcdefghijkl');
  });

  it('reveals nothing at all from a short value', () => {
    expect(mask('short')).toBe('*****');
  });
});

describe('saveStored / loadStored', () => {
  it('round-trips', async () => {
    const env = await sandbox();
    saveStored({ OPENAI_API_KEY: 'sk-test-value-1234' }, env);
    expect(loadStored(env)).toEqual({ OPENAI_API_KEY: 'sk-test-value-1234' });
  });

  // A key readable by every account on the box is not stored, it is published.
  it('writes the file 0600 and the directory 0700', async () => {
    const env = await sandbox();
    const path = saveStored({ OPENAI_API_KEY: 'sk-test-value-1234' }, env);

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(env.XDG_CONFIG_HOME!, 'cli-tools'))).mode & 0o777).toBe(0o700);
  });

  // writeFileSync's mode applies only when it creates the file, so a file left
  // permissive by a hand edit would otherwise stay that way forever.
  it('tightens the mode of a file that already exists', async () => {
    const env = await sandbox();
    const path = saveStored({ OPENAI_API_KEY: 'first-value-here' }, env);
    await writeFile(path, '{}', { mode: 0o644 });

    saveStored({ OPENAI_API_KEY: 'second-value-here' }, env);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('treats a missing file as no keys', async () => {
    expect(loadStored(await sandbox())).toEqual({});
  });

  // Falling back to "no keys" would surface as a message about the environment,
  // pointing away from the file that is actually broken.
  it('refuses malformed JSON, naming the file', async () => {
    const env = await sandbox();
    const path = saveStored({}, env);
    await writeFile(path, '{ not json');

    expect(() => loadStored(env)).toThrow(path);
  });

  it('drops blank and non-string values', async () => {
    const env = await sandbox();
    const path = saveStored({}, env);
    await writeFile(path, JSON.stringify({ OPENAI_API_KEY: '   ', ANTHROPIC_API_KEY: 42 }));

    expect(loadStored(env)).toEqual({});
  });
});

describe('resolveCredentials', () => {
  it('returns the stored key when the environment has none', async () => {
    const env = await sandbox();
    saveStored({ OPENAI_API_KEY: 'sk-stored-value-1' }, env);

    expect(resolveCredentials(env).OPENAI_API_KEY).toBe('sk-stored-value-1');
  });

  // CI and a one-off `KEY=… command` both depend on this precedence.
  it('lets the environment override the stored key', async () => {
    const env = await sandbox();
    saveStored({ OPENAI_API_KEY: 'sk-stored-value-1' }, env);
    env.OPENAI_API_KEY = 'sk-env-value-2';

    expect(resolveCredentials(env).OPENAI_API_KEY).toBe('sk-env-value-2');
  });

  it('leaves a stored key alone when a different variable is exported', async () => {
    const env = await sandbox();
    saveStored({ OPENAI_API_KEY: 'sk-stored-value-1' }, env);
    env.ANTHROPIC_API_KEY = 'sk-ant-value-2';

    const resolved = resolveCredentials(env);
    expect(resolved.OPENAI_API_KEY).toBe('sk-stored-value-1');
    expect(resolved.ANTHROPIC_API_KEY).toBe('sk-ant-value-2');
  });
});

// The wiring generate-names depends on: resolveCredentials produces an
// environment-shaped record, so resolveProvider consumes it unchanged and a
// stored key selects a provider exactly as an exported one does.
describe('resolveCredentials feeding resolveProvider', () => {
  it('selects a provider from a stored key alone', async () => {
    const env = await sandbox();
    saveStored({ ANTHROPIC_API_KEY: 'sk-ant-stored-1234' }, env);

    expect(resolveProvider(resolveCredentials(env))).toBe('anthropic');
  });

  it('honours --provider against a stored key', async () => {
    const env = await sandbox();
    saveStored({ ANTHROPIC_API_KEY: 'sk-ant-stored-1234' }, env);

    expect(resolveProvider(resolveCredentials(env), 'anthropic')).toBe('anthropic');
    expect(() => resolveProvider(resolveCredentials(env), 'openai')).toThrow(/OPENAI_API_KEY/);
  });

  it('still reports no key when neither source has one', async () => {
    const env = await sandbox();
    expect(() => resolveProvider(resolveCredentials(env))).toThrow(/cli-tools config set openai/);
  });
});

describe('keyStates', () => {
  it('reports each key as env, file or unset', async () => {
    const env = await sandbox();
    saveStored({ OPENAI_API_KEY: 'sk-stored-value-1' }, env);
    env.ANTHROPIC_API_KEY = 'sk-ant-value-2';

    const byName = Object.fromEntries(keyStates(env).map((state) => [state.name, state]));
    expect(byName.openai!.source).toBe('file');
    expect(byName.anthropic!.source).toBe('env');
  });

  it('reports a stored key shadowed by the environment as env, not file', async () => {
    const env = await sandbox();
    saveStored({ OPENAI_API_KEY: 'sk-stored-value-1' }, env);
    env.OPENAI_API_KEY = 'sk-env-value-2';

    const openai = keyStates(env).find((state) => state.name === 'openai')!;
    expect(openai.source).toBe('env');
    // This is what makes "I stored it and it still uses the old one" visible.
    expect(openai.preview).toContain('sk-en');
  });

  it('never puts a whole key in the state', async () => {
    const env = await sandbox();
    saveStored({ OPENAI_API_KEY: 'sk-secret-value-abcdefgh' }, env);

    for (const state of keyStates(env)) {
      expect(state.preview ?? '').not.toContain('sk-secret-value-abcdefgh');
    }
  });

  it('reports unset when nothing is configured', async () => {
    const env = await sandbox();
    expect(keyStates(env).every((state) => state.source === 'unset')).toBe(true);
  });
});
