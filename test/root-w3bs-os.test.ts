import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Tests for root-w3bs-os.sh, the W3BS OS (Alpine) counterpart of
 * root-ubuntu.sh. Same two kinds of check as test/root-ubuntu.test.ts:
 *
 * behavioural ones, where the pure helpers are cut out of the script with sed
 * and run in a real bash -- anything that needs apk, OpenRC or a network is
 * left to a real box (the PR carries a two-run transcript from an OpenRC
 * container) -- and the invariants that make it safe to publish at all.
 *
 * These run on whatever box runs the suite, which is not Alpine. That is the
 * point of the parse and dry-run checks: --help, the unprivileged subcommands
 * and `mount --dry-run` must work anywhere, and the full run must refuse to
 * start on a box it was not written for.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(here, '..', 'root-w3bs-os.sh');
const SOURCE = readFileSync(SCRIPT, 'utf8');

/** Run some of the script's functions without running the script. */
function shell(fns: string[], snippet: string, env: NodeJS.ProcessEnv = process.env): string {
  const extract = fns.map((fn) => `sed -n '/^${fn}()/,/^}/p' "$S"`).join('; ');
  const script = `set -uo pipefail\nS=${JSON.stringify(SCRIPT)}\neval "$(${extract})"\n${snippet}`;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8', env }).trim();
}

/**
 * Same, for functions whose bodies are heredocs full of lines that start with
 * "}" (a Caddyfile, a generated sh script with functions of its own): each is
 * cut from its definition up to the definition of the function that follows
 * it in the file, named explicitly.
 */
function shellWhole(fns: [string, string][], snippet: string): string {
  const extract = fns
    .map(
      ([fn, next]) =>
        // a one-line definition ends on its own line
        `awk -v f='${fn}' -v n='${next}' 'index($0, f"() {") == 1 {on=1; if ($0 ~ /}$/) {print; exit}} index($0, n"() {") == 1 {exit} on' "$S"`,
    )
    .join('; ');
  const script = `set -uo pipefail\nS=${JSON.stringify(SCRIPT)}\neval "$(${extract})"\n${snippet}`;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
}

function status(fns: string[], snippet: string): number {
  try {
    shell(fns, snippet);
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? 1;
  }
}

/** The script's own helpers that everything else leans on, as quiet stubs. */
const STUBS = `info() { :; }; warn() { printf 'warn: %s\\n' "$*" >&2; }; note() { printf 'note: %s\\n' "$*"; }`;

const isRoot = process.getuid?.() === 0;
const has = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;

