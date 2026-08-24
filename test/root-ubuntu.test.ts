import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
