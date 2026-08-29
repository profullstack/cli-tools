import { describe, expect, it } from 'vitest';

import { KNOWN_VERBS, USAGE } from '../bin/cli-tools.ts';
import { COMPANIONS } from '../src/companions.ts';
import { commands } from '../src/registry.ts';

/**
 * The verbs the usage text claims exist.
 *
 * Both halves count. The synopsis carries the invocation, the `Commands:` block
 * carries the explanation, and a verb documented in either is one somebody can
 * find — `help` and `where` are only in the second, which is fine.
 */
function documentedVerbs(): string[] {
  const found = new Set<string>();
  let inCommands = false;
  for (const line of USAGE.split('\n')) {
    const synopsis = /^\s{2}cli-tools ([a-z-]+)/.exec(line);
    if (synopsis?.[1] && synopsis[1] !== '<command>') found.add(synopsis[1]);

    if (/^Commands:/.test(line)) { inCommands = true; continue; }
    // The block ends at the next unindented heading (`Keys (config set …)`).
    if (inCommands && line.trim() && !/^\s/.test(line)) inCommands = false;
    if (!inCommands) continue;
    // A verb line is `  name  description`; a continuation line is indented
    // further and has no name of its own.
    const entry = /^\s{2}([a-z-]+)\s{2,}\S/.exec(line);
    if (entry?.[1]) found.add(entry[1]);
  }
  return [...found];
}

describe('the dispatcher verb list', () => {
  it('knows every verb the usage text documents', () => {
    // The quiet failure this catches: a verb documented in USAGE but missing
    // from KNOWN_VERBS falls through to the command passthrough and answers
    // "unknown command" while the help insists it exists. It happened to
    // `help`, and then again to `companions`.
    for (const verb of documentedVerbs()) {
      expect(KNOWN_VERBS.has(verb), `${verb} is documented but not dispatched`).toBe(true);
    }
  });

  it('documents every verb it dispatches', () => {
    // The other direction: an undocumented verb is one nobody can find.
    const documented = new Set(documentedVerbs());
    for (const verb of KNOWN_VERBS) {
      expect(documented.has(verb), `${verb} is dispatched but not in the usage text`).toBe(true);
    }
  });

  it('never shadows one of the commands with a verb', () => {
    // A verb wins over the passthrough, so a name in both lists makes the
    // command unreachable through the dispatcher.
    const names = new Set(commands().map((entry) => entry.name));
    for (const verb of KNOWN_VERBS) {
      if (verb === 'cli-tools') continue;
      expect(names.has(verb), `${verb} is both a verb and a command`).toBe(false);
    }
  });

  it('never shadows a companion either', () => {
    // `cli-tools timer …` has to reach the timer, not a dispatcher verb.
    for (const companion of COMPANIONS) {
      expect(KNOWN_VERBS.has(companion.name), `${companion.name} is shadowed by a verb`).toBe(false);
    }
  });
});
