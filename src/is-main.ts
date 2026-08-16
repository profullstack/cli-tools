import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Was this module executed, or merely imported?
 *
 * Every entry point under `bin/` guards its side effects with this. Without it
 * an `import` of the module *runs the tool*, which is not a hypothetical: a
 * test that imported `bin/gh-prs-fix-all.ts` to reach one pure function swept
 * live pull requests with `--fix` implied and took the suite from 60ms to 93
 * seconds.
 *
 * The realpath matters. These commands are installed as symlinks in
 * `~/.local/bin`, so `process.argv[1]` is the link while `import.meta.url` is
 * the file it points at, and comparing them raw says "imported" for every
 * installed command — disabling all of them at once.
 */
export function isMain(moduleUrl: string, argv: readonly string[] = process.argv): boolean {
  const entry = argv[1];
  if (!entry) return false;

  try {
    return pathToFileURL(realpathSync(entry)).href === moduleUrl;
  } catch {
    return pathToFileURL(entry).href === moduleUrl;
  }
}