describe('the script itself', () => {
  it('is valid bash', () => {
    expect(() => execFileSync('bash', ['-n', SCRIPT])).not.toThrow();
  });

  it('is executable, since the documented use is ./root-w3bs-os.sh', () => {
    execFileSync('test', ['-x', SCRIPT]);
  });

  it('prints usage without being root, so --help is never a privileged act', () => {
    const out = execFileSync('bash', [SCRIPT, '--help'], { encoding: 'utf8' });
    expect(out).toContain('root-w3bs-os.sh');
    expect(out).toContain('--refresh');
    expect(out).toContain('--with-sh1pt');
    expect(out).toContain('--without-moshcode');
  });

  it.skipIf(!has('dash'))('re-runs itself under bash when started from a file with sh', () => {
    // /bin/sh on W3BS OS is busybox ash. Started as `sh root-w3bs-os.sh`, the
    // guard finds bash (installing it with apk as root) and execs into it.
    const out = execFileSync('dash', [SCRIPT, '--help'], { encoding: 'utf8' });
    expect(out).toContain('root-w3bs-os.sh -- bootstrap AND maintain');
  });

  it.skipIf(!has('dash'))('says so in one sentence when piped into sh, where it cannot re-run itself', () => {
    const r = spawnSync('dash', ['-s', '--', '--refresh'], { input: SOURCE, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('running it under sh');
    expect(r.stderr).toContain('bash -s --');
  });

  it('documents the pipe with bash, never sh', () => {
    expect(SOURCE).toContain('root-w3bs-os.sh | bash -s -- --refresh');
    expect(SOURCE).not.toMatch(/root-w3bs-os\.sh \| sh /);
  });

  it.skipIf(isRoot)('refuses to do anything as a normal user', () => {
    const r = spawnSync('bash', [SCRIPT, '--refresh'], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('must run as root');
  });

  it.skipIf(!has('shellcheck'))('passes shellcheck at warning level', () => {
    // SC2088 is the one deliberate case: a literal "~/" in a case pattern
    // (_expand_remote matches what the user typed, not $HOME).
    const r = spawnSync('shellcheck', ['-S', 'warning', '-e', 'SC2088', SCRIPT], { encoding: 'utf8' });
    expect(r.stdout + r.stderr).toBe('');
    expect(r.status).toBe(0);
  }, 60_000);
});

describe('what may not be in a public file', () => {
  it('carries no personal identifiers', () => {
    const names = /\b(anthony|preshy|phuc|ralyodio|chovy|h4kr|bonita)\b/i;
    expect(SOURCE).not.toMatch(names);
  });

  it('has no contact address baked into the ACME config', () => {
    expect(SOURCE).toMatch(/ACME_EMAIL="\$\{ACME_EMAIL:-\}"/);
  });

  it('holds no key material or credentials', () => {
    expect(SOURCE).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    expect(SOURCE).not.toMatch(/\b(gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|sk-ant-)/);
    expect(SOURCE).not.toMatch(/\b(pk1|sk1)_[A-Za-z0-9]{12,}/);
    expect(SOURCE).not.toMatch(/tskey-auth-[A-Za-z0-9]{12,}/);
  });

  it('reads every credential from the environment or the config file', () => {
    for (const key of ['PORKBUN_API_KEY', 'PORKBUN_SECRET_API_KEY', 'TS_AUTHKEY']) {
      expect(SOURCE).toContain(`${key}="\${${key}:-}"`);
    }
  });

  it('never turns on the sponsor ad, which is not ported', () => {
    // root-ubuntu.sh's ad is nginx SSI; a slot configured in server.conf must
    // not bill anybody through this script.
    expect(SOURCE).toMatch(/SPONSOR_AD_SLOT="\$\{SPONSOR_AD_SLOT:-\}"/);
    expect(SOURCE).not.toMatch(/crawlproof\.com\/api\/ads/);
  });
});

describe('read_server_config', () => {
  const conf = (body: string) =>
    `f=$(mktemp); cat >"$f" <<'CONF'\n${body}\nCONF\nread_server_config "$f"`;

  it('reads KEY=value, the same file root-ubuntu.sh reads', () => {
    expect(SOURCE).toContain('SERVER_CONFIG="${SERVER_CONFIG:-/etc/cli-tools/server.conf}"');
    expect(shell(['read_server_config'], `${conf('WEB_TLS=internal')}; echo "$WEB_TLS"`)).toBe('internal');
  });

  it('lets the environment win over the file', () => {
    expect(shell(['read_server_config'], `D=from-env; ${conf('D=from-file')}; echo "$D"`)).toBe('from-env');
  });

  it('executes nothing in the file', () => {
    const out = shell(['read_server_config'], `${conf('E=$(id)')}; echo "$E"`);
    expect(out).toBe('$(id)');
  });
});

describe('every documented setting is actually overridable', () => {
  // The same sweep as root-ubuntu.sh's, over the keys server.conf.example
  // promises, plus the ones only this script has.
  const documented = [
    ...readFileSync(resolve(here, '..', 'server.conf.example'), 'utf8').matchAll(/^#([A-Z][A-Z0-9_]*)=/gm),
  ].map((m) => m[1]);
  const ours = ['WEB_TLS', 'CADDY_ADMIN', 'WITH_MOSHCODE', 'WITH_SH1PT', 'W3BS_INSTALL', 'AUTO_UPGRADE', 'CONFINE_CGROUP', 'ZRAM_SIZE_MB'];

  it.each([...documented, ...ours])('%s survives its own declaration', (key) => {
    const decl = new RegExp(`^${key}=(.*)$`, 'm').exec(SOURCE);
    if (decl === null) return;
    expect(decl[1]).toContain(`\${${key}:-`);
  });

  it('lands new accounts in users on a confined box, and wheel (not sudo) on an open one', () => {
    const lines = /^DEFAULT_GROUPS_EXPLICIT=.*\nDEFAULT_GROUPS=.*$/m.exec(SOURCE)?.[0] ?? '';
    const confine = /^if \[\[ "\$CONFINE" == 1 && -z "\$DEFAULT_GROUPS_EXPLICIT" \]\]; then\n\tDEFAULT_GROUPS="users"\nfi$/m.exec(SOURCE)?.[0] ?? '';
    expect(confine).not.toBe('');
    expect(shell([], `unset DEFAULT_GROUPS; CONFINE=1; ${lines}\n${confine}\necho "$DEFAULT_GROUPS"`)).toBe('users');
    expect(shell([], `unset DEFAULT_GROUPS; CONFINE=0; ${lines}\n${confine}\necho "$DEFAULT_GROUPS"`)).toBe('wheel');
    expect(shell([], `DEFAULT_GROUPS=docker; CONFINE=1; ${lines}\n${confine}\necho "$DEFAULT_GROUPS"`)).toBe('docker');
  });

  it('counts wheel as an admin, which is what doas and the ISO use', () => {
    expect(SOURCE).toContain('CONFINE_EXEMPT_GROUPS="${CONFINE_EXEMPT_GROUPS:-wheel,sudo,admin}"');
  });
});

describe('read_w3bs_os_release', () => {
  it('reads ID and EDITION, quoted or not', () => {
    const out = shell(
      ['read_w3bs_os_release'],
      `f=$(mktemp); printf 'ID=w3bs-os\\nEDITION="docker-server"\\nVERSION_ID=1\\n' >"$f"; W3BS_OS_ID=; W3BS_OS_EDITION=; read_w3bs_os_release "$f"; echo "$W3BS_OS_ID|$W3BS_OS_EDITION"`,
    );
    expect(out).toBe('w3bs-os|docker-server');
  });

  it('is quiet on plain Alpine, where there is no such file', () => {
    expect(status(['read_w3bs_os_release'], 'read_w3bs_os_release /nope/not/here')).toBe(0);
  });
});

describe('check_os', () => {
  it('refuses Ubuntu and Debian by name and points at root-ubuntu.sh', () => {
    expect(SOURCE).toContain('use root-ubuntu.sh on Ubuntu/Debian (or --force to insist)');
  });

  it('accepts Alpine and anything like it (postmarketOS)', () => {
    expect(SOURCE).toMatch(/case " \$id \$like " in\n\t\t\*" alpine "\*\) ;;/);
  });

  it.skipIf(!isRoot || has('apk'))('a real run on a non-Alpine box stops at the OS check', () => {
    const r = spawnSync('bash', [SCRIPT, '--refresh'], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/is not W3BS OS/);
  });
});

describe('ensure_apk_repos', () => {
  const run = (body: string) =>
    shell(
      ['ensure_apk_repos'],
      `${STUBS}; apk() { :; }; f=$(mktemp); printf '${body}' >"$f"; ensure_apk_repos "$f" >/dev/null; cat "$f"`,
    );

  it('adds community for the same branch as main', () => {
    expect(run('https://dl-cdn.alpinelinux.org/alpine/v3.24/main\\n')).toBe(
      'https://dl-cdn.alpinelinux.org/alpine/v3.24/main\nhttps://dl-cdn.alpinelinux.org/alpine/v3.24/community',
    );
  });

  it('uncomments a commented community line rather than adding a second', () => {
    expect(
      run('https://dl-cdn.alpinelinux.org/alpine/v3.24/main\\n#https://dl-cdn.alpinelinux.org/alpine/v3.24/community\\n'),
    ).toBe('https://dl-cdn.alpinelinux.org/alpine/v3.24/main\nhttps://dl-cdn.alpinelinux.org/alpine/v3.24/community');
  });

  it('leaves a file that already has community alone, and never reaches for edge', () => {
    const both = 'https://x/alpine/v3.24/main\\nhttps://x/alpine/v3.24/community\\n';
    expect(run(both)).toBe('https://x/alpine/v3.24/main\nhttps://x/alpine/v3.24/community');
    expect(run('https://x/alpine/v3.24/main\\n')).not.toContain('edge');
  });
});

describe('the w3bs CLI is the front door for catalog tools', () => {
  const tool = (fakeW3bs: string, extra = '') => {
    const dir = mkdtempSync(join(tmpdir(), 'w3bs-'));
    const bin = join(dir, 'w3bs');
    writeFileSync(bin, `#!/bin/sh\necho "w3bs $*" >>${dir}/calls\n${fakeW3bs}\n`);
    chmodSync(bin, 0o755);
    const out = shell(
      ['w3bs_bin', 'w3bs_catalog_has', 'w3bs_tool'],
      `${STUBS}; as_user() { shift; bash -c "$*"; }; w3bs_repo_ensure() { :; }
W3BS_INSTALL=1; W3BS_BIN=${bin}; W3BS_CATALOG_FETCHED=1
W3BS_CATALOG=$'moshcode.sh/moshcode\\nsh1pt.com/sh1pt'
${extra}
w3bs_tool alice moshcode.sh/moshcode 'echo FALLBACK'; echo "rc=$?"; cat ${dir}/calls 2>/dev/null || true`,
    );
    return out;
  };

  it('installs through w3bs when the tool is in the catalog and not installed yet', () => {
    const out = tool('case "$1" in list) echo "No packages installed." ;; install) echo "moshcode.sh/moshcode  -  0.1.0  installed" ;; esac');
    expect(out).toContain('w3bs install moshcode.sh/moshcode --yes --non-interactive');
    expect(out).not.toContain('FALLBACK');
    expect(out).toContain('rc=0');
  });

  it('updates instead of reinstalling what w3bs already manages, which is the idempotent path', () => {
    const out = tool('case "$1" in list) echo "moshcode.sh/moshcode 0.1.0" ;; update) echo "moshcode.sh/moshcode  0.1.0  0.1.0  current" ;; esac');
    expect(out).toContain('w3bs update moshcode.sh/moshcode --yes --non-interactive');
    expect(out).not.toContain('w3bs install');
  });

  it('reads the result row, since w3bs exits 0 even when one package failed', () => {
    const out = tool('case "$1" in list) : ;; install) echo "moshcode.sh/moshcode  -  -  failed: installer exited 1" ;; esac');
    expect(out).toContain('rc=1');
  });

  it('treats a w3bs error with no result row as a failure, not a silent success', () => {
    // What a fresh account with no repository gets: exit 2 and one error line.
    const out = tool('echo "error: no repositories are configured (NO_REPOSITORIES)"; exit 2');
    expect(out).toContain('rc=1');
  });

  it('finds the repository fingerprint without it ever being typed into this file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-'));
    const inst = join(dir, 'install.sh');
    writeFileSync(inst, "w3bs_main() {\n  REPO_FINGERPRINT='sha256:0123abcd'\n}\n");
    const out = shell(
      ['_w3bs_fingerprint'],
      `W3BS_REPO_FINGERPRINT=; W3BS_INSTALLER_URL=file://${inst}; _w3bs_fingerprint`,
    );
    // the OS image's own copy wins where there is one
    if (!has('test -s /usr/share/w3bs-os/FINGERPRINT')) expect(out).toBe('sha256:0123abcd');
    expect(SOURCE).not.toMatch(/sha256:[0-9a-f]{64}/);
  });

  it('falls back to the publisher installer when w3bs is off, missing, or the id is not in the catalog', () => {
    expect(tool('exit 0', 'W3BS_INSTALL=0')).toContain('FALLBACK');
    expect(tool('exit 0', 'W3BS_BIN=/nonexistent; w3bs_bin() { return 1; }')).toContain('FALLBACK');
    expect(tool('exit 0', "W3BS_CATALOG='sh1pt.com/sh1pt'")).toContain('FALLBACK');
  });

  it('uses the catalog ids w3bs.org lists', () => {
    for (const id of ['moshcode.sh/moshcode', 'threatcrush.com/threatcrush', 'hqterm.sh/hqterm', 'sh1pt.com/sh1pt']) {
      expect(SOURCE).toContain(id);
    }
  });

  it('upgrades the system through w3bs, with the plain apk path only as the fallback', () => {
    const fn = /^system_upgrade\(\) \{[\s\S]*?^\}/m.exec(SOURCE)?.[0] ?? '';
    expect(fn).toContain('os update --yes');
    expect(fn).toContain('dist-upgrade --yes');
    expect(fn.indexOf('dist-upgrade')).toBeLessThan(fn.indexOf('apk upgrade'));
  });
});

