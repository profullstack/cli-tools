import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXECUTABLE,
  childEnv,
  downloadUrl,
  install,
  installFailureMessage,
  manualBin,
  md5Line,
  parseMd5File,
  platformAsset,
  releaseChecksum,
  resolveRunner,
  resolveVersion,
  treeDigest,
  vendorBin,
  vendorRoot,
  verifyTree,
  type Fetch,
} from '../src/ngc.ts';

/** A directory shaped like NVIDIA's zip, unpacked. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'ngc-tree-'));
  mkdirSync(join(root, 'ngc-cli', '_internal'), { recursive: true });
  writeFileSync(join(root, 'ngc-cli', 'ngc'), 'bin\n');
  writeFileSync(join(root, 'ngc-cli', '_internal', 'a.txt'), 'a\n');
  // The real zip has a file with a space in its name (jaraco's "Lorem ipsum.txt").
  writeFileSync(join(root, 'ngc-cli', '_internal', 'Lorem ipsum.txt'), 'lorem\n');
  // find -type f skips symlinks; so must we.
  symlinkSync('ngc', join(root, 'ngc-cli', 'link'));
  return root;
}

/**
 * What `find ngc-cli/ -type f -exec md5sum {} + | LC_ALL=C sort | md5sum`
 * prints for {@link fixture}, measured with GNU coreutils.
 */
const FIXTURE_DIGEST = 'd83d728596369f252ff7ee03d4336c4c';

