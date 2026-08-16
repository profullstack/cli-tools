import { execFile } from 'node:child_process';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Milliseconds before the child is killed. Default 120_000. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/**
 * Run a command with an argv array and never a shell.
 *
 * The bash original interpolated PR URLs and branch names into command lines.
 * Nothing there was attacker-controlled in practice, but the shape is the one
 * that breaks on a branch called `feat/it's-fine` long before it breaks on
 * anything malicious — and it breaks silently, because the shell splits the
 * word and `gh` receives two arguments it does not recognise.
 *
 * A non-zero exit is a *result*, not an exception. `gh pr checks` exits 1 when
 * a check is pending while still printing perfectly good JSON, and `gh pr
 * update-branch` exits 1 on a conflict, which is a thing the caller wants to
 * read rather than a thing that should unwind the run.
 */
export function run(
  file: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const { timeoutMs = 120_000, env, cwd } = options;

  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        timeout: timeoutMs,
        // GitHub API responses are comfortably larger than the 1MB default,
        // and truncation would surface as a JSON parse error blamed on gh.
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
        ...(env ? { env } : {}),
        ...(cwd ? { cwd } : {}),
      },
      (error, stdout, stderr) => {
        let code = 0;

        if (error) {
          const withCode = error as NodeJS.ErrnoException & { code?: number | string };
          code = typeof withCode.code === 'number' ? withCode.code : 1;

          // ENOENT means the binary is missing, which is a setup problem and
          // not something a caller can interpret from an exit code.
          if (withCode.code === 'ENOENT') {
            resolve({
              code: 127,
              stdout: '',
              stderr: `command not found: ${file}`,
            });
            return;
          }
        }

        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
