import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Tests for root-ubuntu.sh, which is a shell script and therefore cannot be
 * imported. Two kinds of check live here.
 *
 * The first kind is behavioural: the pure helpers are cut out of the script
 * with sed and run in a real bash, so what is asserted is what the file
 * actually does rather than what it appears to say. Only self-contained
 * functions can be treated this way — anything that reaches for apt, systemd
 * or the network is left to a real box.
 *
 * The second kind guards the invariants that make it safe to publish this
 * file at all. They read like paranoia until you remember where the script
 * came from: a private dotfiles repo, where an email address and an ad slot id
 * in the source cost nothing. In a public repository, curled onto other
 * people's machines, both are somebody else's problem to pay for.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(here, '..', 'root-ubuntu.sh');
const SOURCE = readFileSync(SCRIPT, 'utf8');

/**
 * Run one or more of the script's functions without running the script.
 *
 * The functions are extracted by name rather than the file being sourced,
 * because sourcing it would execute the whole provisioner — it is a linear
 * script, not a library, and there is no import-guard to stop at.
 */
function shell(fns: string[], snippet: string): string {
  const extract = fns.map((fn) => `sed -n '/^${fn}()/,/^}/p' "$S"`).join('; ');
  const script = `set -uo pipefail\nS=${JSON.stringify(SCRIPT)}\neval "$(${extract})"\n${snippet}`;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
}

/** Same, but for a snippet expected to fail; returns the exit status. */
function status(fns: string[], snippet: string): number {
  try {
    shell(fns, snippet);
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? 1;
  }
}