describe('treeDigest', () => {
  it('matches the find | md5sum | sort | md5sum pipeline byte for byte', () => {
    const root = fixture();
    try {
      expect(treeDigest(root)).toBe(FIXTURE_DIGEST);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('verifyTree', () => {
  it('accepts a tree that matches ngc-cli.md5', () => {
    const root = fixture();
    try {
      writeFileSync(join(root, 'ngc-cli.md5'), `${FIXTURE_DIGEST}  -\n`);
      expect(verifyTree(root)).toEqual({ ok: true, expected: FIXTURE_DIGEST, actual: FIXTURE_DIGEST });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a tampered file', () => {
    const root = fixture();
    try {
      writeFileSync(join(root, 'ngc-cli.md5'), `${FIXTURE_DIGEST}  -\n`);
      writeFileSync(join(root, 'ngc-cli', 'ngc'), 'evil\n');
      const check = verifyTree(root);
      expect(check.ok).toBe(false);
      expect(check.actual).not.toBe(FIXTURE_DIGEST);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses an added file', () => {
    const root = fixture();
    try {
      writeFileSync(join(root, 'ngc-cli.md5'), `${FIXTURE_DIGEST}  -\n`);
      writeFileSync(join(root, 'ngc-cli', 'extra.so'), 'x');
      expect(verifyTree(root).ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses when there is no checksum file at all', () => {
    const root = fixture();
    try {
      expect(verifyTree(root)).toEqual({ ok: false, expected: null, actual: null });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('md5Line and parseMd5File', () => {
  it('escapes a backslash or newline in a name the way md5sum does', () => {
    expect(md5Line('ab', 'ngc-cli/x y')).toBe('ab  ngc-cli/x y');
    expect(md5Line('ab', 'ngc-cli/a\\b')).toBe('\\ab  ngc-cli/a\\\\b');
    expect(md5Line('ab', 'ngc-cli/a\nb')).toBe('\\ab  ngc-cli/a\\nb');
  });

  it('reads md5sum stdin output', () => {
    expect(parseMd5File('A9884043FD85249677BB5999A4CA5282  -\n')).toBe('a9884043fd85249677bb5999a4ca5282');
    expect(parseMd5File('garbage')).toBeNull();
  });
});

const VERSIONS = {
  recipeVersions: [
    {
      versionId: '4.36.6',
      releaseNotes:
        '## ngc-cli 4.36.6\n### Linux Arm SHA256 Checksum: ' +
        '3627374f4f0d8db7607df62c8d21a2cd039d160e6e938b905ce97b4ee8e7f72f\n' +
        '### Linux Intel SHA256 Checksum: 2972dbe54e80cedae18e82923a9a67a60aef23d041c5790336f8f4b51752bab6\n',
    },
    { versionId: '4.34.10', releaseNotes: '' },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('resolveVersion', () => {
  it('takes the newest, which NVIDIA lists first', async () => {
    const seen: string[] = [];
    const fetchImpl: Fetch = async (url) => {
      seen.push(url);
      return json(VERSIONS);
    };
    const info = await resolveVersion(undefined, fetchImpl);
    expect(info.version).toBe('4.36.6');
    expect(seen[0]).toBe('https://api.ngc.nvidia.com/v2/resources/nvidia/ngc-apps/ngc_cli/versions');
  });

  it('finds a pinned version, and names the latest when the pin does not exist', async () => {
    const fetchImpl: Fetch = async () => json(VERSIONS);
    expect((await resolveVersion('4.34.10', fetchImpl)).version).toBe('4.34.10');
    await expect(resolveVersion('9.9.9', fetchImpl)).rejects.toThrow(/no CLI version 9\.9\.9 \(latest: 4\.36\.6\)/);
  });

  it('reports an HTTP failure', async () => {
    await expect(resolveVersion(undefined, async () => json({}, 503))).rejects.toThrow(/HTTP 503/);
  });
});

describe('releaseChecksum', () => {
  it('picks the SHA256 for the platform asked for', () => {
    const notes = VERSIONS.recipeVersions[0]!.releaseNotes;
    expect(releaseChecksum(notes, 'Linux Intel')).toMatch(/^2972dbe5/);
    expect(releaseChecksum(notes, 'Linux Arm')).toMatch(/^3627374f/);
    expect(releaseChecksum(notes, 'Mac Arm')).toBeNull();
  });
});

describe('platformAsset', () => {
  it('maps linux to the zips NVIDIA publishes', () => {
    expect(platformAsset('linux', 'x64')).toEqual({ file: 'ngccli_linux.zip', label: 'Linux Intel' });
    expect(platformAsset('linux', 'arm64')).toEqual({ file: 'ngccli_arm64.zip', label: 'Linux Arm' });
  });

  it('says macOS is a .pkg and how to point at it', () => {
    const asset = platformAsset('darwin', 'arm64');
    expect('unsupported' in asset && asset.unsupported).toMatch(/ngccli_mac_arm\.pkg[\s\S]*NGC_BIN/);
  });

  it('builds the download URL', () => {
    expect(downloadUrl('4.36.6', 'ngccli_linux.zip')).toBe(
      'https://api.ngc.nvidia.com/v2/resources/nvidia/ngc-apps/ngc_cli/versions/4.36.6/files/ngccli_linux.zip',
    );
  });
});

describe('paths', () => {
  it('vendors beside alchemy, and knows the by-hand location', () => {
    expect(EXECUTABLE).toBe('ngc');
    expect(vendorRoot({ XDG_DATA_HOME: '/data' })).toBe('/data/cli-tools/vendor/ngc');
    expect(vendorBin({ HOME: '/home/x' })).toBe('/home/x/.local/share/cli-tools/vendor/ngc/ngc-cli/ngc');
    expect(manualBin({ HOME: '/home/x' })).toBe('/home/x/.local/share/ngc-cli/ngc');
  });
});

describe('resolveRunner', () => {
  it('lets NGC_BIN win outright', () => {
    expect(resolveRunner({ env: { NGC_BIN: '/opt/ngc' }, exists: () => true })).toEqual({
      kind: 'env',
      file: '/opt/ngc',
    });
  });

  it('prefers the vendored copy over a hand install and PATH', () => {
    const runner = resolveRunner({
      env: { XDG_DATA_HOME: '/data' },
      exists: () => true,
      onPathStatus: () => 'other',
      onPathTarget: () => '/usr/bin/ngc',
    });
    expect(runner).toEqual({ kind: 'vendor', file: '/data/cli-tools/vendor/ngc/ngc-cli/ngc' });
  });

  it('uses a hand install in ~/.local/share/ngc-cli', () => {
    const runner = resolveRunner({
      env: { XDG_DATA_HOME: '/data' },
      exists: (path) => path === '/data/ngc-cli/ngc',
      onPathStatus: () => 'missing',
    });
    expect(runner).toEqual({ kind: 'manual', file: '/data/ngc-cli/ngc' });
  });

  it('uses another ngc on PATH', () => {
    const runner = resolveRunner({
      env: {},
      exists: () => false,
      onPathStatus: () => 'other',
      onPathTarget: () => '/opt/ngc-cli/ngc',
    });
    expect(runner).toEqual({ kind: 'path', file: '/opt/ngc-cli/ngc' });
  });

  it('never follows PATH back into this wrapper', () => {
    const runner = resolveRunner({
      env: {},
      exists: () => false,
      onPathStatus: () => 'ours',
      onPathTarget: () => '/home/x/.local/bin/ngc',
    });
    expect(runner).toEqual({ kind: 'missing', file: null });
  });
});

describe('childEnv', () => {
  const creds = { NGC_API_KEY: 'nvapi-secret', NGC_ORG: '1065646900305384' };

  it('leaves an exported NGC_CLI_API_KEY alone', () => {
    expect(childEnv({ NGC_CLI_API_KEY: 'x', HOME: '/h' }, creds, () => false)).toEqual({ add: {}, source: 'env' });
  });

  it('leaves ~/.ngc/config alone', () => {
    const result = childEnv({ HOME: '/h' }, creds, (path) => path === '/h/.ngc/config');
    expect(result).toEqual({ add: {}, source: 'config' });
  });

  it('supplies the stored key and org when upstream has neither', () => {
    expect(childEnv({ HOME: '/h' }, creds, () => false)).toEqual({
      add: { NGC_CLI_API_KEY: 'nvapi-secret', NGC_CLI_ORG: '1065646900305384' },
      source: 'credentials',
    });
  });

  it('does not override an org already chosen', () => {
    const result = childEnv({ HOME: '/h', NGC_CLI_ORG: 'mine' }, creds, () => false);
    expect(result.add).toEqual({ NGC_CLI_API_KEY: 'nvapi-secret' });
  });

  it('says so when there is no key anywhere', () => {
    expect(childEnv({ HOME: '/h' }, {}, () => false)).toEqual({ add: {}, source: 'none' });
  });
});

describe('install', () => {
  /** A fake NVIDIA: the version list, and a "zip" whose bytes we control. */
  function nvidia(zipBytes: string, sha: string): Fetch {
    return async (url) => {
      if (url.endsWith('/versions')) {
        return json({
          recipeVersions: [{ versionId: '1.2.3', releaseNotes: `### Linux Intel SHA256 Checksum: ${sha}\n` }],
        });
      }
      return new Response(zipBytes);
    };
  }

  /** Stands in for unzip: lays the fixture tree down, with a given md5 file. */
  function unpack(md5: string, tamper = false) {
    return async (_zip: string, dest: string) => {
      const src = fixture();
      mkdirSync(join(dest, 'ngc-cli', '_internal'), { recursive: true });
      for (const rel of ['ngc', '_internal/a.txt', '_internal/Lorem ipsum.txt']) {
        writeFileSync(join(dest, 'ngc-cli', rel), readFileSync(join(src, 'ngc-cli', rel)));
      }
      if (tamper) writeFileSync(join(dest, 'ngc-cli', 'ngc'), 'evil\n');
      writeFileSync(join(dest, 'ngc-cli.md5'), `${md5}  -\n`);
      rmSync(src, { recursive: true, force: true });
      return 0;
    };
  }

  const zip = 'pretend zip';
  const zipSha = createHash('sha256').update(zip).digest('hex');

  it('installs a verified tree and records the version', async () => {
    const data = mkdtempSync(join(tmpdir(), 'ngc-install-'));
    try {
      const result = await install({
        env: { XDG_DATA_HOME: data },
        fetchImpl: nvidia(zip, zipSha),
        platform: 'linux',
        arch: 'x64',
        unzip: unpack(FIXTURE_DIGEST),
        log: () => {},
      });
      expect(result).toEqual({ ok: true, version: '1.2.3' });
      const root = join(data, 'cli-tools', 'vendor', 'ngc');
      expect(readFileSync(join(root, 'ngc-cli', 'ngc'), 'utf8')).toBe('bin\n');
      expect(readFileSync(join(root, 'VERSION'), 'utf8')).toBe('1.2.3\n');
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });

  it('refuses a zip whose SHA256 is not the published one', async () => {
    const data = mkdtempSync(join(tmpdir(), 'ngc-install-'));
    try {
      const result = await install({
        env: { XDG_DATA_HOME: data },
        fetchImpl: nvidia(zip, 'f'.repeat(64)),
        platform: 'linux',
        arch: 'x64',
        unzip: unpack(FIXTURE_DIGEST),
        log: () => {},
      });
      expect(result.ok).toBe(false);
      expect(result.note).toMatch(/REFUSED.*SHA256/);
      expect(existsSync(join(data, 'cli-tools', 'vendor', 'ngc', 'ngc-cli'))).toBe(false);
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });

  it('refuses a tampered tree and keeps the working install', async () => {
    const data = mkdtempSync(join(tmpdir(), 'ngc-install-'));
    try {
      const live = join(data, 'cli-tools', 'vendor', 'ngc', 'ngc-cli');
      mkdirSync(live, { recursive: true });
      writeFileSync(join(live, 'ngc'), 'old good\n');
      const result = await install({
        env: { XDG_DATA_HOME: data },
        fetchImpl: nvidia(zip, zipSha),
        platform: 'linux',
        arch: 'x64',
        unzip: unpack(FIXTURE_DIGEST, true),
        log: () => {},
      });
      expect(result.ok).toBe(false);
      expect(result.note).toMatch(/REFUSED 1\.2\.3.*ngc-cli\.md5/);
      expect(readFileSync(join(live, 'ngc'), 'utf8')).toBe('old good\n');
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });

  it('does not try on macOS', async () => {
    const result = await install({ env: { XDG_DATA_HOME: '/nowhere' }, platform: 'darwin', arch: 'arm64' });
    expect(result.ok).toBe(false);
    expect(result.note).toMatch(/\.pkg/);
  });
});

describe('messages', () => {
  it('name the override', () => {
    expect(installFailureMessage('/x')).toContain('NGC_BIN=');
  });
});
