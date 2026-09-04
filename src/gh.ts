import { run, sleep, type RunResult } from './exec.ts';

/**
 * A typed front door to the `gh` CLI.
 *
 * The bash originals piped every response through `jq -r` and compared the
 * result to a string. That reads fine and fails badly: `jq -r '.mergeable'` on
 * a response that never had the field prints the four characters `null`, which
 * is not `MERGEABLE`, so the PR is reported ineligible for a reason nobody
 * wrote. The failure is indistinguishable from a genuine verdict.
 *
 * So responses are parsed once, validated by shape, and any field that is
 * missing or unrecognised is *named* in the error rather than silently
 * becoming a string.
 */

export class GhError extends Error {
  // An explicit field rather than a constructor parameter property: Node's
  // type stripping accepts only syntax it can erase, and this is the one
  // construct in the repo it refuses.
  readonly result?: RunResult;

  constructor(message: string, result?: RunResult) {
    super(message);
    this.name = 'GhError';
    if (result !== undefined) this.result = result;
  }
}

/** Values GitHub documents for `mergeable`, plus the honest fallback. */
export const MERGEABLE = ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] as const;
export type Mergeable = (typeof MERGEABLE)[number];

export const MERGE_STATE = [
  'BEHIND',
  'BLOCKED',
  'CLEAN',
  'DIRTY',
  'DRAFT',
  'HAS_HOOKS',
  'UNKNOWN',
  'UNSTABLE',
] as const;
export type MergeState = (typeof MERGE_STATE)[number];

/** Buckets `gh pr checks --json bucket` reports. */
export const BUCKET = ['pass', 'fail', 'pending', 'skipping', 'cancel'] as const;
export type Bucket = (typeof BUCKET)[number];

export interface PullRequest {
  url: string;
  title: string;
  state: string;
  isDraft: boolean;
  mergeable: Mergeable;
  mergeStateStatus: MergeState;
  headRefOid: string;
}

export interface Check {
  name: string;
  bucket: Bucket;
}

function fail(field: string, value: unknown, where: string): never {
  throw new GhError(
    `${where}: unexpected value for ${field}: ${JSON.stringify(value)}`,
  );
}

function asString(value: unknown, field: string, where: string): string {
  if (typeof value !== 'string') fail(field, value, where);
  return value;
}

function asEnum<T extends string>(
  allowed: readonly T[],
  value: unknown,
  field: string,
  where: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(field, value, where);
  }
  return value as T;
}

export function parsePullRequest(raw: unknown, where = 'gh pr view'): PullRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new GhError(`${where}: expected an object, got ${JSON.stringify(raw)}`);
  }

  const record = raw as Record<string, unknown>;

  if (typeof record.isDraft !== 'boolean') fail('isDraft', record.isDraft, where);

  return {
    url: asString(record.url, 'url', where),
    title: asString(record.title, 'title', where),
    state: asString(record.state, 'state', where),
    isDraft: record.isDraft,
    mergeable: asEnum(MERGEABLE, record.mergeable, 'mergeable', where),
    mergeStateStatus: asEnum(
      MERGE_STATE,
      record.mergeStateStatus,
      'mergeStateStatus',
      where,
    ),
    headRefOid: asString(record.headRefOid, 'headRefOid', where),
  };
}

export function parseChecks(raw: unknown, where = 'gh pr checks'): Check[] {
  if (!Array.isArray(raw)) {
    throw new GhError(`${where}: expected an array, got ${JSON.stringify(raw)}`);
  }

  return raw.map((entry) => {
    const record = entry as Record<string, unknown>;
    return {
      name: asString(record.name, 'name', where),
      bucket: asEnum(BUCKET, record.bucket, 'bucket', where),
    };
  });
}

export interface GhOptions {
  /** Swap in a fake for tests. */
  exec?: typeof run;
}

export class Gh {
  private readonly exec: typeof run;

  constructor(options: GhOptions = {}) {
    this.exec = options.exec ?? run;
  }

  private async call(args: readonly string[]): Promise<RunResult> {
    // GH_PAGER=cat so a configured pager cannot block on a TTY that is not
    // there. The bash version set this on every call site and missed none by
    // luck rather than design.
    return this.exec('gh', args, {
      env: { ...process.env, GH_PAGER: 'cat', CLICOLOR: '0' },
    });
  }