describe('the script itself', () => {
  it('is valid bash', () => {
    expect(() => execFileSync('bash', ['-n', SCRIPT])).not.toThrow();
  });

  it('is executable, since the documented use is ./root-ubuntu.sh', () => {
    execFileSync('test', ['-x', SCRIPT]);
  });

  it('prints usage without being root, so --help is never a privileged act', () => {
    const out = execFileSync('bash', [SCRIPT, '--help'], { encoding: 'utf8' });
    expect(out).toContain('root-ubuntu.sh');
    expect(out).toContain('--refresh');
  });

  it('says so in one sentence when run under sh instead of bash', () => {
    // /bin/sh on Ubuntu is dash. Without this guard, `curl … | sh` dies on the
    // first [[ with a syntax error naming a line the user never typed.
    let failed = false;
    try {
      execFileSync('dash', [SCRIPT, '--refresh'], { encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      failed = true;
      const err = error as { stderr?: Buffer; status?: number };
      expect(String(err.stderr)).toContain('running it under sh');
      expect(String(err.stderr)).toContain('bash -s --');
      expect(err.status).toBe(1);
    }
    expect(failed).toBe(true);
  });

  it('documents the pipe with bash, never sh', () => {
    expect(SOURCE).toContain('root-ubuntu.sh | bash -s -- --refresh');
    expect(SOURCE).not.toMatch(/root-ubuntu\.sh \| sh /);
  });

  it('refuses to do anything as a normal user', () => {
    let failed = false;
    try {
      execFileSync('bash', [SCRIPT, '--refresh'], { encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      failed = true;
      expect(String((error as { stderr?: Buffer }).stderr)).toContain('must run as root');
    }
    expect(failed).toBe(true);
  });
});

describe('what may not be in a public file', () => {
  // The script is served raw from GitHub and piped into root shells. Anything
  // in it that identifies a person identifies them to everyone who runs it.
  it('carries no personal identifiers', () => {
    const names = /\b(anthony|preshy|phuc|ralyodio|chovy|h4kr|bonita)\b/i;
    expect(SOURCE).not.toMatch(names);
  });

  it('has no default ad slot', () => {
    // A slot id is an account. Shipping one bills every box that ever runs
    // this script to whoever owns it, and inflates their impressions with
    // traffic they never had.
    expect(SOURCE).toMatch(/SPONSOR_AD_SLOT="\$\{SPONSOR_AD_SLOT:-\}"/);
    expect(SOURCE).not.toMatch(/SPONSOR_AD_SLOT="\$\{SPONSOR_AD_SLOT:-[0-9a-f]{8}-/);
  });

  it('has no contact address baked into the ACME config', () => {
    // A real address here would send a stranger's certificate expiry warnings
    // to a person who has never heard of their box.
    expect(SOURCE).toMatch(/ACME_EMAIL="\$\{ACME_EMAIL:-\}"/);
  });

  it('holds no key material or credentials', () => {
    expect(SOURCE).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    expect(SOURCE).not.toMatch(/\b(gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|sk-ant-)/);
    // The placeholders in the help text must stay placeholders: three trailing
    // dots, never a real prefix followed by an actual key.
    expect(SOURCE).not.toMatch(/\b(pk1|sk1)_[A-Za-z0-9]{12,}/);
    expect(SOURCE).not.toMatch(/tskey-auth-[A-Za-z0-9]{12,}/);
  });

  it('reads every credential from the environment or the config file', () => {
    for (const key of [
      'PORKBUN_API_KEY',
      'PORKBUN_SECRET_API_KEY',
      'CLOUDFLARE_API_TOKEN',
      'TS_AUTHKEY',
    ]) {
      expect(SOURCE).toContain(`${key}="\${${key}:-}"`);
    }
  });
});

describe('read_server_config', () => {
  const conf = (body: string) =>
    `f=$(mktemp); cat >"$f" <<'CONF'\n${body}\nCONF\nread_server_config "$f"`;

  it('reads KEY=value', () => {
    expect(shell(['read_server_config'], `${conf('WEB_DOMAIN=dev.example.com')}; echo "$WEB_DOMAIN"`)).toBe(
      'dev.example.com',
    );
  });

  it('strips one layer of quotes, single or double', () => {
    expect(shell(['read_server_config'], `${conf('A="one two"')}; echo "$A"`)).toBe('one two');
    expect(shell(['read_server_config'], `${conf("B='three'")}; echo "$B"`)).toBe('three');
  });

  it('ignores comments and blank lines', () => {
    expect(
      shell(['read_server_config'], `${conf('# a comment\n\n  # indented\nC=kept')}; echo "$C"`),
    ).toBe('kept');
  });

  it('lets the environment win over the file', () => {
    // The rule everywhere else in this repo, and the reason the file is read
    // rather than sourced: `.` would assign unconditionally and silently beat
    // the value someone just put on the command line.
    expect(
      shell(['read_server_config'], `D=from-env; ${conf('D=from-file')}; echo "$D"`),
    ).toBe('from-env');
  });

  it('executes nothing in the file', () => {
    // It is read as root. A config file only needs to carry values, so a line
    // that looks like a command must stay a string.
    const out = shell(
      ['read_server_config'],
      `${conf('E=$(touch /tmp/root-ubuntu-pwned)\nF=`id`')}; echo "$E|${'$'}{F}"`,
    );
    expect(out).toBe('$(touch /tmp/root-ubuntu-pwned)|`id`');
  });

  it('is quiet about a config file that is not there', () => {
    expect(status(['read_server_config'], 'read_server_config /nope/not/here')).toBe(0);
  });
});

describe('every documented setting is actually overridable', () => {
  /**
   * read_server_config runs near the top of the file, but the settings it
   * fills in are DECLARED further down. A declaration written as
   *
   *     KEY="a default"
   *
   * rather than
   *
   *     KEY="${KEY:-a default}"
   *
   * therefore silently throws away whatever the config file (or the
   * environment) just said, and does it long after the config was read, so
   * nothing about the run looks wrong. DEFAULT_GROUPS shipped that way: a box
   * that configured www-data,users,docker still put every new account in
   * sudo,admin, which is root-equivalent and the opposite of what was asked
   * for. These two tests cover the whole class rather than that one key.
   */

  /** Keys server.conf.example advertises, i.e. what we promise to honour. */
  const documented = [
    ...readFileSync(resolve(here, '..', 'server.conf.example'), 'utf8').matchAll(
      /^#([A-Z][A-Z0-9_]*)=/gm,
    ),
  ].map((m) => m[1]);

  it('advertises a useful number of keys, so the sweep below cannot pass vacuously', () => {
    expect(documented.length).toBeGreaterThan(10);
    expect(documented).toContain('DEFAULT_GROUPS');
  });

  it.each(documented)('%s survives its own declaration', (key) => {
    // Not assigned at the top level at all is fine -- it is then only ever
    // read, and the config value stands untouched.
    const decl = new RegExp(`^${key}=(.*)$`, 'm').exec(SOURCE);
    if (decl === null) return;
    expect(decl[1]).toContain(`\${${key}:-`);
  });

  it('keeps a configured DEFAULT_GROUPS instead of forcing sudo,admin', () => {
    // The regression itself, exercised rather than pattern-matched: read a
    // config file, then run the real declaration line out of the script.
    const decl = /^DEFAULT_GROUPS=.*$/m.exec(SOURCE)?.[0] ?? '';
    const out = shell(
      ['read_server_config'],
      `f=$(mktemp); printf 'DEFAULT_GROUPS=www-data,users,docker\\n' >"$f"; read_server_config "$f"; ${decl}; echo "$DEFAULT_GROUPS"`,
    );
    expect(out).toBe('www-data,users,docker');
  });

  it('still falls back to sudo,admin when nothing configures it', () => {
    const decl = /^DEFAULT_GROUPS=.*$/m.exec(SOURCE)?.[0] ?? '';
    expect(shell([], `unset DEFAULT_GROUPS; ${decl}; echo "$DEFAULT_GROUPS"`)).toBe('sudo,admin');
  });
});

describe('login handling', () => {
  it('takes the login from the part before the @', () => {
    expect(shell(['user_login'], 'user_login alice@example')).toBe('alice');
    expect(shell(['user_login'], 'user_login bob')).toBe('bob');
  });

  it('accepts the logins useradd would accept', () => {
    expect(status(['valid_login'], 'valid_login alice')).toBe(0);
    expect(status(['valid_login'], 'valid_login a_b-c9')).toBe(0);
  });

  it('rejects logins that would be trouble', () => {
    // A leading digit, an uppercase letter or a slash is either refused by
    // useradd or, worse, accepted and then unusable in the nginx regexes that
    // map a hostname back to a home directory.
    expect(status(['valid_login'], 'valid_login 9lives')).toBe(1);
    expect(status(['valid_login'], 'valid_login Alice')).toBe(1);
    expect(status(['valid_login'], 'valid_login ../root')).toBe(1);
    expect(status(['valid_login'], "valid_login ''")).toBe(1);
  });
});

describe('is_public_ip', () => {
  // This is the guard that stops a private address being published into DNS,
  // where the "points somewhere else" check would then refuse to correct it.
  it('accepts routable addresses', () => {
    expect(status(['is_public_ip'], 'is_public_ip 203.0.113.9')).toBe(0);
    expect(status(['is_public_ip'], 'is_public_ip 152.53.47.37')).toBe(0);
  });

  it('rejects the private and reserved ranges', () => {
    for (const ip of ['10.1.2.3', '192.168.0.1', '172.16.0.1', '172.31.255.1', '127.0.0.1']) {
      expect(status(['is_public_ip'], `is_public_ip ${ip}`)).toBe(1);
    }
  });

  it('rejects CGNAT, which is where a tailnet address lives', () => {
    // 100.64.0.0/10. Publishing one of these makes the name resolve only for
    // machines on the tailnet, which looks like a DNS outage to everyone else.
    for (const ip of ['100.64.0.1', '100.99.1.1', '100.127.255.254']) {
      expect(status(['is_public_ip'], `is_public_ip ${ip}`)).toBe(1);
    }
  });

  it('does not mistake a neighbouring range for CGNAT', () => {
    expect(status(['is_public_ip'], 'is_public_ip 100.63.0.1')).toBe(0);
    expect(status(['is_public_ip'], 'is_public_ip 100.128.0.1')).toBe(0);
  });

  it('rejects anything that is not four octets', () => {
    expect(status(['is_public_ip'], 'is_public_ip not-an-ip')).toBe(1);
    expect(status(['is_public_ip'], "is_public_ip ''")).toBe(1);
  });
});

describe('_expand_remote', () => {
  // The mountpoint mirrors the path as typed, but what NFS exports is the
  // expanded one, so the two have to be derived separately.
  it('expands a tilde against the remote account', () => {
    expect(shell(['_expand_remote'], '_expand_remote ubuntu "~/Downloads"')).toBe(
      '/home/ubuntu/Downloads',
    );
    expect(shell(['_expand_remote'], '_expand_remote ubuntu "~"')).toBe('/home/ubuntu');
  });

  it('leaves an absolute path alone', () => {
    expect(shell(['_expand_remote'], '_expand_remote ubuntu /srv/media')).toBe('/srv/media');
  });

  it('treats a bare path as relative to the remote home', () => {
    expect(shell(['_expand_remote'], '_expand_remote ubuntu data')).toBe('/home/ubuntu/data');
  });
});

describe('looks_like_dotfiles', () => {
  // A dotfiles checkout is recognised by content, not by name, so that any
  // repo can be one.
  it('accepts a tree with a .zshrc or a .bashrc', () => {
    expect(
      status(['looks_like_dotfiles'], 'd=$(mktemp -d); touch "$d/.zshrc"; looks_like_dotfiles "$d"'),
    ).toBe(0);
    expect(
      status(
        ['looks_like_dotfiles'],
        'd=$(mktemp -d); touch "$d/.bashrc"; looks_like_dotfiles "$d"',
      ),
    ).toBe(0);
  });

  it('rejects an empty directory, a missing one, and the empty string', () => {
    expect(status(['looks_like_dotfiles'], 'd=$(mktemp -d); looks_like_dotfiles "$d"')).toBe(1);
    expect(status(['looks_like_dotfiles'], 'looks_like_dotfiles /nope/not/here')).toBe(1);
    expect(status(['looks_like_dotfiles'], "looks_like_dotfiles ''")).toBe(1);
  });
});

describe('_certbot_email_args', () => {
  // certbot refuses to run non-interactively with neither -m nor
  // --register-unsafely-without-email, so the flag has to be chosen rather
  // than the argument left blank.
  it('passes -m when there is an address', () => {
    expect(shell(['_certbot_email_args'], 'ACME_EMAIL=ops@example.com; _certbot_email_args')).toBe(
      '-m\nops@example.com',
    );
  });

  it('registers without one when there is not', () => {
    expect(shell(['_certbot_email_args'], "ACME_EMAIL=''; _certbot_email_args")).toBe(
      '--register-unsafely-without-email',
    );
  });
});

describe('upgrading a box that this script already provisioned', () => {
  // The landing page is only rewritten when it still matches a marker this
  // script has stamped. Renaming the marker without keeping the old one makes
  // every already-provisioned box decide its own page was hand-edited, and
  // nothing afterwards can tell that page from one somebody really wrote.
  it('still recognises the marker from when this lived in the dotfiles repo', () => {
    expect(SOURCE).toContain('generated by dottemplates/root-ubuntu.sh');
    expect(SOURCE).toContain('generated by cli-tools/root-ubuntu.sh');
  });

  it('still recognises the placeholder from before markers existed', () => {
    expect(SOURCE).toContain('User pages are at');
  });
});

describe('valid_group', () => {
  it('accepts the names groupadd accepts', () => {
    expect(status(['valid_group'], 'valid_group users')).toBe(0);
    expect(status(['valid_group'], 'valid_group www-data')).toBe(0);
    expect(status(['valid_group'], 'valid_group _svc9')).toBe(0);
  });

  it('rejects the ones it does not', () => {
    expect(status(['valid_group'], 'valid_group 9lives')).toBe(1);
    expect(status(['valid_group'], 'valid_group WWW')).toBe(1);
    expect(status(['valid_group'], 'valid_group ../root')).toBe(1);
    expect(status(['valid_group'], "valid_group ''")).toBe(1);
  });
});

describe('_split_list', () => {
  // Mirrors --groups, which has always taken either separator. A subcommand
  // that accepted only one of them would be a second, stricter spelling of a
  // list the same script already parses loosely.
  it('splits on commas and on spaces alike', () => {
    expect(shell(['_split_list'], '_split_list sudo,docker')).toBe('sudo\ndocker');
    expect(shell(['_split_list'], '_split_list sudo docker')).toBe('sudo\ndocker');
    expect(shell(['_split_list'], '_split_list "sudo, docker" users')).toBe('sudo\ndocker\nusers');
  });

  it('drops empty fields rather than emitting a blank group name', () => {
    expect(shell(['_split_list'], '_split_list "sudo,,docker,"')).toBe('sudo\ndocker');
    expect(shell(['_split_list'], "_split_list ''")).toBe('');
  });
});

describe('_orphans_admin', () => {
  // The lockout guard. It is handed the member list rather than reading
  // /etc/group, which is the only reason it can be tested at all — the box
  // running the suite has no say in what `sudo` contains.
  it('fires when the login is the only member left of an admin group', () => {
    expect(status(['_orphans_admin'], '_orphans_admin sudo alice alice')).toBe(0);
    expect(status(['_orphans_admin'], '_orphans_admin admin alice alice')).toBe(0);
    expect(status(['_orphans_admin'], '_orphans_admin wheel alice alice')).toBe(0);
  });

  it('is quiet when somebody else is still in the group', () => {
    expect(status(['_orphans_admin'], '_orphans_admin sudo alice alice,bob')).toBe(1);
    expect(status(['_orphans_admin'], '_orphans_admin sudo alice bob,alice')).toBe(1);
  });

  it('does not guard groups that cannot lock the box', () => {
    // Being the last member of docker or users is not an outage, and refusing
    // it would make the guard something people learn to pass --force through.
    expect(status(['_orphans_admin'], '_orphans_admin docker alice alice')).toBe(1);
    expect(status(['_orphans_admin'], '_orphans_admin users alice alice')).toBe(1);
  });
});

describe('_extra_share_groups', () => {
  const call = (extra: string, share = 'users') =>
    shell(['_extra_share_groups'], `SHARE_GROUP=${share} SHARE_EXTRA_GROUPS=${extra} _extra_share_groups`);

  it('takes commas or spaces, like every other group list here', () => {
    expect(call('www-data,backup')).toBe('www-data\nbackup');
    expect(call("'www-data backup'")).toBe('www-data\nbackup');
  });

  it('drops $SHARE_GROUP, which is already the owning group', () => {
    // An ACL entry restating the group in the mode is not wrong, it is just
    // one more line of getfacl for a later reader to work out is redundant.
    expect(call('users,www-data')).toBe('www-data');
    expect(call('users')).toBe('');
  });

  it('deduplicates, so --group twice is not two ACL entries', () => {
    expect(call('www-data,www-data')).toBe('www-data');
  });

  it('is empty when nothing was asked for', () => {
    expect(call("''")).toBe('');
  });
});

describe('sharing a volume with a second group', () => {
  it('grants nothing at all unless asked, so no share silently gains an ACL', () => {
    // The early return matters more than it looks: without it, every existing
    // mount would start calling setfacl on a box that may not even have it.
    expect(
      status(
        ['_extra_share_groups', '_share_acl'],
        "warn() { :; }; info() { :; }; SHARE_GROUP=users SHARE_EXTRA_GROUPS='' _share_acl /nonexistent",
      ),
    ).toBe(0);
  });

  it('says which package is missing rather than failing silently', () => {
    // setfacl is not on a minimal Ubuntu image, and "nothing happened" is the
    // worst possible answer for a permission grant.
    expect(SOURCE).toContain('setfacl is missing');
    expect(SOURCE).toMatch(/apt install acl/);
  });

  it('installs acl, since --group cannot work without it', () => {
    expect(SOURCE).toMatch(/^\tacl$/m);
  });

  it('sets the mode before the ACL, never after', () => {
    // chmod recomputes the ACL mask from the group bits, and the mask caps
    // every named entry — so a grant made first is quietly narrowed by the
    // chmod that follows it, and getfacl then shows an entry that does not
    // apply. Order is the whole correctness argument here.
    const shared = SOURCE.slice(SOURCE.indexOf('_share_perms() {'));
    const chmod = shared.indexOf('chmod "$SHARE_DIR_MODE"');
    const acl = shared.indexOf('_share_acl "$dir" 0');
    expect(chmod).toBeGreaterThan(-1);
    expect(acl).toBeGreaterThan(chmod);
  });

  it('takes the ACL away again when a share goes private', () => {
    // 00700 says private while a leftover g:www-data:rwx entry still hands the
    // directory to a daemon, and `ls -l` shows the reassuring number.
    expect(SOURCE).toContain('setfacl -b "$dir"');
  });
});

describe('the groups subcommand', () => {
  const groups = (...args: string[]) =>
    execFileSync('bash', [SCRIPT, 'groups', ...args], { encoding: 'utf8' });

  it('lists accounts without being root, since reading is not a privileged act', () => {
    const out = groups();
    expect(out).toContain('LOGIN');
    expect(out).toContain('PRIMARY');
    // Whoever is running the suite is an account on this box, so they are in it.
    expect(out).toContain(execFileSync('id', ['-un'], { encoding: 'utf8' }).trim());
  });

  it('is peeled off before the root check, like the share subcommands', () => {
    expect(SOURCE).toContain('mount|umount|mounts|share|groups)');
    expect(SOURCE).toMatch(/groups\)\s+cmd_groups/);
  });

  it('refuses every mutation without root, and names the verb that needs it', () => {
    const cases: [string, ...string[]][] = [
      ['add', 'root', 'docker'],
      ['rm', 'root', 'docker'],
      ['set', 'root', 'docker'],
      ['create', 'sometestgroup'],
      ['delete', 'sometestgroup'],
    ];
    for (const [verb, ...rest] of cases) {
      let failed = false;
      try {
        execFileSync('bash', [SCRIPT, 'groups', verb, ...rest], { encoding: 'utf8', stdio: 'pipe' });
      } catch (error) {
        failed = true;
        expect(String((error as { stderr?: Buffer }).stderr)).toContain(
          `groups: ${verb} must run as root`,
        );
      }
      expect(failed).toBe(true);
    }
  });

  it('reports a group nobody is in without inventing a failure', () => {
    // `users` exists on every Ubuntu box; the point is that a group whose
    // member field is empty prints a row rather than an error.
    expect(groups('members', 'users')).toContain('gid 100');
  });

  it('counts the accounts whose PRIMARY group it is as members', () => {
    // /etc/group's member field holds supplementary members only, so a naive
    // reading of it says the www-data group does not contain www-data.
    expect(SOURCE).toContain('(primary)');
    expect(groups('members', 'www-data')).toContain('www-data (primary)');
  });

  it('never reaches groupdel from rm, nor gpasswd from delete', () => {
    // The one confusion this pair of verbs is named to survive. `rm` changes a
    // membership and `delete` removes a group; if either could reach the
    // other's tool, a slip of one word would be unrecoverable.
    const body = (fn: string) => {
      const start = SOURCE.indexOf(`${fn}() {`);
      expect(start).toBeGreaterThan(-1);
      return SOURCE.slice(start, SOURCE.indexOf('\n}\n', start));
    };
    expect(body('_groups_rm')).toContain('gpasswd -d');
    expect(body('_groups_rm')).not.toContain('groupdel');
    expect(body('_groups_delete')).toContain('groupdel');
    expect(body('_groups_delete')).not.toContain('gpasswd');
  });

  it('checks the login before the argument count, so a mixed-up rm says so', () => {
    // `groups rm docker` has to answer "no such user: docker", not print usage
    // and leave the reader to work out which of the two commands they held.
    const body = SOURCE.slice(SOURCE.indexOf('_groups_rm() {'));
    expect(body.indexOf('_groups_user "$login"')).toBeLessThan(
      body.indexOf('[[ $# -gt 0 ]] || { groups_usage; return 2; }'),
    );
  });

  it('documents both refusals in its own help', () => {
    const help = groups('--help');
    expect(help).toContain('--force');
    expect(help).toContain('--create');
    expect(help).toContain('locks this box out of root');
  });

  it('is offered by the top-level help', () => {
    const out = execFileSync('bash', [SCRIPT, '--help'], { encoding: 'utf8' });
    expect(out).toContain('groups add alice docker');
  });
});

describe('_size_mb', () => {
  const mb = (s: string) => shell(['_size_mb'], `_size_mb ${s}`);

  it('reads the sizes a person would actually write', () => {
    expect(mb('2G')).toBe('2048');
    expect(mb('2g')).toBe('2048');
    expect(mb('512M')).toBe('512');
  });

  it('assumes gigabytes for a bare number, because nobody means 2MB of swap', () => {
    expect(mb('4')).toBe('4096');
  });

  it('refuses anything it cannot read rather than guessing', () => {
    // The value ends up in `dd count=`, so a silent misread is a swapfile of
    // the wrong size -- or, with an empty count, no swapfile at all.
    expect(status(['_size_mb'], '_size_mb abc')).toBe(1);
    expect(status(['_size_mb'], '_size_mb "2 G"')).toBe(1);
    expect(status(['_size_mb'], '_size_mb ""')).toBe(1);
    expect(status(['_size_mb'], '_size_mb 2GB')).toBe(1);
  });
});

describe('configure_swap', () => {
  /**
   * The function reaches for swapon, mkswap, df and systemd-detect-virt, and
   * writes to /etc/fstab and /etc/sysctl.d. Those tools are stubbed and the
   * two absolute paths are rewritten into a temp directory with `declare -f`,
   * so what runs is the code in the file and the test still cannot touch the
   * machine it runs on. The SWAP_* declarations are top-level rather than
   * inside a function, so they are lifted out of the source the same way the
   * DEFAULT_GROUPS tests above lift theirs.
   */
  const decls = [...SOURCE.matchAll(/^(?:SWAP_SIZE|SWAP_FILE|SWAPPINESS)=.*$/gm)]
    .map((m) => m[0])
    .join('\n');

  const FNS = ['_size_mb', '_swap_sysctl', 'configure_swap', 'write_if_changed'];

  function stubs(dir: string): string {
    return `
      CHANGED=(); log() { :; }; info() { echo "$*"; }; warn() { echo "$*"; }
      note() { echo "changed: $*"; }
      sysctl() { :; }
      chown() { :; }
      mkswap() { return \${MKSWAP_RC:-0}; }
      swapon() {
        case "\${1:-}" in
          --show*) printf '%s' "\${FAKE_SWAPON_OUT:-}" ;;
          *) return \${SWAPON_RC:-0} ;;
        esac
      }
      systemd-detect-virt() { printf '%s' "\${FAKE_VIRT:-none}"; }
      df() { if [[ -n "\${FAKE_DF:-}" ]]; then printf '%s\\n' "\$FAKE_DF"; else command df "\$@"; fi; }
      eval "\$(declare -f configure_swap _swap_sysctl \\
        | sed 's#/etc/fstab#${dir}/fstab#g; s#/etc/sysctl.d/[a-z0-9-]*\\.conf#${dir}/sysctl.conf#g')"
      ${decls}
    `;
  }

  /** A temp dir standing in for /etc, with an fstab that has no swap in it. */
  function box(): string {
    const dir = mkdtempSync(join(tmpdir(), 'root-ubuntu-swap-'));
    writeFileSync(join(dir, 'fstab'), '/dev/sda1 / ext4 defaults 0 1\n');
    return dir;
  }

  const swap = (dir: string, env = '') =>
    shell(FNS, `${stubs(dir)}\n${env} SWAP_FILE=${dir}/swapfile configure_swap`);

  const fstabOf = (dir: string) => readFileSync(join(dir, 'fstab'), 'utf8');

  it('makes a swapfile on a box that has none, and brings it back after a reboot', () => {
    const dir = box();
    const out = swap(dir, 'SWAP_SIZE=8M');
    expect(out).toContain('changed: 8M swap at');
    expect(fstabOf(dir)).toMatch(/swapfile\s+none\s+swap\s+sw/);
    expect(statSync(join(dir, 'swapfile')).size).toBe(8 * 1024 * 1024);
  });

  it('makes it unreadable, since swap is everything the box ever paged out', () => {
    const dir = box();
    swap(dir, 'SWAP_SIZE=8M');
    expect(statSync(join(dir, 'swapfile')).mode & 0o777).toBe(0o600);
  });

  it('leaves a box that already has swap completely alone', () => {
    // A swapfile stacked on a swap partition or a zram device is not more
    // safety, it is a file nobody remembers making.
    const dir = box();
    const out = swap(dir, "FAKE_SWAPON_OUT=$'/dev/sda2\\tpartition\\t4G\\n' SWAP_SIZE=8M");
    expect(out).toContain('swap already active: /dev/sda2 (partition, 4G)');
    expect(fstabOf(dir)).not.toContain('swapfile');
  });

  it('still sets swappiness when the swap was already there', () => {
    // The tuning is the point even when the swap is not ours: 60 pages out
    // things that are still being used.
    const dir = box();
    expect(swap(dir, "FAKE_SWAPON_OUT=$'/dev/sda2\\tpartition\\t4G\\n'")).toContain(
      'changed: vm.swappiness=10',
    );
    expect(readFileSync(join(dir, 'sysctl.conf'), 'utf8')).toContain('vm.swappiness = 10');
  });

  it('does nothing at all when SWAP_SIZE is 0', () => {
    const dir = box();
    expect(swap(dir, 'SWAP_SIZE=0')).toContain('swap disabled');
    expect(fstabOf(dir)).not.toContain('swapfile');
  });

  it('does not try to swap inside a container', () => {
    // The kernel and its swap belong to the host. swapon in here either fails
    // outright or is refused by the cgroup once the file already exists.
    const dir = box();
    const out = swap(dir, 'FAKE_VIRT=lxc SWAP_SIZE=8M');
    expect(out).toContain('inside a lxc container');
    expect(fstabOf(dir)).not.toContain('swapfile');
  });

  it('refuses btrfs and zfs, where a plain swapfile is wrong or dangerous', () => {
    // btrfs needs chattr +C and no compression; a swapfile on zfs can deadlock
    // the box under exactly the memory pressure it was added to survive.
    const dir = box();
    expect(swap(dir, "FAKE_DF=$'FSTYPE\\nbtrfs' SWAP_SIZE=8M")).toContain('btrfs');
    expect(swap(dir, "FAKE_DF=$'FSTYPE\\nzfs' SWAP_SIZE=8M")).toContain('deadlock');
    expect(fstabOf(dir)).not.toContain('swapfile');
  });

  it('will not fill the disk to buy memory headroom', () => {
    // A full / breaks things a memory spike would never have touched.
    const dir = box();
    expect(swap(dir, "FAKE_DF=$'ext4\\n900M' SWAP_SIZE=2G")).toContain('plus headroom -- skipping');
    expect(fstabOf(dir)).not.toContain('swapfile');
  });

  it('fails loudly on a size it cannot read', () => {
    const dir = box();
    expect(status(FNS, `${stubs(dir)}\nSWAP_SIZE=lots SWAP_FILE=${dir}/f configure_swap`)).toBe(1);
  });

  it('is safe to run twice: no second file, no second fstab line', () => {
    // Everything else in this script converges on a re-run, and an appender
    // that does not is how /etc/fstab grows a line a month.
    const dir = box();
    swap(dir, 'SWAP_SIZE=8M');
    const out = swap(dir, 'SWAP_SIZE=8M');
    expect(out).toContain('fstab already brings');
    expect(fstabOf(dir).split('\n').filter((l) => l.includes('swapfile'))).toHaveLength(1);
  });

  it('cleans up the half-made file when mkswap fails', () => {
    // A 2G file that is not swap is 2G of disk gone for nothing, and the next
    // run would find it sitting there and take it for the real thing.
    const dir = box();
    const out = shell(
      FNS,
      `${stubs(dir)}
       MKSWAP_RC=1 SWAP_SIZE=8M SWAP_FILE=${dir}/swapfile configure_swap
       [[ -e ${dir}/swapfile ]] && echo LEFTOVER || echo "cleaned up"`,
    );
    expect(out).toContain('mkswap failed');
    expect(out).toContain('cleaned up');
  });

  it('cleans up when swapon itself fails', () => {
    const dir = box();
    const out = shell(
      FNS,
      `${stubs(dir)}
       SWAPON_RC=1 SWAP_SIZE=8M SWAP_FILE=${dir}/swapfile configure_swap
       [[ -e ${dir}/swapfile ]] && echo LEFTOVER || echo "cleaned up"`,
    );
    expect(out).toContain('swapon failed');
    expect(out).toContain('cleaned up');
    expect(fstabOf(dir)).not.toContain('swapfile');
  });

  it('refuses a path that is not a file instead of deleting it', () => {
    // SWAP_FILE is configurable, and `rm -f` on a typo that happens to name a
    // directory would be a very bad afternoon.
    const dir = box();
    mkdirSync(join(dir, 'adirectory'));
    const out = shell(
      FNS,
      `${stubs(dir)}
       SWAP_SIZE=8M SWAP_FILE=${dir}/adirectory configure_swap
       [[ -d ${dir}/adirectory ]] && echo "still a directory"`,
    );
    expect(out).toContain('exists and is not a file');
    expect(out).toContain('still a directory');
  });

  it('never leaves the swapfile readable, whatever the chown does', () => {
    // Chained behind a chown, one failure there would leave the mode wide
    // open -- and mkswap would still be perfectly happy with the file.
    const body = SOURCE.slice(SOURCE.indexOf('configure_swap() {'));
    const chmod = body.indexOf('chmod 0600 "$file"');
    const chown = body.indexOf('chown root:root "$file"');
    expect(chmod).toBeGreaterThan(-1);
    expect(chown).toBeGreaterThan(chmod);
    expect(body.slice(chmod, chown)).not.toContain('&&');
  });

  it('matches the fstab entry on the path, so a hand-edited line survives', () => {
    expect(SOURCE).toMatch(/awk -v f="\$file" '\$1 == f && \$3 == "swap"/);
  });

  it('is documented as a step and as an env override', () => {
    const help = execFileSync('bash', [SCRIPT, '--help'], { encoding: 'utf8' });
    expect(help).toContain('swapfile');
    expect(help).toContain('SWAP_SIZE=2G');
  });
});

describe('configure_sensors', () => {
  /**
   * Everything this function does to the machine goes through six commands:
   * `command -v`, systemd-detect-virt, compgen -G over /sys, modprobe,
   * sensors-detect and systemctl. Shadowing those six runs the real body and
   * leaves the assertions about which branch it took. HWMON stands in for
   * "/sys/class/hwmon has a temp*_input in it", and the sensors-detect stub
   * flips it -- which is what makes the re-check after detection meaningful
   * rather than a restatement of the stub's own return code.
   */
  const stubs = `
    info() { echo "info: $*"; }
    note() { echo "note: $*"; }
    warn() { echo "warn: $*"; }
    command() {
      case "\${2:-}" in
        sensors-detect) return "\${NO_SENSORS_DETECT:-0}" ;;
        systemd-detect-virt) return 0 ;;
      esac
      return 1
    }
    systemd-detect-virt() { printf '%s' "\${FAKE_VIRT:-none}"; }
    compgen() { [[ "\${HWMON:-0}" == 1 ]]; }
    modprobe() { MODPROBED="\$*"; }
    systemctl() { SYSTEMCTLED="\$*"; }
    sensors-detect() { DETECT_RAN="\$*"; HWMON="\${DETECT_FINDS:-0}"; return "\${DETECT_RC:-0}"; }
  `;

  const sensors = (env = '') =>
    shell(
      ['configure_sensors'],
      `${stubs}\n${env} configure_sensors\n` +
        'echo "ran=[${DETECT_RAN-}] modprobe=[${MODPROBED-}] systemctl=[${SYSTEMCTLED-}]"',
    );

  it('does nothing at all when lm-sensors is not installed', () => {
    const out = sensors('NO_SENSORS_DETECT=1');
    expect(out).toContain('lm-sensors not installed');
    expect(out).toContain('ran=[]');
  });

  it('skips the probe in a VM, which is never shown the host thermal hardware', () => {
    // Without this guard sensors-detect writes an empty config on every
    // Droplet, which reads like a failed detection rather than like a machine
    // with nothing to detect.
    const out = sensors('FAKE_VIRT=kvm');
    expect(out).toContain('running under kvm');
    expect(out).toContain('ran=[]');
  });

  it('leaves a box alone when hwmon already has readings', () => {
    const out = sensors('HWMON=1');
    expect(out).toContain('already available');
    expect(out).toContain('ran=[]');
  });

  it('loads i2c-dev before probing, because --auto answers no to that prompt', () => {
    // sensors-detect finds SMBus chips through /dev/i2c-*, which do not exist
    // until i2c-dev is loaded, and --auto takes the default answer -- no.
    const out = sensors('DETECT_FINDS=1');
    expect(out).toContain('modprobe=[i2c-dev]');
    expect(out).toContain('ran=[--auto]');
    expect(out).toContain('note: hardware sensors detected');
    expect(out).toContain('systemctl=[restart kmod]');
  });

  it('re-checks hwmon afterwards rather than trusting a zero exit', () => {
    // sensors-detect exits 0 on a machine with no supported chips, so the
    // only honest evidence is a temp*_input appearing under /sys.
    const out = sensors('DETECT_FINDS=0');
    expect(out).toContain('ran=[--auto]');
    expect(out).toContain('found no supported chips');
    expect(out).not.toContain('hardware sensors detected');
  });

  it('warns when the probe errors, and still returns 0 so the run continues', () => {
    const out = sensors('DETECT_RC=1');
    expect(out).toContain('warn: sensors-detect failed');
    expect(status(['configure_sensors'], `${stubs}\nDETECT_RC=1 configure_sensors`)).toBe(0);
  });

  it('installs the package it needs, and is wired into the apt step', () => {
    // A detection step is dead code if the package never lands, and the
    // package is dead weight if nothing ever probes for the chips.
    expect(SOURCE).toMatch(/^\tlm-sensors i2c-tools/m);
    expect(SOURCE).toContain('try "sensors" configure_sensors');
  });
});
