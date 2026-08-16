import { Gh, GhError } from './gh.ts';
import { clean, supportsHyperlinks, table, timeAgo, truncate } from './format.ts';
import { run } from './exec.ts';

export interface SearchedPr {
  url: string;
  number: number;
  title: string;
  createdAt: string;
  updatedAt: string;
  repository: { nameWithOwner: string };
  author: { login: string } | null;
}

export interface ListOptions {
  orgs: string[];
  users: string[];
  limit: number;
  hyperlinks?: boolean;
  now?: Date;
}

const HEADER = [
  'ORG/USER',
  'REPOSITORY',
  'PR',
  'AUTHOR',
  'TITLE',
  'UPDATED',
  'LINK',
] as const;

function parse(raw: unknown): SearchedPr[] {
  if (!Array.isArray(raw)) throw new GhError('gh search prs: expected an array');

  return raw.map((entry) => {
    const record = entry as Record<string, unknown>;
    const repository = (record.repository ?? {}) as Record<string, unknown>;
    const author = record.author as Record<string, unknown> | null | undefined;

    return {
      url: String(record.url ?? ''),
      number: Number(record.number ?? 0),
      title: String(record.title ?? ''),
      createdAt: String(record.createdAt ?? ''),
      updatedAt: String(record.updatedAt ?? ''),
      repository: { nameWithOwner: String(repository.nameWithOwner ?? '') },
      author: author && typeof author.login === 'string' ? { login: author.login } : null,
    };
  });
}

export async function search(
  options: ListOptions,
  exec: typeof run = run,
): Promise<SearchedPr[]> {
  const found = new Map<string, SearchedPr>();
  const warnings: string[] = [];

  for (const [qualifier, owners] of [
    ['org', options.orgs],
    ['user', options.users],
  ] as const) {
    for (const owner of owners) {
      const result = await exec(
        'gh',
        [
          'search',
          'prs',
          `${qualifier}:${owner}`,
          '--state=open',
          '--archived=false',
          '--sort=created',
          '--order=desc',
          `--limit=${options.limit}`,
          '--json',
          'repository,number,title,url,author,createdAt,updatedAt',
        ],
        { env: { ...process.env, GH_PAGER: 'cat' } },
      );

      if (result.code !== 0) {
        warnings.push(`skipped inaccessible or invalid scope ${qualifier}:${owner}`);
        continue;
      }

      for (const pr of parse(JSON.parse(result.stdout || '[]'))) {
        if (!found.has(pr.url)) found.set(pr.url, pr);
      }
    }
  }

  for (const warning of warnings) process.stderr.write(`WARN: ${warning}\n`);

  // Newest first, matching the original's sort_by(.createdAt) | reverse.
  return [...found.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function renderTable(prs: readonly SearchedPr[], options: ListOptions = {} as ListOptions): string {
  const rows: string[][] = [[...HEADER]];
  const urls: (string | undefined)[] = [undefined];

  for (const pr of prs) {
    rows.push([
      pr.repository.nameWithOwner.split('/')[0] ?? '',
      pr.repository.nameWithOwner,
      `#${pr.number}`,
      pr.author?.login ?? '-',
      truncate(clean(pr.title), 70),
      timeAgo(pr.updatedAt, options.now ?? new Date()),
      pr.url,
    ]);
    urls.push(pr.url);
  }

  return table(rows, {
    // The PR number and the URL are both clickable, as before.
    linkColumns: [2, 6],
    urls,
    hyperlinks: options.hyperlinks ?? supportsHyperlinks(),
  });
}

export async function list(options: ListOptions, exec: typeof run = run): Promise<string> {
  const prs = await search(options, exec);
  if (prs.length === 0) return 'No open PRs found.';
  return renderTable(prs, options);
}

export { Gh };
