/**
 * Porkbun DNS, from the command line.
 *
 * Porkbun hosts most of the zones here, and its API is the only way to change a
 * record without clicking through the dashboard. The web UI is fine for one
 * record; it is not fine for "point this apex and www at a new host", which is
 * four edits that have to land together.
 *
 * Two things about this API shape the code below.
 *
 * First, **every call is a POST**, including the reads, and the credentials
 * travel in the JSON body rather than a header. So there is no GET to paste into
 * a browser and no `curl -H` that works; a caller has to build the body. That is
 * `porkbunCaller`.
 *
 * Second, **`status` is a field, not the HTTP code**. A refused key, an unknown
 * domain and a malformed record all come back `200 OK` with
 * `{"status":"ERROR","message":"..."}`. Checking `response.ok` therefore reports
 * success for every one of those, which is why {@link callPorkbun} treats the
 * body's own `status` as the verdict and surfaces `message` verbatim.
 */

import { randomUUID } from 'node:crypto';

export const API_BASE = 'https://api.porkbun.com/api/json/v3';

/** Porkbun rejects anything lower, and silently on some endpoints. */
export const MIN_TTL = 600;

export const DEFAULT_TIMEOUT_MS = 20_000;

/** Record types the API accepts. ALIAS is Porkbun's apex-CNAME equivalent. */
export const RECORD_TYPES = [
  'A',
  'AAAA',
  'ALIAS',
  'CAA',
  'CNAME',
  'HTTPS',
  'MX',
  'NS',
  'SRV',
  'SVCB',
  'TLSA',
  'TXT',
] as const;

export type RecordType = (typeof RECORD_TYPES)[number];

export interface Credentials {
  apikey: string;
  secretapikey: string;
}

export interface DnsRecord {
  id: string;
  /** Fully qualified, as Porkbun returns it: `www.example.com`, not `www`. */
  name: string;
  type: string;
  content: string;
  ttl: string;
  prio: string | null;
  notes?: string;
}

export interface UrlForward {
  id: string;
  /** Empty string for the apex. */
  subdomain: string;
  location: string;
  type: string;
  includePath: string;
  wildcard: string;
}

export class PorkbunError extends Error {
  /** Porkbun's machine-readable code, when it sent one: `VERIFICATION_REQUIRED`. */
  readonly code?: string;
  /** Whether Porkbun says trying again could ever work. */
  readonly retryable?: boolean;

  constructor(message: string, details: { code?: string; retryable?: boolean } = {}) {
    super(message);
    this.name = 'PorkbunError';
    if (details.code !== undefined) this.code = details.code;
    if (details.retryable !== undefined) this.retryable = details.retryable;
  }
}

export interface CallOptions {
  /**
   * Replays the first result instead of acting twice, for 24 hours.
   *
   * Only meaningful on a write that costs money: without it, a retry after a
   * timeout that actually succeeded buys the domain a second time.
   */
  idempotencyKey?: string;
}

/** Issue one API call and return its body. Injected so tests never go to the network. */
export type Caller = (
  path: string,
  body?: Record<string, unknown>,
  options?: CallOptions,
) => Promise<Record<string, unknown>>;

/**
 * Turn a response body into either its data or an error.
 *
 * Exported because this is the part worth testing: the failure mode is a 200
 * that means "no", and getting it wrong makes a broken call look like it worked.
 */
export function unwrap(body: unknown, path: string): Record<string, unknown> {
  if (!body || typeof body !== 'object') {
    throw new PorkbunError(`${path}: expected a JSON object, got ${typeof body}`);
  }
  const record = body as Record<string, unknown>;
  if (record.status === 'SUCCESS') return record;

  const message = typeof record.message === 'string' ? record.message : JSON.stringify(record);

  // Newer endpoints answer a refusal with a `code`, and a `next_action` saying
  // what would clear it and whether retrying can ever help. Dropping that turns
  // "verify the account at this URL, retrying will not work" into a bare
  // sentence that reads like a transient — which is exactly the case where
  // someone retries six times instead of opening the page.
  const next = (record.next_action ?? {}) as Record<string, unknown>;
  const code = typeof record.code === 'string' ? record.code : undefined;
  const hint = typeof next.hint === 'string' ? next.hint : undefined;
  const url = typeof next.url === 'string' ? next.url : undefined;
  const retryable = typeof next.retryable === 'boolean' ? next.retryable : undefined;

  const parts = [`${path}: ${message}`];
  if (hint && hint !== message) parts.push(hint);
  if (url) parts.push(url);
  if (retryable === false) parts.push('retrying will not help');

  throw new PorkbunError(parts.join('\n  '), {
    ...(code === undefined ? {} : { code }),
    ...(retryable === undefined ? {} : { retryable }),
  });
}

