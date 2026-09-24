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

/**
 * The refusal GitHub returns from the GraphQL merge mutation for a pull
 * request that belongs to a stack. Matched as a substring because the rest of
 * the sentence carries a docs URL that is not ours to depend on.
 */
export const STACK_REFUSAL = 'asynchronous merge REST API';

/** `https://github.com/owner/repo/pull/7` → `{ slug: 'owner/repo', number: 7 }`. */
export function parsePullRequestUrl(
  url: string,
): { slug: string; number: string } | undefined {
  const match = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  return match ? { slug: match[1]!, number: match[2]! } : undefined;
}

export interface MergeAsyncState {
  status?: string | undefined;
  uuid?: string | undefined;
  message?: string | undefined;
}

/**
 * Read one asynchronous-merge reply. Unparseable output is not an error here:
 * the caller treats a missing uuid as "stop polling" and reports that the
 * merge never settled, which is truer than inventing a status.
 */
export function parseMergeAsync(stdout: string): MergeAsyncState | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return undefined;
  }

  if (typeof raw !== 'object' || raw === null) return undefined;

  const record = raw as Record<string, unknown>;
  const details = (record.details ?? {}) as Record<string, unknown>;

  return {
    status: typeof record.status === 'string' ? record.status : undefined,
    uuid: typeof details.uuid === 'string' ? details.uuid : undefined,
    message: typeof details.message === 'string' ? details.message : undefined,
  };
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
   *
   * `gh pr merge` calls the GraphQL mergePullRequest mutation, and GitHub
   * refuses that mutation outright for a PR that belongs to a stack, naming
   * the asynchronous merge REST endpoint instead. Nothing is wrong with such
   * a PR — it reports MERGEABLE and CLEAN — so there is no repair to attempt
   * and no honest way to call it a refusal. Fall back to that endpoint.
   */
  async squashMerge(
    url: string,
    headSha: string,
    { pollMs = 2_000, attempts = 30 }: { pollMs?: number; attempts?: number } = {},
  ): Promise<RunResult> {
    const direct = await this.call([
      'pr',
      'merge',
      url,
      '--squash',
      '--match-head-commit',
      headSha,
    ]);

    if (direct.code === 0) return direct;

    // Keyed on the message rather than on the base branch: GitHub still calls
    // a PR stacked after it has retargeted it onto the default branch.
    if (!`${direct.stderr}${direct.stdout}`.includes(STACK_REFUSAL)) return direct;

    return this.mergeAsync(url, headSha, { pollMs, attempts });
  }

  /**
   * The asynchronous merge endpoint enqueues the squash and hands back a uuid
   * to poll. The head stays pinned and no `--admin` is passed, so the PR is
   * held to exactly the rules it would have been held to above.
   */
  private async mergeAsync(
    url: string,
    headSha: string,
    { pollMs, attempts }: { pollMs: number; attempts: number },
  ): Promise<RunResult> {
    const target = parsePullRequestUrl(url);
    if (!target) {
      return { code: 1, stdout: '', stderr: `cannot read owner/repo from ${url}` };
    }

    const endpoint = `repos/${target.slug}/pulls/${target.number}/merge-async`;

    let response = await this.call([
      'api',
      '--method',
      'PUT',
      endpoint,
      '-f',
      'merge_method=squash',
      '-f',
      `sha=${headSha}`,
    ]);

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (response.code !== 0) return response;

      const state = parseMergeAsync(response.stdout);

      // `enqueued` means a merge queue owns it from here, which is as merged
      // as this tool can make it.
      if (state?.status === 'merged' || state?.status === 'enqueued') {
        return {
          code: 0,
          stdout: `Merged ${url} via the asynchronous merge API`,
          stderr: '',
        };
      }

      if (state?.status === 'failed') {
        return { code: 1, stdout: '', stderr: state.message ?? 'async merge failed' };
      }

      if (!state?.uuid) break;

      await sleep(pollMs);
      response = await this.call(['api', `${endpoint}/${state.uuid}`]);
    }

    return { code: 1, stdout: '', stderr: `async merge never settled for ${url}` };
  }
}
