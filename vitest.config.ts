import { defineConfig } from 'vitest/config';

/**
 * Keep the suite to this checkout's own tests.
 *
 * `EnterWorktree` and `git worktree add` both put working trees under
 * `.claude/worktrees/`, which is *inside* the repository — so vitest's default
 * glob walks into them and collects their `test/*.test.ts` as if they were
 * ours. With one worktree open here that turned a 14-file, 284-test run into 21
 * files and 427 tests, and the count is the harmless half: those files are
 * somebody's in-progress branch, so a run can fail on code that is not on this
 * branch at all, or pass because a half-finished test on another branch
 * happened to cover the thing you just broke.
 *
 * The default excludes are restated because setting `exclude` replaces them
 * rather than adding to them.
 */
export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/.claude/**',
    ],
  },
});