describe('accounts on a sshd without PAM', () => {
  it('makes key-only accounts with a "*" password, never the "!" that locks them out', () => {
    // Alpine's sshd is built without PAM, and then a '!' password field is a
    // locked account: even a valid key is refused.
    expect(SOURCE).toContain("_key_only() { usermod -p '*' \"$1\" >/dev/null 2>&1; }");
    const create = /^create_user\(\) \{[\s\S]*?^\}/m.exec(SOURCE)?.[0] ?? '';
    expect(create).toContain('_key_only "$login"');
    // only a tenant (nologin, no host shell at all) is still locked with -l
    expect(create.match(/passwd -l/g)?.length).toBe(1);
  });

  it('converts busybox ash (Alpine\'s default shell) to zsh like bash and sh', () => {
    expect(SOURCE).toMatch(/\*\/bash\|\*\/sh\|\*\/ash\|""\) ;;/);
  });
});

describe('Caddy', () => {
  const caddyfile = (env: string) =>
    shellWhole(
      [
        ['_caddy_scheme', '_caddy_badbot_regex'],
        ['_caddy_badbot_regex', 'write_caddyfile'],
        ['write_caddyfile', 'write_devapps_generator'],
      ],
      `${STUBS}; AI_CRAWLER_AGENTS=(GPTBot "Kangaroo Bot"); BLOCK_AI_BOTS=1; WEB_DOMAIN=dev.example.test
CADDY_ADMIN=localhost:2019; CADDY_LOG_DIR=/var/log/caddy; CADDY_USERS_DIR=/etc/caddy/users; CADDY_CONF_DIR=/etc/caddy/conf.d
ACME_EMAIL=; MOSHPIT_PARKING_URL=https://pit.example/n; IANA_TLDS="com net"; ${env}
write_caddyfile`,
    );

  it('keeps the admin API on loopback and imports one file per account', () => {
    const out = caddyfile('WEB_TLS=auto');
    expect(out).toMatch(/^\tadmin localhost:2019$/m);
    expect(out).toContain('import /etc/caddy/users/*.caddy');
    expect(out).toContain('import /etc/caddy/conf.d/*.caddy');
  });

  it('serves the landing page and /~user from the base domain', () => {
    const out = caddyfile('WEB_TLS=auto');
    expect(out).toMatch(/^dev\.example\.test \{$/m);
    expect(out).toContain('root * /home/{re.tilde.1}/public_html');
  });

  it('turns each TLS mode into the matching global option', () => {
    expect(caddyfile('WEB_TLS=auto')).not.toMatch(/local_certs|auto_https off/);
    expect(caddyfile('WEB_TLS=internal')).toMatch(/^\tlocal_certs$/m);
    expect(caddyfile('WEB_TLS=internal')).toMatch(/^\tskip_install_trust$/m);
    const off = caddyfile('WEB_TLS=off');
    expect(off).toMatch(/^\tauto_https off$/m);
    expect(off).toMatch(/^http:\/\/dev\.example\.test \{$/m);
    // no https to upgrade to, so the catch-all does not pretend there is
    expect(off).not.toContain('redir https://{host}{uri} 301');
  });

  it('parks unpointed Moshpit names and upgrades clearnet ones', () => {
    const out = caddyfile('WEB_TLS=auto');
    expect(out).toMatch(/^\t\tcom 0$/m);
    expect(out).toContain('redir @parked https://pit.example/n/{host} 302');
    expect(out).toContain('redir https://{host}{uri} 301');
  });

  it('refuses AI crawlers case-insensitively, spaces and all', () => {
    expect(shell(['_caddy_badbot_regex'], 'AI_CRAWLER_AGENTS=(GPTBot "Kangaroo Bot"); _caddy_badbot_regex')).toBe(
      '(?i)(GPTBot|Kangaroo\\sBot)',
    );
  });

  it.skipIf(!has('caddy'))('writes a Caddyfile that caddy itself accepts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'caddy-'));
    const file = join(dir, 'Caddyfile');
    writeFileSync(file, caddyfile('WEB_TLS=internal') + '\n');
    const r = spawnSync('caddy', ['adapt', '--config', file, '--adapter', 'caddyfile'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
  });

  it('renders a devapps generator that is valid POSIX sh and keeps the tenant port bands', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devapps-'));
    const gen = join(dir, 'gen.sh');
    shellWhole(
      [
        ['_caddy_scheme', '_caddy_badbot_regex'],
        ['write_devapps_generator', '_caddy_apply'],
      ],
      `${STUBS}; write_if_changed() { cat >${JSON.stringify(gen)}; return 0; }; detect_init() { echo openrc; }
_crontab_ensure() { :; }; svc_enable() { :; }; svc_start() { :; }
WEB_DOMAIN=dev.example.test; WEB_TLS=auto; DEV_APPS=1; CADDY_USERS_DIR=/etc/caddy/users; CADDYFILE=/etc/caddy/Caddyfile
CADDY_ADMIN=localhost:2019; SANDBOX_TENANTS=/nope; SANDBOX_PORT_BASE=21000; SANDBOX_PORT_SPAN=100
write_devapps_generator`,
    );
    const body = readFileSync(gen, 'utf8');
    expect(() => execFileSync('sh', ['-n', gen])).not.toThrow();
    expect(body).toContain("domain='dev.example.test'");
    expect(body).toContain('port_allowed');
    expect(body).toContain('reverse_proxy 127.0.0.1:');
    // a config Caddy would refuse is rolled back, never left for the next start
    expect(body).toContain('rolled back');
  });
});

describe('things that must not flip-flop between runs', () => {
  it('keeps a sysctl floor its own file put there, instead of deleting the file on run two', () => {
    const run = (have: string, file: string) =>
      shell(
        ['_confine_sysctl_floor'],
        `sysctl() { echo ${have}; }; CONFINE_SYSCTL_CONF=$(mktemp); printf '${file}' >"$CONFINE_SYSCTL_CONF"
_confine_sysctl_floor kernel.kptr_restrict 2 || echo none`,
      );
    expect(run('1', '')).toBe('kernel.kptr_restrict = 2');
    // at the floor because of us: stays
    expect(run('2', 'kernel.kptr_restrict = 2\\n')).toBe('kernel.kptr_restrict = 2');
    // at the floor on its own: nothing to write
    expect(run('2', '')).toBe('none');
    // stricter than the floor: never written back down
    expect(run('3', 'kernel.kptr_restrict = 2\\n')).toBe('none');
  });

  it('does not mistake root\'s home for a dotfiles checkout', () => {
    // Run from /root, which has a .zshrc after the first run, the second run
    // used to copy root's shell config into every account.
    const dir = mkdtempSync(join(tmpdir(), 'home-'));
    writeFileSync(join(dir, '.zshrc'), '# not a team repo\n');
    const out = shell(
      ['looks_like_dotfiles', 'resolve_dotfiles'],
      `${STUBS}; SKIP_DOTFILES=0; DOTFILES_DIR=; DOTFILES_REPO=; SCRIPT_DIR=${dir}; resolve_dotfiles; echo "[$DOTFILES_DIR]"`,
    );
    expect(out).toBe('[]');
  });

  it('never touches the host kernel from inside a container', () => {
    for (const fn of ['configure_swap', 'configure_confine_sysctl', 'configure_zram', 'configure_earlyoom']) {
      const body = new RegExp(`^${fn}\\(\\) \\{[\\s\\S]*?^\\}`, 'm').exec(SOURCE)?.[0] ?? '';
      expect(body, fn).toContain('_in_container');
    }
  });
});

describe('platform helpers', () => {
  it('_mem_value turns a share of RAM into bytes and passes absolute values through', () => {
    const bytes = Number(shell(['_mem_value'], '_mem_value 50%'));
    expect(bytes).toBeGreaterThan(0);
    expect(shell(['_mem_value'], '_mem_value 4G')).toBe('4G');
    expect(shell(['_mem_value'], '_mem_value max')).toBe('max');
  });

  it('_zram_size_mb is half of RAM, capped at 8 GiB, unless told otherwise', () => {
    const mb = Number(shell(['_zram_size_mb'], 'ZRAM_SIZE_MB=; _zram_size_mb'));
    expect(mb).toBeGreaterThan(0);
    expect(mb).toBeLessThanOrEqual(8192);
    expect(shell(['_zram_size_mb'], 'ZRAM_SIZE_MB=777; _zram_size_mb')).toBe('777');
  });

  it('maps service names that differ between OpenRC and systemd', () => {
    expect(shell(['_svc_name'], 'detect_init() { echo openrc; }; _svc_name incus')).toBe('incusd');
    expect(shell(['_svc_name'], 'detect_init() { echo systemd; }; _svc_name incus')).toBe('incus');
    expect(shell(['_svc_name'], 'detect_init() { echo openrc; }; _svc_name caddy')).toBe('caddy');
  });

  it('owns one crontab line per tag, so a re-run replaces it rather than stacking', () => {
    const out = shell(
      ['_crontab_file', '_crontab_ensure'],
      `${STUBS}; d=$(mktemp -d); _crontab_file() { echo "$d/root"; }
_crontab_ensure t '* * * * * a' >/dev/null; _crontab_ensure t '* * * * * b' >/dev/null
_crontab_ensure t '* * * * * b' >/dev/null || echo unchanged; cat "$d/root"`,
    );
    expect(out).toBe('unchanged\n* * * * * b # root-w3bs-os:t');
  });

  it('leaves two owned crontab lines in place on a re-run, rather than swapping them', () => {
    // measured: re-appending moved each to the end, a "change" every run
    const out = shell(
      ['_crontab_file', '_crontab_ensure'],
      `${STUBS}; d=$(mktemp -d); _crontab_file() { echo "$d/root"; }
_crontab_ensure a '* * * * * a' >/dev/null; _crontab_ensure b '* * * * * b' >/dev/null
_crontab_ensure a '* * * * * a' >/dev/null || echo same-a; _crontab_ensure b '* * * * * b' >/dev/null || echo same-b`,
    );
    expect(out).toBe('same-a\nsame-b');
  });
});

describe('the unprivileged subcommands', () => {
  it('lists accounts and groups without root', () => {
    const out = execFileSync('bash', [SCRIPT, 'groups'], { encoding: 'utf8' });
    expect(out).toContain('LOGIN');
  });

  it('reports confinement without root, and names wheel as the way out', () => {
    const out = execFileSync('bash', [SCRIPT, 'confine', '--help'], { encoding: 'utf8' });
    expect(out).toContain('groups add <user> wheel');
  });

  it('plans a mount with --dry-run, changing nothing', () => {
    const out = execFileSync('bash', [SCRIPT, 'mount', 'ubuntu@files.example.com:~/data', '--sshfs', '--dry-run'], {
      encoding: 'utf8',
    });
    expect(out).toContain('dry run -- nothing was changed');
    expect(out).toContain('/mnt/sshfs.files.example.com/data');
  });
});

describe('the w3bs package (profullstack.com/root-w3bs-os)', () => {
  it('pins the script it installs: same version, same sha256', () => {
    const installer = readFileSync(join(dirname(SCRIPT), 'install-root-w3bs-os.sh'), 'utf8');
    const version = /^ROOT_W3BS_OS_VERSION=(\S+)$/m.exec(SOURCE)?.[1];
    expect(version).toBeTruthy();
    expect(installer).toContain(`VERSION=${version}\n`);
    const sha = createHash('sha256').update(readFileSync(SCRIPT)).digest('hex');
    // Edit root-w3bs-os.sh => bump ROOT_W3BS_OS_VERSION, update the installer's
    // VERSION and SHA256, tag root-w3bs-os-v<version>, publish the release.
    expect(installer).toContain(`SHA256=${sha}\n`);
  });

  it('answers --version without root', () => {
    expect(execFileSync('bash', [SCRIPT, '--version'], { encoding: 'utf8' }).trim()).toMatch(
      /^root-w3bs-os \d+\.\d+\.\d+$/,
    );
  });
});
