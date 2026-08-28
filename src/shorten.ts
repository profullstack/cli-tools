/**
 * Short links against the Moshpit registry.
 *
 * The registry at pit.moshcode.sh mints the codes and serves the redirect at
 * `/f/<code>`; this is a client for that and nothing more. Deliberately not a
 * local shortener: a code that only resolved from the machine that made it
 * would not be a link, and a second implementation of the redirect would be a
 * second place for the rules about what may be redirected to to drift.
 *
 * The HTTP call is injected the way `ask-web`'s is, so everything about how a
 * request is shaped and how an answer is read can be tested without a network
 * or an account.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where the codes live. */
export const DEFAULT_BASE = 'https://pit.moshcode.sh';

export interface Link {
  code: string;
  url: string;
  short: string;
  name: string | null;
  hits: number;
  created_at?: number;
  created?: boolean;
}

export interface Caller {
  (path: string, init: { method: string; body?: unknown }): Promise<{
    status: number;
    body: unknown;
  }>;
}

export class ShortenError extends Error {}

export function baseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.MOSHPIT_REGISTRY || DEFAULT_BASE).replace(/\/+$/, '');
}

/**
 * The token to authenticate with.
 *
 * Three sources, in the order that surprises least. `MOSHCODE_API_KEY` wins for
 * the same reason every key here lets the environment win — CI and a one-off
 * shell override have to be able to. Then the cli-tools store, for a machine
 * that has a key but no moshcode. Then `~/.moshcode/credentials.json`, which is
 * what `moshcode login` already wrote: on a box where the pit works, this
 * command should need no configuration at all.
 */
export function resolveToken(
  env: NodeJS.ProcessEnv = process.env,
  stored: Record<string, string | undefined> = {},
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): string | null {
  const fromEnv = env.MOSHCODE_API_KEY?.trim();
  if (fromEnv) return fromEnv;

  const fromStore = stored['MOSHCODE_API_KEY']?.trim();
  if (fromStore) return fromStore;

  try {
    const raw = JSON.parse(readFile(join(homedir(), '.moshcode', 'credentials.json'))) as {
      token?: unknown;
    };
    const token = typeof raw?.token === 'string' ? raw.token.trim() : '';
    return token || null;
  } catch {
    // Not logged in on this machine, or the file is not readable. Either way
    // the caller's message is the same one.
    return null;
  }
}

/** A caller that actually talks to the registry. */
export function registryCaller(token: string, base: string, timeoutMs = 20_000): Caller {
  return async (path, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${base}${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: controller.signal,
      });
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return { status: response.status, body };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ShortenError(`${base} did not answer within ${timeoutMs}ms`);
      }
      throw new ShortenError(
        `${base} unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Turn a non-2xx into the message the registry sent.
 *
 * The registry's refusals are written for a person — "javascript links cannot
 * be shortened", "that is already a short link" — so passing them through beats
 * anything this side could invent from a status code.
 */
function unwrap(status: number, body: unknown): Record<string, unknown> {
  const payload = (body ?? {}) as Record<string, unknown>;
  if (status === 401) {
    throw new ShortenError('the registry rejected the credentials — run `moshcode login`');
  }
  if (status < 200 || status >= 300) {
    const error = typeof payload.error === 'string' ? payload.error : `the registry said ${status}`;
    throw new ShortenError(error);
  }
  return payload;
}

export async function shorten(
  url: string,
  call: Caller,
  { name }: { name?: string | undefined } = {},
): Promise<Link> {
  const { status, body } = await call('/api/moshpit/links', {
    method: 'POST',
    body: { url, ...(name ? { name } : {}) },
  });
  return unwrap(status, body) as unknown as Link;
}

export async function listLinks(call: Caller): Promise<Link[]> {
  const { status, body } = await call('/api/moshpit/links', { method: 'GET' });
  const payload = unwrap(status, body);
  return Array.isArray(payload.links) ? (payload.links as Link[]) : [];
}

export async function removeLink(code: string, call: Caller): Promise<string> {
  const { status, body } = await call(`/api/moshpit/links/${encodeURIComponent(code)}`, {
    method: 'DELETE',
  });
  const payload = unwrap(status, body);
  return typeof payload.code === 'string' ? payload.code : code;
}

/** One link, as a line. The short URL first, because that is what gets copied. */
export function formatLink(link: Link, { bare = false }: { bare?: boolean } = {}): string {
  if (bare) return `${link.short}\n`;
  return `${link.short} → ${link.url}\n`;
}

export function formatList(links: Link[]): string {
  if (links.length === 0) return 'no short links yet — shorten <url> mints one\n';
  return links
    .map((link) => {
      const hits = `${link.hits} hit${link.hits === 1 ? '' : 's'}`;
      const filed = link.name ? ` · ${link.name}` : '';
      return `${link.short} → ${link.url}\n  ${hits}${filed}\n`;
    })
    .join('');
}
