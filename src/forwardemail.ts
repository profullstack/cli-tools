/**
 * Forward Email aliases, from the command line.
 *
 * profullstack.com and c0upons.com receive mail through Forward Email on a paid
 * plan, and on a paid plan an alias exists only in the account: the DNS
 * `forward-email=` TXT records the free plan reads are ignored. So without this
 * an address like submit@c0upons.com could only be made in the dashboard, whose
 * login sits behind Cloudflare Turnstile.
 *
 * The API wants an account **API token** (My Account > Security), sent as the
 * Basic-auth username with an empty password. The account password is refused
 * with 401 "Invalid API token", which is the trap that kept this manual.
 *
 * `ensureAlias` is the one that matters: idempotent, so a cron job can call it
 * every run. It adds the recipients it was given to whatever the alias already
 * forwards to and never removes one, so pointing an existing address at a
 * webhook does not silently cut off the person it used to reach.
 */

export const API_BASE = 'https://api.forwardemail.net/v1';
export const DEFAULT_TIMEOUT_MS = 20_000;

export class ForwardEmailError extends Error {
  // A plain field, not a parameter property: node's type stripping refuses those.
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'ForwardEmailError';
    this.status = status;
  }
}

export interface Alias {
  id: string;
  name: string;
  recipients: string[];
  is_enabled: boolean;
  description?: string;
}

export type Fetch = typeof fetch;

export interface Client {
  call<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T>;
}

export function client(token: string, doFetch: Fetch = fetch, base = API_BASE): Client {
  if (!token) throw new ForwardEmailError('no Forward Email API token (FORWARDEMAIL_API_TOKEN)');
  const auth = `Basic ${Buffer.from(`${token}:`).toString('base64')}`;
  return {
    async call<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
      const res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          authorization: auth,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* keep the text for the error */
      }
      if (!res.ok) {
        const message = (json as { message?: string } | null)?.message ?? text.slice(0, 300);
        throw new ForwardEmailError(`${method} ${path}: ${res.status} ${message}`.trim(), res.status);
      }
      return json as T;
    },
  };
}

/** "submit@c0upons.com" -> { name: "submit", domain: "c0upons.com" }. */
export function splitAddress(address: string): { name: string; domain: string } {
  const m = /^([^@\s]+)@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(address.trim());
  if (!m) throw new ForwardEmailError(`not an email address: ${JSON.stringify(address)}`);
  return { name: m[1]!.toLowerCase(), domain: m[2]!.toLowerCase() };
}

function normalise(raw: Record<string, unknown>): Alias {
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    recipients: Array.isArray(raw.recipients) ? raw.recipients.map(String) : [],
    is_enabled: raw.is_enabled !== false,
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
  };
}

export async function listAliases(api: Client, domain: string): Promise<Alias[]> {
  const rows = await api.call<Record<string, unknown>[]>('GET', `/domains/${encodeURIComponent(domain)}/aliases?limit=1000`);
  return (rows ?? []).map(normalise);
}

export async function findAlias(api: Client, domain: string, name: string): Promise<Alias | null> {
  const rows = await api.call<Record<string, unknown>[]>(
    'GET',
    `/domains/${encodeURIComponent(domain)}/aliases?name=${encodeURIComponent(name)}`,
  );
  const hit = (rows ?? []).map(normalise).find((a) => a.name.toLowerCase() === name.toLowerCase());
  return hit ?? null;
}

/** Same recipient? Webhook URLs compare as written; addresses ignore case. */
function sameRecipient(a: string, b: string): boolean {
  return /^https?:\/\//i.test(a) ? a === b : a.toLowerCase() === b.toLowerCase();
}

export type EnsureOutcome = 'created' | 'updated' | 'unchanged';

/**
 * Make `address` exist, be enabled, and forward to at least `recipients`.
 * Never removes a recipient the alias already had.
 */
export async function ensureAlias(
  api: Client,
  address: string,
  recipients: string[],
  description?: string,
): Promise<{ outcome: EnsureOutcome; alias: Alias }> {
  if (!recipients.length) throw new ForwardEmailError('ensure needs at least one recipient');
  const { name, domain } = splitAddress(address);
  const path = `/domains/${encodeURIComponent(domain)}/aliases`;
  const existing = await findAlias(api, domain, name);
  if (!existing) {
    const created = await api.call<Record<string, unknown>>('POST', path, {
      name,
      recipients,
      is_enabled: true,
      ...(description ? { description } : {}),
    });
    return { outcome: 'created', alias: normalise(created) };
  }
  const missing = recipients.filter((r) => !existing.recipients.some((have) => sameRecipient(have, r)));
  if (!missing.length && existing.is_enabled) return { outcome: 'unchanged', alias: existing };
  const updated = await api.call<Record<string, unknown>>('PUT', `${path}/${encodeURIComponent(existing.id)}`, {
    recipients: [...existing.recipients, ...missing],
    is_enabled: true,
  });
  return { outcome: 'updated', alias: normalise(updated) };
}

export async function removeAlias(api: Client, address: string): Promise<boolean> {
  const { name, domain } = splitAddress(address);
  const existing = await findAlias(api, domain, name);
  if (!existing) return false;
  await api.call('DELETE', `/domains/${encodeURIComponent(domain)}/aliases/${encodeURIComponent(existing.id)}`);
  return true;
}

/** A webhook URL with its secret query value masked, for printing. */
export function maskRecipient(recipient: string): string {
  return recipient.replace(/([?&](?:key|token|secret)=)[^&]+/gi, '$1…');
}

export function formatAliases(aliases: Alias[], domain: string): string {
  if (!aliases.length) return `(no aliases on ${domain})`;
  return aliases
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => `${`${a.name}@${domain}`.padEnd(32)} ${a.is_enabled ? '' : '[disabled] '}${a.recipients.map(maskRecipient).join(', ')}`)
    .join('\n');
}
