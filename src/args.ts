/**
 * Argument parsing shared by every tool here.
 *
 * The bash originals hand-rolled a `while (($#))` loop per script, each
 * supporting `--flag value` and `--flag=value` by writing both cases out. They
 * drifted: one validated its numeric input, another accepted `--limit abc` and
 * failed later inside an arithmetic expansion with a message naming neither
 * the flag nor the value.
 */

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface ParsedArgs {
  flags: Set<string>;
  values: Map<string, string>;
  positional: string[];
}

export interface Spec {
  /** Flags that take no value. */
  boolean?: readonly string[];
  /** Flags that require a value. */
  string?: readonly string[];
}

export function parseArgs(argv: readonly string[], spec: Spec): ParsedArgs {
  const booleans = new Set(spec.boolean ?? []);
  const strings = new Set(spec.string ?? []);

  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;

    if (argument === '--') {
      positional.push(...argv.slice(index + 1));
      break;
    }

    if (!argument.startsWith('-')) {
      positional.push(argument);
      continue;
    }

    const equals = argument.indexOf('=');
    const name = equals === -1 ? argument : argument.slice(0, equals);
    const inline = equals === -1 ? undefined : argument.slice(equals + 1);

    if (booleans.has(name)) {
      if (inline !== undefined) {
        throw new UsageError(`${name} does not take a value`);
      }
      flags.add(name);
      continue;
    }

    if (strings.has(name)) {
      if (inline !== undefined) {
        values.set(name, inline);
        continue;
      }
      const next = argv[index + 1];
      // A following flag is a missing value, not the value. `--limit --apply`
      // used to set limit to the string "--apply".
      if (next === undefined || next.startsWith('-')) {
        throw new UsageError(`${name} requires a value`);
      }
      values.set(name, next);
      index += 1;
      continue;
    }

    throw new UsageError(`unknown option: ${name}`);
  }

  return { flags, values, positional };
}

export function integer(
  values: Map<string, string>,
  name: string,
  fallback: number,
  { min = 0, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {},
): number {
  const raw = values.get(name);
  if (raw === undefined) return fallback;

  if (!/^\d+$/.test(raw)) {
    throw new UsageError(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }

  const parsed = Number(raw);
  if (parsed < min || parsed > max) {
    throw new UsageError(`${name} must be between ${min} and ${max}, got ${parsed}`);
  }

  return parsed;
}

/** Split `a,b , c` into `['a','b','c']`, dropping empties. */
export function csv(values: Map<string, string>, name: string): string[] {
  const raw = values.get(name);
  if (!raw) return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
