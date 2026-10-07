/**
 * ngc — NVIDIA's NGC CLI (catalog, registry, models, containers), on this box.
 *
 * Upstream is https://org.ngc.nvidia.com/setup/installers/cli. Nothing here
 * reimplements it; this is the part that makes `ngc` a command like every other
 * one in this repo, installed on first use, rather than a zip somebody unpacked
 * by hand once and nobody updates.
 *
 * NOT an npm package, unlike alchemy and openmcp. NVIDIA ships a zip per
 * platform from its own resource API, so install is: ask the API for the latest
 * version, download the zip, check its SHA256 against the one in that
 * version's release notes, unpack, and check the unpacked tree the way NVIDIA's
 * own instructions do —
 *
 *   find ngc-cli/ -type f -exec md5sum {} + | LC_ALL=C sort | md5sum -c ngc-cli.md5
 *
 * — refusing to install on any mismatch. {@link treeDigest} is that pipeline
 * in-process, byte for byte, so it needs no md5sum on the box.
 *
 * Into a PRIVATE PREFIX, and never PATH back into ourselves: the executable is
 * `ngc`, which is also the name of this wrapper, for the reason src/alchemy.ts
 * gives at length.
 *
 *   NGC_BIN       run this executable instead (a checkout, the macOS .pkg install)
 *   NGC_VERSION   install this version rather than the latest
 *
 * Credentials: upstream reads NGC_CLI_API_KEY / NGC_CLI_ORG from the
 * environment, or ~/.ngc/config from `ngc config set`. When neither is there,
 * {@link childEnv} supplies NGC_API_KEY / NGC_ORG from the credential store
 * (`cli-tools config pull` brings them down from the vault). Never printed.
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { firstOnPath, resolveCommand } from './registry.ts';

export const EXECUTABLE = 'ngc';

/** NVIDIA's resource API for the CLI itself: versions, release notes, files. */
export const RESOURCE = 'https://api.ngc.nvidia.com/v2/resources/nvidia/ngc-apps/ngc_cli';

/** The directory every NGC zip unpacks to, and the checksum file beside it. */
export const TREE = 'ngc-cli';
export const MD5_FILE = 'ngc-cli.md5';

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Where XDG says durable, non-config state goes. */
export function dataHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.XDG_DATA_HOME || join(env.HOME ?? homedir(), '.local', 'share');
}

/** The private prefix, beside alchemy's and codeburn's. */
export function vendorRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataHome(env), 'cli-tools', 'vendor', 'ngc');
}

/** The installed executable, whether or not it exists yet. */
export function vendorBin(env: NodeJS.ProcessEnv = process.env): string {
  return join(vendorRoot(env), TREE, EXECUTABLE);
}

/**
 * Where following NVIDIA's own instructions from ~/.local/share leaves it.
 *
 * Honoured so a box that installed it by hand before this command existed
 * keeps using that copy, rather than downloading a second 300 MB tree.
 */
export function manualBin(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataHome(env), TREE, EXECUTABLE);
}

export interface Asset {
  /** The file name in NVIDIA's resource. */
  file: string;
  /** How the release notes label this platform's SHA256. */
  label: string;
}

/**
 * The zip for this platform, or why there is none.
 *
 * NVIDIA publishes zips for Linux only. macOS gets a signed .pkg installer,
 * which wants a GUI or sudo; that is not something a launcher should do
 * behind your back, so it says so and how to point at the result.
 */
export function platformAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Asset | { unsupported: string } {
  if (platform === 'linux' && arch === 'x64') return { file: 'ngccli_linux.zip', label: 'Linux Intel' };
  if (platform === 'linux' && arch === 'arm64') return { file: 'ngccli_arm64.zip', label: 'Linux Arm' };
  if (platform === 'darwin') {
    const pkg = arch === 'arm64' ? 'ngccli_mac_arm.pkg' : 'ngccli_mac_intel.pkg';
    return {
      unsupported:
        `ngc: NVIDIA ships macOS as an installer (${pkg}), not a zip, so it is not installed automatically.\n` +
        '  Install it from https://org.ngc.nvidia.com/setup/installers/cli, then:\n' +
        '  NGC_BIN=$(command -v ngc) ngc …   # or export NGC_BIN',
    };
  }
  return {
    unsupported:
      `ngc: no NGC CLI zip for ${platform}/${arch}; NVIDIA publishes linux x64 and arm64 zips only.\n` +
      '  NGC_BIN=/path/to/ngc ngc …   # point at a copy you installed yourself',
  };
}

export function downloadUrl(version: string, file: string): string {
  return `${RESOURCE}/versions/${encodeURIComponent(version)}/files/${file}`;
}

export interface VersionInfo {
  version: string;
  /** The release notes, which carry each platform's SHA256. */
  notes: string;
}

interface VersionsResponse {
  recipeVersions?: { versionId?: string; releaseNotes?: string }[];
}

/**
 * The latest version, or the one asked for, with its release notes.
 *
 * recipeVersions comes back newest first; [0] is what NVIDIA's download page
 * offers.
 */
