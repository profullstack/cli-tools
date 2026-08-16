import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { run } from './exec.ts';

export const DEFAULT_REGISTRY = 'https://pit.moshcode.sh';
export const DEFAULT_TIMEOUT_MS = 4000;
export const DIG = '/usr/bin/dig';
export const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'] as const;

export type RecordType = (typeof RECORD_TYPES)[number];

/** OpenRDAP flags producing non-JSON output; dropped because JSON is forced. */
export const OUTPUT_FORMAT_FLAGS = new Set([
  '--text', '-w', '--whois', '-r', '--raw', '-j', '--json',
]);

/** OpenRDAP flags that consume the next argument, so it is not the name. */
export const VALUE_FLAGS = new Set([
  '-T', '--timeout',
  '-s', '--server',
  '-t', '--type',
  '--cache-dir', '--bs-url', '--bs-ttl',
  '-P', '--p12',
  '-C', '--cert',
  '-K', '--key',
]);

export interface OwnOptions {
  registry: string;
  timeout: number;
  name: string | null;
}

export interface ParsedDomainArgs {
  own: OwnOptions;
  passthrough: string[];
  help?: boolean;
  error?: string;
}

/**
 * Split our flags from OpenRDAP's.
 *
 * Unlike the shared `parseArgs`, this one must pass through flags it does not
 * know, because most of them belong to another program. So it cannot reject an
 * unknown option, and the price is that it has to know which foreign flags
 * consume a value — otherwise `-s https://rdap.example` reads the URL as the
 * name to look up.
 */
export function parseDomainArgs(argv: readonly string[]): ParsedDomainArgs {
  const own: OwnOptions = {
    registry: DEFAULT_REGISTRY,
    timeout: DEFAULT_TIMEOUT_MS,
    name: null,
  };
  const passthrough: string[] = [];
  const positionals: string[] = [];

  const bad = (message: string): ParsedDomainArgs => ({ own, passthrough, error: message });

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;

    if (argument === '-h' || argument === '--help') return { own, passthrough, help: true };

    if (argument === '--registry' || argument === '--timeout' || argument === '--name') {
      const value = argv[index + 1];
      index += 1;
      if (value === undefined) return bad(`${argument} requires a value`);

      if (argument === '--registry') own.registry = value.replace(/\/+$/, '');
      else if (argument === '--name') own.name = value;
      else {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return bad('--timeout must be a positive integer (ms)');
        }
        own.timeout = parsed;
      }
      continue;
    }

    if (argument.startsWith('--registry=')) {
      own.registry = argument.slice('--registry='.length).replace(/\/+$/, '');
      continue;
    }

    if (argument.startsWith('--timeout=')) {
      const parsed = Number.parseInt(argument.slice('--timeout='.length), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return bad('--timeout must be a positive integer (ms)');
      }
      own.timeout = parsed;
      continue;
    }

    if (argument.startsWith('--name=')) {
      own.name = argument.slice('--name='.length);
      continue;
    }

    const flagName = argument.startsWith('--') ? (argument.split('=')[0] ?? argument) : argument;

    if (OUTPUT_FORMAT_FLAGS.has(flagName)) continue;

    if (argument.startsWith('-')) {
      passthrough.push(argument);
      if (!argument.includes('=') && VALUE_FLAGS.has(flagName)) {
        const value = argv[index + 1];
        index += 1;
        if (value === undefined) return bad(`${argument} requires a value`);
        passthrough.push(value);
      }
      continue;
    }

    positionals.push(argument);
  }

  // The final non-flag argument is the name; earlier positionals go to rdap.
  if (!own.name && positionals.length > 0) own.name = positionals.pop() ?? null;
  passthrough.push(...positionals);

  if (!own.name) return bad('no name given');

  return { own, passthrough };
}

export async function fetchJson(url: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return (await response.json()) as Record<string, unknown>;
}

export async function dig(args: readonly string[], timeoutMs: number): Promise<string> {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const result = await run(DIG, [`+time=${seconds}`, '+tries=1', ...args], {
    timeoutMs: timeoutMs + 1000,
  });
  if (result.code !== 0 && !result.stdout) {
    throw new Error(result.stderr.trim() || `dig exited ${result.code}`);
  }
  return result.stdout;
}

const lines = (text: string): string[] =>
  text.split('\n').map((line) => line.trim()).filter(Boolean);

export async function digLines(
  name: string,
  type: string,
  server: string | null,
  timeoutMs: number,
): Promise<string[]> {
  const args = [...(server ? [`@${server}`, '-p', '5354'] : []), '+short', name, type];
  return lines(await dig(args, timeoutMs));
}

