#!/usr/bin/env -S npx --yes tsx
/**
 * domainjson — whois-style, JSON-first name lookup.
 *
 * One JSON object on stdout:
 *
 *   { "name": ..., "rdap": {...} | "moshpit": {...}, "dns": {...} }
 *
 * Names ending in a Moshpit TLD (https://pit.moshcode.sh) are served from the
 * registry API; everything else goes through the OpenRDAP CLI (`rdap`), whose
 * flags are passed through unchanged except the output-format flags — the RDAP
 * portion is always JSON. Either way, dig adds records, hosts, reverse, and
 * per-nameserver AXFR attempts.
 */

import { isMain } from '../src/is-main.ts';
import {
  DEFAULT_REGISTRY,
  DEFAULT_TIMEOUT_MS,
  dnsSection,
  fetchPitTlds,
  findRdapBinary,
  moshpitSection,
  parseDomainArgs,
  rdapSection,
} from '../src/domain.ts';

const USAGE = `Usage:
  domainjson [openrdap-args...] <name>
  domainjson --name example.com
  domainjson --registry https://pit.moshcode.sh --timeout 4000 example.hacker

The final non-flag argument is the name to look up. OpenRDAP flags
(-s/--server, -t/--type, -T/--timeout, -k, --bs-url, --cache-dir, -P/-C/-K,
...) are passed through unchanged; output-format flags (--text, --whois,
--raw, --json) are dropped and JSON is always forced.

Options:
  --registry URL   Moshpit registry base URL (default: ${DEFAULT_REGISTRY})
  --timeout MS     per-query timeout for HTTP and dig (default: ${DEFAULT_TIMEOUT_MS})
  --name NAME      the name to look up (alternative to the positional)
  -h, --help       show this help
`;

/** Errors are JSON too. A tool whose output is parsed should not switch shape. */
function fail(message: string, code = 2): never {
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(code);
}

if (isMain(import.meta.url)) {
  const parsed = parseDomainArgs(process.argv.slice(2));

  if (parsed.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  if (parsed.error) {
    if (parsed.error === 'no name given') process.stderr.write(USAGE);
    fail(parsed.error);
  }

  const { own, passthrough } = parsed;
  const name = own.name!.toLowerCase();
  const out: Record<string, unknown> = { name };

  let moshpitData: Record<string, unknown> | null = null;
  let registryNote: string | null = null;

  try {
    const tlds = await fetchPitTlds(own.registry, own.timeout);
    const ending = name.includes('.') ? (name.split('.').pop() ?? null) : null;
    if (ending && tlds.has(ending)) {
      moshpitData = await moshpitSection(own.registry, name, own.timeout);
      out.moshpit = moshpitData;
    }
  } catch (error) {
    // Registry unreachable: carry on as a plain RDAP+DNS lookup, but say so
    // rather than letting the absence of a moshpit section imply the name is
    // simply not one.
    registryNote = `moshpit registry unavailable: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }

  if (!moshpitData) {
    const binary = await findRdapBinary();
    const rdap = binary
      ? await rdapSection(binary, passthrough, name, own.timeout)
      : {
          error:
            'openrdap CLI not found (looked for ~/go/bin/rdap, rdap, openrdap on PATH)',
        };
    if (registryNote) rdap.note = registryNote;
    out.rdap = rdap;
  }

  const dns = await dnsSection(name, own.timeout, moshpitData);
  out.dns = dns;

  const rdapOk = Boolean(out.rdap) && !(out.rdap as { error?: unknown }).error;
  const moshpitOk = Boolean(out.moshpit);
  const dnsOk = Object.keys(dns.records).length > 0 || dns.hosts.length > 0;

  if (!rdapOk && !moshpitOk && !dnsOk) {
    out.error = 'every data source failed (moshpit, rdap, dns)';
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(1);
  }

  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}