export async function resolveVersion(
  wanted: string | undefined,
  fetchImpl: Fetch = fetch,
): Promise<VersionInfo> {
  const res = await fetchImpl(`${RESOURCE}/versions`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`NGC version list: HTTP ${res.status}`);
  const body = (await res.json()) as VersionsResponse;
  const versions = body.recipeVersions ?? [];
  const found = wanted ? versions.find((v) => v.versionId === wanted) : versions[0];
  if (!found?.versionId) {
    throw new Error(
      wanted
        ? `NGC has no CLI version ${wanted} (latest: ${versions[0]?.versionId ?? 'unknown'})`
        : 'NGC version list was empty',
    );
  }
  return { version: found.versionId, notes: found.releaseNotes ?? '' };
}

/** "### Linux Intel SHA256 Checksum: <hex>" → the hex, or null. */
export function releaseChecksum(notes: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped} SHA256 Checksum:\\s*([0-9a-fA-F]{64})`).exec(notes);
  return match ? match[1]!.toLowerCase() : null;
}

/**
 * One line of md5sum output, escaped the way GNU md5sum escapes it: a name with
 * a backslash or newline gets a leading `\` and both characters escaped.
 */
export function md5Line(hash: string, path: string): string {
  if (!/[\\\n]/.test(path)) return `${hash}  ${path}`;
  return `\\${hash}  ${path.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}`;
}

/** Regular files under a directory, as `find <dir>/ -type f` names them. */
function regularFiles(root: string, rel: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, rel))) {
    const child = `${rel}/${entry}`;
    const stat = lstatSync(join(root, child));
    // -type f does not follow symlinks, so neither does this.
    if (stat.isDirectory()) out.push(...regularFiles(root, child));
    else if (stat.isFile()) out.push(child);
  }
  return out;
}

/**
 * `find ngc-cli/ -type f -exec md5sum {} + | LC_ALL=C sort | md5sum`, in-process.
 *
 * Every regular file's md5sum line, sorted by bytes (which is what LC_ALL=C
 * sort means), newline-terminated, then the md5 of the lot.
 */
export function treeDigest(root: string, dir: string = TREE): string {
  const lines = regularFiles(root, dir).map((rel) =>
    md5Line(createHash('md5').update(readFileSync(join(root, rel))).digest('hex'), rel),
  );
  lines.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return createHash('md5')
    .update(lines.map((line) => `${line}\n`).join(''))
    .digest('hex');
}

/** ngc-cli.md5 is md5sum's own output for stdin: `<hex>  -`. */
export function parseMd5File(text: string): string | null {
  const match = /^\s*([0-9a-fA-F]{32})\b/.exec(text);
  return match ? match[1]!.toLowerCase() : null;
}

export interface TreeCheck {
  ok: boolean;
  expected: string | null;
  actual: string | null;
}

/** Check an unpacked zip (a directory holding ngc-cli/ and ngc-cli.md5). */
export function verifyTree(root: string): TreeCheck {
  let expected: string | null = null;
  try {
    expected = parseMd5File(readFileSync(join(root, MD5_FILE), 'utf8'));
  } catch {
    return { ok: false, expected: null, actual: null };
  }
  if (!existsSync(join(root, TREE))) return { ok: false, expected, actual: null };
  const actual = treeDigest(root);
  return { ok: expected !== null && expected === actual, expected, actual };
}

export type RunnerKind = 'env' | 'vendor' | 'manual' | 'path' | 'missing';

export interface Runner {
  kind: RunnerKind;
  file: string | null;
}

export interface ResolveDeps {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  onPathStatus?: () => 'ours' | 'other' | 'missing';
  onPathTarget?: () => string | null;
}

/**
 * Which NGC CLI to run: NGC_BIN, ours, a hand install, anything else on PATH.
 *
 * Only a PATH copy that is NOT this wrapper counts, or `ngc` would exec itself
 * forever; the PATH entry is used as named, not realpath'd, as in alchemy.
 */
export function resolveRunner(deps: ResolveDeps = {}): Runner {
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const status = deps.onPathStatus ?? (() => resolveCommand(EXECUTABLE, undefined, env).status);
  const target = deps.onPathTarget ?? (() => firstOnPath(EXECUTABLE, env));

  if (env.NGC_BIN) return { kind: 'env', file: env.NGC_BIN };

  const vendored = vendorBin(env);
  if (exists(vendored)) return { kind: 'vendor', file: vendored };

  const manual = manualBin(env);
  if (exists(manual)) return { kind: 'manual', file: manual };

  if (status() === 'other') return { kind: 'path', file: target() };

  return { kind: 'missing', file: null };
}

/** The version a vendored install recorded, if any. */
export function installedVersion(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    return readFileSync(join(vendorRoot(env), 'VERSION'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export type AuthSource = 'env' | 'config' | 'credentials' | 'none';

/**
 * What to add to the child's environment so it is signed in, and from where.
 *
 * Upstream's own sources win: NGC_CLI_API_KEY already exported, or ~/.ngc/config
 * from `ngc config set`. Only when there is neither does the stored NGC_API_KEY
 * go in, as NGC_CLI_API_KEY, with NGC_ORG as NGC_CLI_ORG.
 */
export function childEnv(
  env: NodeJS.ProcessEnv,
  creds: Record<string, string | undefined>,
  exists: (path: string) => boolean = existsSync,
): { add: Record<string, string>; source: AuthSource } {
  if (env.NGC_CLI_API_KEY) return { add: {}, source: 'env' };
  const config = join(env.NGC_CLI_HOME || join(env.HOME ?? homedir(), '.ngc'), 'config');
  if (exists(config)) return { add: {}, source: 'config' };

  const key = creds.NGC_API_KEY;
  if (!key) return { add: {}, source: 'none' };
  const add: Record<string, string> = { NGC_CLI_API_KEY: key };
  if (!env.NGC_CLI_ORG && creds.NGC_ORG) add.NGC_CLI_ORG = creds.NGC_ORG;
  return { add, source: 'credentials' };
}

export interface InstallDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: Fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Unpack a zip into a directory; resolves with the exit code. */
  unzip?: (zip: string, dest: string) => Promise<number | null>;
  log?: (line: string) => void;
}

export interface InstallResult {
  ok: boolean;
  version?: string;
  /** Why it failed, already phrased for a person. */
  note?: string;
}

/** `unzip -q -o zip -d dest`, with Python's zipfile as the fallback. */
export function systemUnzip(zip: string, dest: string): Promise<number | null> {
  const run = (file: string, args: string[]) =>
    new Promise<number | null>((resolve) => {
      const child = spawn(file, args, { stdio: ['ignore', 'ignore', 'inherit'] });
      child.on('error', () => resolve(null));
      child.on('close', (code) => resolve(code ?? 1));
    });
  return run('unzip', ['-q', '-o', zip, '-d', dest]).then((code) =>
    code === null ? run('python3', ['-I', '-m', 'zipfile', '-e', zip, dest]) : code,
  );
}

async function download(url: string, dest: string, fetchImpl: Fetch): Promise<void> {
  const res = await fetchImpl(url);
  if (!res.ok || !res.body) throw new Error(`download ${url}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Download, verify and install the NGC CLI into the private prefix.
 *
 * Staged beside the prefix and swapped in only once both checks pass, so a
 * tampered or truncated download never replaces a working install.
 */