  private async json<T>(
    args: readonly string[],
    parse: (raw: unknown) => T,
    { allowNonZero = false }: { allowNonZero?: boolean } = {},
  ): Promise<T> {
    const result = await this.call(args);

    // Some subcommands exit non-zero *and* print usable JSON — `gh pr checks`
    // does exactly that whenever anything is pending or failing. Reading the
    // exit code there would discard the answer we asked for.
    if (result.code !== 0 && !allowNonZero) {
      throw new GhError(
        `gh ${args.join(' ')} exited ${result.code}: ${result.stderr.trim()}`,
        result,
      );
    }

    const text = result.stdout.trim();
    if (!text) {
      throw new GhError(`gh ${args.join(' ')} printed no JSON`, result);
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new GhError(
        `gh ${args.join(' ')} printed output that is not JSON: ${text.slice(0, 200)}`,
        result,
      );
    }

    return parse(raw);
  }

  /**
   * Read a PR, retrying while GitHub is still computing mergeability.
   *
   * `UNKNOWN` is not a state a PR rests in; it means "ask again". Treating it
   * as a verdict is how a perfectly mergeable PR gets skipped for
   * `mergeable=UNKNOWN` a second after it was opened.
   */
  async pullRequest(
    url: string,
    { attempts = 5, awaitReady = false, delayMs = 2000 } = {},
  ): Promise<PullRequest> {
    let last: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const pr = await this.json(
          [
            'pr',
            'view',
            url,
            '--json',
            'state,isDraft,mergeable,mergeStateStatus,headRefOid,title,url',
          ],
          (raw) => parsePullRequest(raw),
        );

        const settled = pr.mergeable !== 'UNKNOWN';
        const ready = !awaitReady || !pr.isDraft;

        if (settled && ready) return pr;
        last = pr;
      } catch (error) {
        last = error;
      }

      if (attempt < attempts) await sleep(delayMs);
    }

    if (last instanceof Error) throw last;
    if (last) return last as PullRequest;
    throw new GhError(`could not read ${url}`);
  }

  async checks(url: string): Promise<Check[]> {
    try {
      return await this.json(
        ['pr', 'checks', url, '--json', 'bucket,name'],
        (raw) => parseChecks(raw),
        { allowNonZero: true },
      );
    } catch (error) {
      // A PR with no checks at all makes `gh` print nothing rather than `[]`.
      // That is "no checks", which the caller already has a rule for, and not
      // an error worth aborting a sweep over.
      if (error instanceof GhError && /printed no JSON/.test(error.message)) {
        return [];
      }
      throw error;
    }
  }

  async searchPrs(
    qualifier: 'org' | 'user',
    owner: string,
    { limit, includeDrafts }: { limit: number; includeDrafts: boolean },
  ): Promise<{ url: string; createdAt: string }[]> {
    const args = [
      'search',
      'prs',
      `${qualifier}:${owner}`,
      '--state=open',
      '--archived=false',
      '--sort=created',
      '--order=asc',
      `--limit=${limit}`,
      '--json',
      'url,createdAt',
    ];

    if (!includeDrafts) args.push('--draft=false');

    return this.json(args, (raw) => {
      if (!Array.isArray(raw)) {
        throw new GhError('gh search prs: expected an array');
      }
      return raw.map((entry) => {
        const record = entry as Record<string, unknown>;
        return {
          url: asString(record.url, 'url', 'gh search prs'),
          createdAt: asString(record.createdAt, 'createdAt', 'gh search prs'),
        };
      });
    });
  }

  async ready(url: string): Promise<RunResult> {
    return this.call(['pr', 'ready', url]);
  }

  async updateBranch(url: string): Promise<RunResult> {
    return this.call(['pr', 'update-branch', url]);
  }

  /**
   * Squash-merge, pinned to the head we judged.
   *
   * `--match-head-commit` is the whole safety property: between reading the
   * checks and submitting the merge, someone can push. Without it the merge
   * lands on a commit nothing verified.
   *
   * Deliberately no `--admin`. Branch protections stay enforced.
   */
  async squashMerge(url: string, headSha: string): Promise<RunResult> {
    return this.call(['pr', 'merge', url, '--squash', '--match-head-commit', headSha]);
  }
}
