import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * dev2/templates/deploy-app.sh against a fake docker. The fake keeps two facts:
 * which image the running app container came from (`running`, empty = no
 * container) and what site-app:latest points at (`latest`). The old stack runs
 * img-old; a successful build moves :latest to img-new.
 */
const SCRIPT = resolve(__dirname, '../dev2/templates/deploy-app.sh');

const FAKE_DOCKER = `#!/usr/bin/env bash
F=$FAKE; echo "$*" >> "$F/log"
if [ "$1" = compose ]; then
  shift
  while [ $# -gt 0 ]; do case $1 in -f|--env-file) shift 2 ;; *) break ;; esac; done
  cmd=$1; shift
  case $cmd in
    build) [ "\${FAIL_BUILD:-0}" = 1 ] && exit 1; echo img-new > "$F/latest" ;;
    ps) if [ "\${1:-}" = -q ] && [ -s "$F/running" ]; then echo "cid-\${2:-app}"; fi ;;
    up)
      n=$(cat "$F/ups" 2>/dev/null || echo 0); echo $((n + 1)) > "$F/ups"
      # Compose removed the old container, then failed to start the new one.
      if [ "\${FAIL_UP:-0}" = 1 ] && [ "$n" = 0 ]; then : > "$F/running"; exit 1; fi
      cat "$F/latest" > "$F/running" ;;
    down) : > "$F/running" ;;
  esac
  exit 0
fi
case $1 in
  inspect) case $3 in '{{.Image}}') cat "$F/running" ;; '{{.Config.Image}}') echo site-app:latest ;; *) echo net ;; esac ;;
  tag) [ "$3" = site-app:latest ] && echo "$2" > "$F/latest"; exit 0 ;;
  exec) exit 1 ;;
esac
exit 0
`;

const FAKE_CURL = `#!/usr/bin/env bash
r=$(cat "$FAKE/running")
if [ -n "$r" ] && ! { [ "\${UNHEALTHY_NEW:-0}" = 1 ] && [ "$r" = img-new ]; }; then printf 200; else printf 000; fi
`;

let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

function setup() {
  dir = mkdtempSync(join(tmpdir(), 'deploy-app-'));
  const bin = join(dir, 'bin'), fake = join(dir, 'fake'), root = join(dir, 'www'), origin = join(dir, 'origin');
  for (const d of [bin, fake, root, origin]) mkdirSync(d);
  for (const [n, body] of [['docker', FAKE_DOCKER], ['curl', FAKE_CURL], ['sleep', '#!/bin/sh\n']] as const) {
    writeFileSync(join(bin, n), body); chmodSync(join(bin, n), 0o755);
  }
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: origin, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(origin, 'f'), '1'); git('add', 'f'); git('commit', '-qm', 'one');
  const oldSha = git('rev-parse', 'HEAD');
  writeFileSync(join(origin, 'f'), '2'); git('commit', '-qam', 'two');
  const newSha = git('rev-parse', 'HEAD');
  execFileSync('git', ['clone', '-q', origin, join(root, 'app')]);
  execFileSync('git', ['-C', join(root, 'app'), 'checkout', '-q', '--detach', oldSha]);
  writeFileSync(join(root, 'deploy.env'), `REPO=${origin}\nAPP_PORT=3999\nBUILD_SERVICES=app\nHEALTH_PATH=/\nHEALTH_TIMEOUT=5\n`);
  writeFileSync(join(root, 'app.env'), 'NEXT_PUBLIC_X=1\n');
  writeFileSync(join(root, 'docker-compose.app.yml'), 'services:\n  app:\n    image: site-app:latest\n');
  writeFileSync(join(fake, 'running'), 'img-old\n');
  writeFileSync(join(fake, 'latest'), 'img-old\n');
  writeFileSync(join(fake, 'log'), '');
  return { bin, fake, root, oldSha, newSha };
}

function deploy(env: Record<string, string> = {}) {
  const t = setup();
  const r = spawnSync('bash', [SCRIPT, t.newSha], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${t.bin}:${process.env.PATH}`, ROOT: t.root, FAKE: t.fake, ...env },
  });
  const read = (f: string) => readFileSync(join(t.fake, f), 'utf8').trim();
  return { ...t, status: r.status, out: r.stdout + r.stderr, running: read('running'), latest: read('latest'), log: read('log'),
    state: existsSync(join(t.root, '.deploy-state')) ? readFileSync(join(t.root, '.deploy-state'), 'utf8') : '' };
}

describe('dev2 deploy-app.sh', () => {
  it('a failed build never touches the running stack', () => {
    const r = deploy({ FAIL_BUILD: '1' });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('the running stack was not touched');
    expect(r.running).toBe('img-old');
    expect(r.log).not.toMatch(/compose .*\b(up|down)\b/);
    expect(r.log).not.toMatch(/^tag /m);
    expect(r.state).toBe('');
  });

  it('a failed `compose up` after the old container is gone rolls back to the previous image', () => {
    const r = deploy({ FAIL_UP: '1' });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('Rolling back to the previous image');
    expect(r.out).toContain('Restored the previous deploy');
    expect(r.running).toBe('img-old');
    expect(r.latest).toBe('img-old');
    expect(r.log).toMatch(/compose .*up -d --no-build/);
    expect(r.out.match(/Rolling back/g)).toHaveLength(1);
    expect(r.state).toBe('');
  });

  it('an unhealthy new image rolls back to the previous image without rebuilding', () => {
    const r = deploy({ UNHEALTHY_NEW: '1' });
    expect(r.status).not.toBe(0);
    expect(r.running).toBe('img-old');
    expect(r.log.match(/compose .* build /g)).toHaveLength(1);
    expect(r.state).toBe('');
  });

  it('a healthy deploy switches to the new image and records it', () => {
    const r = deploy();
    expect(r.status, r.out).toBe(0);
    expect(r.running).toBe('img-new');
    expect(r.state).toContain(`DEPLOYED_SHA=${r.newSha}`);
    expect(r.state).toContain(`PREVIOUS_SHA=${r.oldSha}`);
  });
});