export async function install(deps: InstallDeps = {}): Promise<InstallResult> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const unzip = deps.unzip ?? systemUnzip;
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  const asset = platformAsset(deps.platform, deps.arch);
  if ('unsupported' in asset) return { ok: false, note: asset.unsupported };

  let info: VersionInfo;
  try {
    info = await resolveVersion(env.NGC_VERSION || undefined, fetchImpl);
  } catch (error) {
    return { ok: false, note: `ngc: ${(error as Error).message}` };
  }

  const root = vendorRoot(env);
  mkdirSync(root, { recursive: true });
  const staging = join(root, `.staging-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  try {
    const zip = join(staging, asset.file);
    log(`ngc: downloading ${asset.file} ${info.version}`);
    try {
      await download(downloadUrl(info.version, asset.file), zip, fetchImpl);
    } catch (error) {
      return { ok: false, note: `ngc: ${(error as Error).message}` };
    }

    const wantedSha = releaseChecksum(info.notes, asset.label);
    if (wantedSha) {
      const got = sha256(zip);
      if (got !== wantedSha) {
        return {
          ok: false,
          note: `ngc: REFUSED ${asset.file} ${info.version}: SHA256 ${got} is not the ${wantedSha} in NVIDIA's release notes`,
        };
      }
    } else {
      log(`ngc: no ${asset.label} SHA256 in the ${info.version} release notes; relying on the md5 tree check`);
    }

    const unpacked = join(staging, 'unpacked');
    mkdirSync(unpacked);
    const code = await unzip(zip, unpacked);
    if (code !== 0) return { ok: false, note: `ngc: could not unzip ${asset.file} (unzip exit ${code ?? 'not found'})` };

    const check = verifyTree(unpacked);
    if (!check.ok) {
      return {
        ok: false,
        note:
          `ngc: REFUSED ${info.version}: the unpacked tree does not match ${MD5_FILE} ` +
          `(expected ${check.expected ?? 'none'}, got ${check.actual ?? 'nothing'})`,
      };
    }

    // Swap: old tree aside, new tree in, old tree gone.
    const live = join(root, TREE);
    const old = join(staging, 'old');
    if (existsSync(live)) renameSync(live, old);
    renameSync(join(unpacked, TREE), live);
    chmodSync(join(live, EXECUTABLE), 0o755);
    writeFileSync(join(root, 'VERSION'), `${info.version}\n`);
    return { ok: true, version: info.version };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** What to print when it could not be installed. */
export function installFailureMessage(root: string): string {
  return [
    `ngc: could not install the NGC CLI into ${root}.`,
    '  https://org.ngc.nvidia.com/setup/installers/cli   # by hand, to see the error',
    '  NGC_BIN=/path/to/ngc ngc                          # or point at a copy you have',
  ].join('\n');
}
