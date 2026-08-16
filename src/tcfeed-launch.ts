import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

/**
 * Launch `tcfeed.ts`, which lives in the threatcrush checkout rather than here.
 *
 * It is not vendored because it is 94KB of scanner-adjacent code that changes
 * with the scanner, and a copy would drift the moment threatcrush shipped
 * anything. What lives here is only the part that has to be on PATH.
 *
 * Everything configurable is read from the environment by the script itself,
 * so TCFEED_MIN_GAP, TCFEED_MAX, TCFEED_PAUSE, TCFEED_SUB, TCFEED_CACHE, TC_BIN
 * and the rest keep working exactly as before.
 */

export const DEFAULT_REPO = join(homedir(), 'src', 'profullstack', 'threatcrush');

export function resolveScript(repo = process.env.TCFEED_REPO ?? DEFAULT_REPO): {
  repo: string;
  script: string;
  exists: boolean;
} {
  const script = join(repo, 'bin', 'tcfeed.ts');
  return { repo, script, exists: existsSync(script) };
}

export function missingScriptMessage(name: string, repo: string, script: string): string {
  return [
    `${name}: no script at ${script}`,
    `  git -C ${repo} pull           # it lives in the threatcrush repo`,
    '  TCFEED_REPO=/elsewhere   # if the checkout moved',
  ].join('\n');
}

export function launch(name: string, args: readonly string[]): Promise<number> {
  const { repo, script, exists } = resolveScript();

  if (!exists) {
    process.stderr.write(`${missingScriptMessage(name, repo, script)}\n`);
    return Promise.resolve(1);
  }

  // Run from the repo so npx resolves tsx against its node_modules before
  // reaching for the network. The script itself does not care where it is.
  return new Promise((resolve) => {
    const child = spawn('npx', ['--yes', 'tsx', 'bin/tcfeed.ts', ...args], {
      cwd: repo,
      stdio: 'inherit',
    });
    child.on('error', (error) => {
      process.stderr.write(`${name}: could not start tsx — ${error.message}\n`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}