export function tcpOpen(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (open: boolean): void => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

export async function findRdapBinary(): Promise<string | null> {
  const candidates = [path.join(os.homedir(), 'go', 'bin', 'rdap'), 'rdap', 'openrdap'];

  for (const candidate of candidates) {
    try {
      if (candidate.includes(path.sep)) {
        await access(candidate, constants.X_OK);
      } else {
        const found = await run('which', [candidate]);
        if (found.code !== 0) continue;
      }
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/**
 * Every Moshpit ending, paged.
 *
 * The registry paginates at 1000. Any failure means "treat as non-moshpit",
 * which is why the caller wraps this rather than this swallowing errors: a
 * registry outage should downgrade the lookup, not silently claim the name is
 * not a Moshpit one.
 */
export async function fetchPitTlds(registry: string, timeoutMs: number): Promise<Set<string>> {
  const first = await fetchJson(`${registry}/api/moshpit/tlds?limit=1000&offset=0`, timeoutMs);
  const entries: unknown[] = [...((first.tlds as unknown[]) ?? [])];
  const total = typeof first.total === 'number' ? first.total : entries.length;

  const pages: Promise<void>[] = [];
  for (let offset = entries.length; offset < total; offset += 1000) {
    pages.push(
      fetchJson(`${registry}/api/moshpit/tlds?limit=1000&offset=${offset}`, timeoutMs).then(
        (page) => {
          entries.push(...((page.tlds as unknown[]) ?? []));
        },
      ),
    );
  }
  await Promise.all(pages);

  return new Set(
    entries
      .map((entry) =>
        typeof entry === 'string' ? entry : String((entry as { tld?: unknown })?.tld ?? ''),
      )
      .filter(Boolean),
  );
}

export async function moshpitSection(
  registry: string,
  name: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const query = `name=${encodeURIComponent(name)}`;
  const [resolved, pins] = await Promise.all([
    fetchJson(`${registry}/api/moshpit/resolve?${query}&records=1`, timeoutMs),
    fetchJson(`${registry}/api/moshpit/pins?${query}`, timeoutMs).catch(() => null),
  ]);
  return { ...resolved, pins: (pins?.pins as unknown[]) ?? [] };
}

export async function rdapSection(
  binary: string,
  passthrough: readonly string[],
  name: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const result = await run(binary, [...passthrough, '--json', name], {
    timeoutMs: Math.max(timeoutMs * 4, 30_000),
  });

  if (result.code !== 0) {
    return { error: `openrdap failed: ${result.stderr.trim() || `exited ${result.code}`}` };
  }

  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch (error) {
    return {
      error: `openrdap failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export interface DnsSection {
  records: Partial<Record<RecordType, string[]>>;
  hosts: string[];
  reverse: { address: string; ptr: string[] }[];
  axfr: { ns: string; transfer: string; lines?: number }[];
}

export async function dnsSection(
  name: string,
  timeoutMs: number,
  moshpitData: Record<string, unknown> | null,
): Promise<DnsSection> {
  const section: DnsSection = { records: {}, hosts: [], reverse: [], axfr: [] };

  // Moshpit names resolve through the local bridge on 127.0.0.1:5354 when it
  // is up; otherwise fall back to what the registry API returned.
  const bridge = moshpitData ? await tcpOpen(5354, Math.min(timeoutMs, 1500)) : false;
  const server = bridge ? '127.0.0.1' : null;

  if (moshpitData && !bridge) {
    const records = moshpitData.records as Record<string, unknown> | undefined;
    if (records && typeof records === 'object') {
      for (const type of RECORD_TYPES) {
        const values = records[type] ?? records[type.toLowerCase()];
        if (Array.isArray(values) && values.length > 0) {
          section.records[type] = values.map(String);
        }
      }
    }

    const hosts = new Set<string>();
    if (typeof moshpitData.target === 'string' && moshpitData.target) {
      hosts.add(moshpitData.target);
    }
    for (const value of section.records.A ?? []) hosts.add(value);
    for (const value of section.records.AAAA ?? []) hosts.add(value);
    section.hosts = [...hosts];
  } else {
    // One query per type, deliberately not ANY: authoritative servers are
    // allowed to answer ANY with a minimal subset.
    const answers = await Promise.all(
      RECORD_TYPES.map(async (type) => {
        try {
          return [type, await digLines(name, type, server, timeoutMs)] as const;
        } catch {
          return [type, [] as string[]] as const;
        }
      }),
    );

    for (const [type, found] of answers) {
      if (found.length > 0) section.records[type] = found;
    }

    section.hosts = [
      ...new Set([...(section.records.A ?? []), ...(section.records.AAAA ?? [])]),
    ];
  }

  section.reverse = await Promise.all(
    section.hosts.map(async (address) => {
      try {
        const out = await dig(
          [...(server ? [`@${server}`, '-p', '5354'] : []), '+short', '-x', address],
          timeoutMs,
        );
        return { address, ptr: lines(out) };
      } catch {
        return { address, ptr: [] };
      }
    }),
  );

  // AXFR against each authoritative nameserver; refusal is data, not failure.
  for (const ns of section.records.NS ?? []) {
    const host = ns.replace(/\.$/, '');
    const entry: { ns: string; transfer: string; lines?: number } = {
      ns: host,
      transfer: 'failed',
    };
    try {
      const out = await dig([`@${host}`, name, 'AXFR'], timeoutMs);
      if (/status:\s*REFUSED/i.test(out)) {
        entry.transfer = 'refused';
      } else if (/XFR size:/i.test(out)) {
        entry.transfer = 'ok';
        entry.lines = out
          .split('\n')
          .filter((line) => line.trim() && !line.startsWith(';')).length;
      }
    } catch {
      // stays "failed"
    }
    section.axfr.push(entry);
  }

  return section;
}