export function porkbunCaller(
  credentials: Credentials,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  fetcher: typeof fetch = fetch,
): Caller {
  return async (path, body = {}, options = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(`${API_BASE}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
        },
        body: JSON.stringify({ ...credentials, ...body }),
        signal: controller.signal,
      });

      // A non-JSON body here is Porkbun's edge (a 502 page, a rate-limit
      // notice), not the API. Say which, rather than throwing a bare
      // "Unexpected token < in JSON".
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new PorkbunError(
          `${path}: HTTP ${response.status}, and the body was not JSON: ${text.slice(0, 200)}`,
        );
      }
      return unwrap(parsed, path);
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Credentials out of the environment, or a message naming both variables.
 *
 * Both are required and they are easy to half-set — the key is the obvious one
 * and the secret is the one people forget — so a missing secret says so instead
 * of failing later as `Invalid API key`.
 */
export function credentialsFrom(env: Record<string, string | undefined>): Credentials {
  const apikey = env.PORKBUN_API_KEY;
  const secretapikey = env.PORKBUN_SECRET_API_KEY;

  const missing = [
    apikey ? null : 'PORKBUN_API_KEY',
    secretapikey ? null : 'PORKBUN_SECRET_API_KEY',
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new PorkbunError(
      `no Porkbun credentials — missing ${missing.join(' and ')}. ` +
        'Run `cli-tools config pull` to take them from the team vault, ' +
        'or export them.',
    );
  }
  return { apikey: apikey!, secretapikey: secretapikey! };
}

/**
 * The host label Porkbun wants, given whatever the user typed.
 *
 * The API's `name` is the label *relative to the zone* and the apex is the
 * empty string — but nobody types an empty string, and every DNS UI in
 * existence spells the apex `@`. Accepting `@`, an empty value, the bare
 * label and the full name all mean the same thing removes the single most
 * common way to create `www.example.com.example.com`.
 */
export function hostLabel(domain: string, host: string): string {
  const zone = domain.trim().toLowerCase().replace(/\.$/, '');
  const raw = String(host ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');

  if (raw === '' || raw === '@' || raw === zone) return '';
  if (raw.endsWith(`.${zone}`)) return raw.slice(0, -(zone.length + 1));
  return raw;
}

/** The inverse, for display: `''` → `example.com`, `www` → `www.example.com`. */
export function fqdn(domain: string, label: string): string {
  const zone = domain.trim().toLowerCase().replace(/\.$/, '');
  return label ? `${label}.${zone}` : zone;
}

/**
 * Is this record part of Porkbun's parking, rather than something you meant?
 *
 * A parked domain answers with an `ALIAS` at the apex and a `CNAME` on `*`,
 * both pointing at a `*.porkbun.com` host. They are not independent records:
 * they are how a **URL forwarding rule** is implemented, which is why adding an
 * ALIAS "alongside" them changes nothing and why deleting the forward takes all
 * of them with it.
 *
 * Deliberately narrow. The `MX` records at `fwd1.porkbun.com` are Porkbun's
 * *email forwarding* and the `NS` records are the zone's own delegation —
 * treating either as parking would break mail and take the domain off the
 * internet, so only ALIAS and CNAME count.
 */
export function isParkingRecord(record: DnsRecord): boolean {
  if (record.type !== 'ALIAS' && record.type !== 'CNAME') return false;
  const content = record.content.trim().toLowerCase().replace(/\.$/, '');
  return content === 'porkbun.com' || content.endsWith('.porkbun.com');
}

export interface UnparkPlan {
  forwards: UrlForward[];
  records: DnsRecord[];
  /** Nothing to do: the domain was never parked, or already un-parked. */
  empty: boolean;
}

/**
 * What un-parking would remove.
 *
 * Built as a plan so `--dry-run` and the real thing agree by construction, and
 * so the caller can print it before destroying anything.
 */
export function planUnpark(records: readonly DnsRecord[], forwards: readonly UrlForward[]): UnparkPlan {
  const parking = records.filter(isParkingRecord);
  return {
    forwards: [...forwards],
    records: parking,
    empty: forwards.length === 0 && parking.length === 0,
  };
}

/** Sort for display: apex first, then by name, then type. Stable and readable. */
export function sortRecords(records: readonly DnsRecord[], domain: string): DnsRecord[] {
  return [...records].sort((a, b) => {
    const labelA = hostLabel(domain, a.name);
    const labelB = hostLabel(domain, b.name);
    if (labelA !== labelB) {
      if (labelA === '') return -1;
      if (labelB === '') return 1;
      return labelA.localeCompare(labelB);
    }
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return a.content.localeCompare(b.content);
  });
}

/**
 * A fixed-width table.
 *
 * Content is truncated rather than wrapped: a DKIM TXT record is 400 characters
 * and wrapping one turns a 12-row zone into three screens. `--json` is there
 * for the whole value.
 */
export function formatRecords(records: readonly DnsRecord[], domain: string, width = 60): string {
  if (records.length === 0) return 'no records';

  const rows = sortRecords(records, domain).map((record) => ({
    id: record.id,
    type: record.type,
    name: fqdn(domain, hostLabel(domain, record.name)),
    content: record.content.length > width ? `${record.content.slice(0, width - 1)}…` : record.content,
    ttl: record.ttl,
    prio: record.prio && record.prio !== '0' ? record.prio : '',
  }));

  const header = { id: 'ID', type: 'TYPE', name: 'NAME', content: 'CONTENT', ttl: 'TTL', prio: 'PRIO' };
  const all = [header, ...rows];
  const widthOf = (key: keyof typeof header): number =>
    Math.max(...all.map((row) => row[key].length));

  const line = (row: typeof header): string =>
    [
      row.id.padEnd(widthOf('id')),
      row.type.padEnd(widthOf('type')),
      row.name.padEnd(widthOf('name')),
      row.content.padEnd(widthOf('content')),
      row.ttl.padStart(widthOf('ttl')),
      row.prio.padStart(widthOf('prio')),
    ]
      .join('  ')
      .trimEnd();

  return [line(header), ...rows.map(line)].join('\n');
}

export function formatForwards(forwards: readonly UrlForward[], domain: string): string {
  if (forwards.length === 0) return 'no URL forwarding';
  return forwards
    .map(
      (forward) =>
        `${forward.id}  ${fqdn(domain, forward.subdomain)} -> ${forward.location}` +
        `  (${forward.type}${forward.wildcard === 'yes' ? ', wildcard' : ''}` +
        `${forward.includePath === 'yes' ? ', includes path' : ''})`,
    )
    .join('\n');
}

/* ------------------------------------------------------------------------- *
 * Operations
 * ------------------------------------------------------------------------- */

export async function ping(call: Caller): Promise<string> {
  const body = await call('/ping');
  return typeof body.yourIp === 'string' ? body.yourIp : 'unknown';
}

export async function listDomains(call: Caller): Promise<string[]> {
  const body = await call('/domain/listAll');
  const domains = Array.isArray(body.domains) ? body.domains : [];
  return domains
    .map((entry) => (entry && typeof entry === 'object' ? (entry as { domain?: unknown }).domain : null))
    .filter((name): name is string => typeof name === 'string')
    .sort();
}

export async function listRecords(call: Caller, domain: string): Promise<DnsRecord[]> {
  const body = await call(`/dns/retrieve/${domain}`);
  return Array.isArray(body.records) ? (body.records as DnsRecord[]) : [];
}

export async function listForwards(call: Caller, domain: string): Promise<UrlForward[]> {
  const body = await call(`/domain/getUrlForwarding/${domain}`);
  return Array.isArray(body.forwards) ? (body.forwards as UrlForward[]) : [];
}

export interface RecordInput {
  host: string;
  type: string;
  content: string;
  ttl?: number;
  prio?: number;
}

function recordBody(domain: string, input: RecordInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: hostLabel(domain, input.host),
    type: input.type.toUpperCase(),
    content: input.content,
    ttl: String(Math.max(MIN_TTL, input.ttl ?? MIN_TTL)),
  };
  if (input.prio !== undefined) body.prio = String(input.prio);
  return body;
}

export async function createRecord(call: Caller, domain: string, input: RecordInput): Promise<string> {
  const body = await call(`/dns/create/${domain}`, recordBody(domain, input));
  return String(body.id ?? '');
}

export async function editRecord(
  call: Caller,
  domain: string,
  id: string,
  input: RecordInput,
): Promise<void> {
  await call(`/dns/edit/${domain}/${id}`, recordBody(domain, input));
}

export async function deleteRecord(call: Caller, domain: string, id: string): Promise<void> {
  await call(`/dns/delete/${domain}/${id}`);
}

export async function deleteForward(call: Caller, domain: string, id: string): Promise<void> {
  await call(`/domain/deleteUrlForward/${domain}/${id}`);
}

/** Records matching a host (and optionally a type), for `get`, `set` and `delete`. */
export function matchRecords(
  records: readonly DnsRecord[],
  domain: string,
  host: string,
  type?: string,
): DnsRecord[] {
  const label = hostLabel(domain, host);
  const wanted = type?.toUpperCase();
  return records.filter(
    (record) => hostLabel(domain, record.name) === label && (!wanted || record.type === wanted),
  );
}

export type SetOutcome = { action: 'created' | 'updated' | 'unchanged'; id: string };

/**
 * Upsert one record.
 *
 * `set` exists because the obvious two-step — delete, then create — has a
 * window where the name does not resolve at all, and because it needs the
 * record id, which means a list call the user did not ask for. Editing in place
 * keeps the id and the TTL clock.
 *
 * More than one record of the same name and type (a legitimate thing: two TXT
 * values, several A records) is refused rather than guessed at. Picking one to
 * overwrite would silently drop the other.
 */
export async function setRecord(
  call: Caller,
  domain: string,
  input: RecordInput,
): Promise<SetOutcome> {
  const existing = matchRecords(await listRecords(call, domain), domain, input.host, input.type);

  if (existing.length > 1) {
    throw new PorkbunError(
      `${existing.length} ${input.type.toUpperCase()} records already exist for ` +
        `${fqdn(domain, hostLabel(domain, input.host))} — edit one by id, ` +
        'or delete them first. Refusing to guess which to replace.',
    );
  }

  const current = existing[0];
  if (!current) {
    return { action: 'created', id: await createRecord(call, domain, input) };
  }

  const ttl = String(Math.max(MIN_TTL, input.ttl ?? MIN_TTL));
  if (current.content === input.content && current.ttl === ttl) {
    return { action: 'unchanged', id: current.id };
  }

  await editRecord(call, domain, current.id, input);
  return { action: 'updated', id: current.id };
}

/* ------------------------------------------------------------------------- *
 * Registration
 * ------------------------------------------------------------------------- */

/**
 * Money, as Porkbun means it.
 *
 * Prices are quoted as decimal *dollar* strings (`"11.08"`) and
 * `/domain/create` wants an integer count of **cents** that matches the quote
 * exactly. The obvious conversion is a trap: `parseFloat('11.08') * 100` is
 * `1107.9999999999998`, which truncates to `1107` and buys nothing — the API
 * refuses the mismatch. So the decimal is split as text and never becomes a
 * float at all.
 */
export function priceCents(price: string | number): number {
  const text = String(price ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new PorkbunError(`unreadable price from Porkbun: ${JSON.stringify(price)}`);
  }
  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2));
  // A third decimal is not a thing Porkbun quotes, but round it like money
  // rather than silently dropping half a cent if it ever appears.
  return Number(fraction[2] ?? 0) >= 5 ? cents + 1 : cents;
}

/** `$11.08`, from either form. Display only — never send this to the API. */
export function formatPrice(price: string | number): string {
  return `$${(priceCents(price) / 100).toFixed(2)}`;
}

/** Lowercase, trimmed, no trailing dot, and actually shaped like a domain. */
export function normalizeDomain(domain: string): string {
  const zone = String(domain ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(zone)) {
    throw new PorkbunError(`${JSON.stringify(domain)} is not a valid domain name`);
  }
  return zone;
}

/**
 * The TLD, as `/domain/getRegistrationRequirements` spells it.
 *
 * Everything after the first label, so `diskpush.com` is `com` and
 * `example.co.uk` is `co.uk` — which is what that endpoint keys on, rather than
 * the last label alone.
 */
export function tldOf(domain: string): string {
  const zone = normalizeDomain(domain);
  return zone.slice(zone.indexOf('.') + 1);
}

export interface Availability {
  domain: string;
  available: boolean;
  premium: boolean;
  /** The quote, in whole cents — exactly what `/domain/create` must be sent. */
  costCents: number;
  /** The same number for people: `$11.08`. */
  price: string;
  renewal: string | null;
  /** A cheap first year that renews dearer, which is worth saying out loud. */
  firstYearPromo: boolean;
  /** Years. `.com` is 1; some TLDs sell a 2-year minimum. */
  minDuration: number;
}

/**
 * Is it available, and at what price?
 *
 * **Rate limited to one call per ten seconds per account**, which shapes the
 * caller: check once, keep the quote, and spend it. Checking again to
 * "confirm" just before buying earns a rate-limit error instead of a second
 * answer.
 */
export async function checkAvailability(call: Caller, domain: string): Promise<Availability> {
  const zone = normalizeDomain(domain);
  const body = await call(`/domain/checkDomain/${zone}`);
  const response = (body.response ?? {}) as Record<string, unknown>;

  const price = response.price;
  if (price === undefined) {
    throw new PorkbunError(`/domain/checkDomain/${zone}: no price in the response`);
  }
  const additional = (response.additional ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const renewal = additional.renewal?.price;

  return {
    domain: zone,
    available: response.avail === 'yes',
    premium: response.premium === 'yes',
    costCents: priceCents(price as string),
    price: formatPrice(price as string),
    renewal: renewal === undefined ? null : formatPrice(renewal as string),
    firstYearPromo: response.firstYearPromo === 'yes',
    minDuration: Number(response.minDuration ?? 1) || 1,
  };
}

export interface RegistrationRequirements {
  tld: string;
  /** Some TLDs are dashboard-only. Better to hear it here than after a charge. */
  apiRegisterable: boolean;
  whoisPrivacySupported: boolean;
  years: number | null;
  /** Registry eligibility fields (`.us` nexus, `.ca` legal type), or null. */
  registryRequirements: unknown;
}

export async function registrationRequirements(
  call: Caller,
  tld: string,
): Promise<RegistrationRequirements> {
  const body = await call(`/domain/getRegistrationRequirements/${tld}`);
  return {
    tld,
    apiRegisterable: body.apiRegisterable === true,
    whoisPrivacySupported: body.whoisPrivacySupported === true,
    years: typeof body.registrationDurationYears === 'number' ? body.registrationDurationYears : null,
    registryRequirements: body.registryRequirements ?? null,
  };
}

export interface RegistrationPlan {
  domain: string;
  costCents: number;
  price: string;
  renewal: string | null;
  premium: boolean;
  firstYearPromo: boolean;
  years: number | null;
  whoisPrivacy: boolean;
}

export interface RegistrationOptions {
  whoisPrivacy?: boolean;
  /** Refuse to spend more than this, in cents. A typo guard, and a premium guard. */
  maxCents?: number;
}

/**
 * Everything that has to be true before money moves, resolved once.
 *
 * A plan rather than a `register(domain)` that does the lot, for the same
 * reason {@link planUnpark} is a plan: the number shown at the confirmation
 * prompt and the number sent to the registrar are then the same number by
 * construction and cannot drift between the two. It also means the
 * availability check — one per ten seconds — happens exactly once.
 */
export async function planRegistration(
  call: Caller,
  domain: string,
  options: RegistrationOptions = {},
): Promise<RegistrationPlan> {
  const zone = normalizeDomain(domain);
  const requirements = await registrationRequirements(call, tldOf(zone));

  if (!requirements.apiRegisterable) {
    throw new PorkbunError(
      `.${requirements.tld} cannot be registered through the API — buy it in the dashboard`,
    );
  }
  if (requirements.registryRequirements) {
    throw new PorkbunError(
      `.${requirements.tld} needs registry eligibility details this command does not collect ` +
        '— buy it in the dashboard',
    );
  }

  const availability = await checkAvailability(call, zone);
  if (!availability.available) {
    throw new PorkbunError(`${zone} is already registered`);
  }

  const whoisPrivacy = options.whoisPrivacy ?? true;
  if (whoisPrivacy && !requirements.whoisPrivacySupported) {
    throw new PorkbunError(
      `.${requirements.tld} does not support WHOIS privacy — pass --no-whois-privacy to ` +
        'register with your contact details public',
    );
  }
  if (options.maxCents !== undefined && availability.costCents > options.maxCents) {
    throw new PorkbunError(
      `${zone} costs ${availability.price}, over the --max-price limit` +
        `${availability.premium ? ' — it is a premium name' : ''}`,
    );
  }

  return {
    domain: zone,
    costCents: availability.costCents,
    price: availability.price,
    renewal: availability.renewal,
    premium: availability.premium,
    firstYearPromo: availability.firstYearPromo,
    years: requirements.years,
    whoisPrivacy,
  };
}

function createBody(plan: RegistrationPlan): Record<string, unknown> {
  return {
    cost: plan.costCents,
    agreeToTerms: 'yes',
    whoisPrivacy: plan.whoisPrivacy ? 'yes' : 'no',
  };
}

export interface RegistrationPreview {
  wouldSucceed: boolean;
  /** Porkbun's own rendering of the charge, e.g. `$11.08`. */
  costDisplay: string | null;
  balance: string | null;
  sufficientFunds: boolean | null;
  /** Null when no monthly API spend cap is set on the account. */
  withinMonthlySpendLimit: boolean | null;
}

/**
 * Every pre-flight check Porkbun would run, without charging or creating.
 *
 * Worth preferring over checking things locally: this is the only way to see
 * the account-level gates — funds, the monthly API spend cap, and whether the
 * account is verified at all — none of which any read endpoint exposes. It
 * does not consume the create rate-limit budget either.
 *
 * A refused pre-flight arrives as a {@link PorkbunError} carrying Porkbun's
 * `code`, so `VERIFICATION_REQUIRED` is distinguishable from a price mismatch.
 */
export async function previewRegistration(
  call: Caller,
  plan: RegistrationPlan,
): Promise<RegistrationPreview> {
  const body = await call(`/domain/create/${plan.domain}`, { ...createBody(plan), dryRun: true });
  const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

  return {
    wouldSucceed: body.wouldSucceed === true,
    costDisplay: typeof body.costDisplay === 'string' ? body.costDisplay : null,
    balance: typeof body.balance === 'string' ? body.balance : null,
    sufficientFunds: bool(body.sufficientFunds),
    withinMonthlySpendLimit: bool(body.withinMonthlySpendLimit),
  };
}

/**
 * Buy the domain the plan describes.
 *
 * Takes a {@link RegistrationPlan} rather than a domain and a price so nothing
 * between the prompt and the purchase can substitute a different number.
 * `cost` has to equal Porkbun's live quote or the call is refused, which is the
 * safety net: a stale plan fails instead of quietly overpaying.
 *
 * The idempotency key is not optional in practice. A create that times out has
 * still very likely registered the domain, and the natural response — run it
 * again — buys and bills a second year. Keyed, the retry replays the first
 * result for 24 hours instead.
 */
export async function registerDomain(
  call: Caller,
  plan: RegistrationPlan,
  idempotencyKey: string = randomUUID(),
): Promise<void> {
  await call(`/domain/create/${plan.domain}`, createBody(plan), { idempotencyKey });
}
