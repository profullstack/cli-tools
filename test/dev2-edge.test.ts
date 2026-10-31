import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * dev2/dev2-edge: pit.world + Moshpit names on Caddy behind an nginx stream proxy on :443,
 * every other dev2 site on nginx (127.0.0.1:8444, PROXY protocol). These tests cover the
 * pieces that decide whether production keeps answering: the `listen 443` rewrite every
 * nginx start/reload runs, the rendered stream map and Caddyfile, and the certificate
 * bundling that keeps Caddy on the renewals dev2 already has.
 */
const EDGE = resolve(__dirname, '../dev2/edge');
const LISTEN = join(EDGE, 'nginx-edge-listen');
const CERTS = join(EDGE, 'caddy-edge-certs');
const CLI = resolve(__dirname, '../dev2/dev2-edge');
const SPEC = JSON.parse(readFileSync(join(EDGE, 'edge.json'), 'utf8'));

let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });
const tmp = () => (dir = mkdtempSync(join(tmpdir(), 'dev2-edge-')));
const py = (args: string[], env: Record<string, string> = {}) =>
  spawnSync('python3', args, { encoding: 'utf8', env: { ...process.env, ...env } });

describe('nginx-edge-listen', () => {
  const VHOST = [
    'server {',
    '    listen 80;',
    '    listen [::]:80;',
    '    return 301 https://$host$request_uri;',
    '}',
    'server {',
    '    listen 443 ssl;',
    '    listen [::]:443 ssl;',
    '    http2 on;',
    '    server_name a.example;',
    '}',
    'server {',
    '    listen 443 ssl http2 default_server reuseport backlog=511; # managed by Certbot',
    '    listen [::]:443 ssl ipv6only=on; # managed by Certbot',
    '    listen 0.0.0.0:443;',
    '    listen 443 quic reuseport;',
    '    listen 8443 ssl;',
    '    # listen 443 ssl;',
    '}',
    'server { listen 443 ssl; listen [::]:443 ssl; server_name one.line; }',
    '',
  ].join('\n');

  function write(): string {
    const d = tmp();
    mkdirSync(join(d, 'sites-available'));
    mkdirSync(join(d, 'sites-enabled'));
    mkdirSync(join(d, 'conf.d'));
    writeFileSync(join(d, 'sites-available', 'a'), VHOST);
    chmodSync(join(d, 'sites-available', 'a'), 0o640);
    symlinkSync(join(d, 'sites-available', 'a'), join(d, 'sites-enabled', 'a'));
    return d;
  }

  it('moves every TCP listen 443 behind the edge and leaves the rest alone', () => {
    const d = write();
    const r = py([LISTEN], { EDGE_NGINX_DIR: d });
    expect(r.status).toBe(0);
    const out = readFileSync(join(d, 'sites-available', 'a'), 'utf8');
    expect(out).not.toMatch(/^\s*listen\s+(\S+:)?443\s+ssl/m);
    expect(out).not.toMatch(/listen \[::\]:443/);
    expect(out).toContain('    listen 127.0.0.1:8444 ssl proxy_protocol;\n');
    // socket options cannot repeat on the shared backend listen; server options stay
    expect(out).toContain('    listen 127.0.0.1:8444 ssl http2 default_server proxy_protocol; # managed by Certbot');
    expect(out).toContain('    listen 127.0.0.1:8444 ssl proxy_protocol;\n    listen 443 quic reuseport;');
    expect(out).toContain('listen 8443 ssl;');
    expect(out).toContain('# listen 443 ssl;');
    expect(out).toContain('listen 80;\n    listen [::]:80;');
    expect(out).toContain('server { listen 127.0.0.1:8444 ssl proxy_protocol;  server_name one.line; }');
    expect(out).toContain('# edge: [::]:443 belongs to the stream proxy (nginx-edge-listen) managed by Certbot');
  });

  it('rewrites the target of a sites-enabled symlink in place, keeping link and mode', () => {
    const d = write();
    py([LISTEN], { EDGE_NGINX_DIR: d });
    const link = join(d, 'sites-enabled', 'a');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(d, 'sites-available', 'a'));
    expect(statSync(join(d, 'sites-available', 'a')).mode & 0o777).toBe(0o640);
    expect(readdirSync(join(d, 'sites-available'))).toEqual(['a']); // no temp file left
  });

  it('is idempotent, and --check reports whether anything is left', () => {
    const d = write();
    expect(py([LISTEN, '--check'], { EDGE_NGINX_DIR: d }).status).toBe(1);
    py([LISTEN], { EDGE_NGINX_DIR: d });
    const once = readFileSync(join(d, 'sites-available', 'a'), 'utf8');
    const again = py([LISTEN], { EDGE_NGINX_DIR: d });
    expect(again.stdout).toBe('');
    expect(readFileSync(join(d, 'sites-available', 'a'), 'utf8')).toBe(once);
    expect(py([LISTEN, '--check'], { EDGE_NGINX_DIR: d }).status).toBe(0);
  });

  it("edge-box rollback's reverse rewrite gives a plain listen 443 back", () => {
    const d = write();
    py([LISTEN], { EDGE_NGINX_DIR: d });
    const moved = readFileSync(join(d, 'sites-available', 'a'), 'utf8');
    const code = [
      'import importlib.machinery, importlib.util, sys',
      `l = importlib.machinery.SourceFileLoader("eb", ${JSON.stringify(join(EDGE, 'edge-box'))})`,
      'm = importlib.util.module_from_spec(importlib.util.spec_from_loader(l.name, l)); l.exec_module(m)',
      'sys.stdout.write(m.reverse_listen(sys.stdin.read()))',
    ].join('\n');
    const back = execFileSync('python3', ['-c', code], { input: moved, encoding: 'utf8' });
    expect(back).not.toContain('8444');
    expect(back).toContain('    listen 443 ssl;\n    listen [::]:443 ssl;\n    http2 on;');
  });
});

describe('dev2-edge render', () => {
  function render(off = false) {
    const d = tmp();
    const r = py([CLI, 'render', '--out', d, ...(off ? ['--off'] : [])]);
    expect(r.status, r.stderr).toBe(0);
    const f = (p: string) => readFileSync(join(d, 'root', p), 'utf8');
    return { d, stream: f('etc/nginx/stream-enabled/dev2-edge.conf'), caddy: f('etc/caddy/Caddyfile'), realip: f('etc/nginx/conf.d/00-edge-realip.conf'), sources: f('etc/caddy/edge-cert-sources') };
  }

  it('routes the pit.world names to Caddy and everything else to nginx, with PROXY protocol', () => {
    const { stream } = render();
    expect(stream).toMatch(/listen 443;\s+listen \[::\]:443;\s+ssl_preread on;/);
    expect(stream).toContain('proxy_protocol on;');
    expect(stream).toMatch(/default\s+127\.0\.0\.1:8444;/);
    expect(stream).toMatch(/\n\s+pit\.world\s+127\.0\.0\.1:8453;/);
    expect(stream).toMatch(/\n\s+\*\.pit\.world\s+127\.0\.0\.1:8453;/);
    expect(stream).toMatch(/\n\s+chovy\.hacker\s+127\.0\.0\.1:8453;/);
    // an exact name under a routed wildcard can stay on nginx
    expect(stream).toMatch(/\n\s+live\.streaming\.pit\.world\s+127\.0\.0\.1:8444;/);
    expect(stream).toContain('hostnames;');
  });

  it('--off routes every name to nginx (the fast way back)', () => {
    const { stream } = render(true);
    expect(stream).not.toContain(':8453');
    expect(stream).toMatch(/default\s+127\.0\.0\.1:8444;/);
  });

  it('gives Caddy a site for every routed host, the upstream nginx used, and no ACME', () => {
    const { caddy } = render();
    expect(caddy).toContain('auto_https off');
    expect(caddy).toContain('default_bind 127.0.0.1');
    expect(caddy).toContain('https_port 8453');
    expect(caddy).toMatch(/listener_wrappers \{\s+proxy_protocol \{[^}]*allow 127\.0\.0\.1\/32\s+\}\s+tls\s+\}/);
    expect(caddy).toContain('protocols h1 h2');
    expect(caddy).not.toMatch(/on_demand|acme_ca|\bemail\b/);
    expect(caddy).toContain('header_up X-Real-IP {remote_host}');
    for (const site of SPEC.sites) {
      const head = site.hosts.map((h: string) => `https://${h}`).join(', ') + ' {';
      expect(caddy).toContain(head);
      const block = caddy.slice(caddy.indexOf(head), caddy.indexOf('\n}\n', caddy.indexOf(head)));
      if (site.proxy && site.retry) expect(block).toContain(`reverse_proxy 127.0.0.1:${site.proxy}`);
      else if (site.proxy) expect(block).toContain(`import edge_proxy ${site.proxy}`);
      if (site.root) expect(block).toContain(`root * ${site.root}`);
      if (site.redirect) expect(block).toContain(`redir ${site.redirect} 301`);
      if (site.max_body) expect(block).toContain(`max_size ${site.max_body}`);
      expect(block).toContain(site.moshpit ? 'import edge_tls_moshpit' : 'import edge_tls');
    }
    const agentDb = caddy.slice(caddy.indexOf('https://agent.database.pit.world {'));
    expect(agentDb).toContain('output file /var/log/caddy/agent.database.pit.world.access.log');
    expect(agentDb).toContain('request>uri regexp `\\?.*` ""');
    expect(agentDb).toContain('request>headers delete');
    expect(agentDb).toContain('resp_headers delete');
    expect(caddy).toMatch(/\(edge_tls_moshpit\) \{\s+tls \{\s+load \/etc\/caddy\/edge-certs\s+protocols tls1\.3/);
  });

  it('every name the stream sends to Caddy has a Caddy site', () => {
    const { stream } = render();
    const routed = [...stream.matchAll(/^\s+(\S+)\s+127\.0\.0\.1:8453;/gm)].map((m) => m[1]);
    const hosts: string[] = SPEC.sites.flatMap((s: { hosts: string[] }) => s.hosts);
    for (const r of routed) {
      const ok = r.startsWith('*.') ? hosts.some((h) => h.startsWith('*.') && h.endsWith(r.slice(1))) : hosts.includes(r);
      expect(ok, r).toBe(true);
    }
  });

  it('restores the visitor address in nginx and keeps redirects off :8444', () => {
    const { realip, sources } = render();
    expect(realip).toContain('set_real_ip_from 127.0.0.1;');
    expect(realip).toContain('real_ip_header proxy_protocol;');
    expect(realip).toContain('port_in_redirect off;');
    expect(sources).toContain('/etc/letsencrypt/live/pit.world fullchain.pem privkey.pem pit.world');
    expect(sources).toContain('/etc/nginx/pit-proxy-certs');
    expect(sources).toContain('/etc/ssl/moshpit');
  });

  it('the Caddyfile adapts, when a caddy binary is on PATH', () => {
    const which = spawnSync('sh', ['-c', 'command -v caddy'], { encoding: 'utf8' });
    if (which.status !== 0) return;
    const { d } = render();
    const r = spawnSync('caddy', ['adapt', '--config', join(d, 'root/etc/caddy/Caddyfile'), '--adapter', 'caddyfile'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  });
});

describe('caddy-edge-certs', () => {
  function pair(d: string, name: string, cn = name) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '2',
      '-subj', `/CN=${cn}`, '-keyout', join(d, `${name}.key`), '-out', join(d, `${name}.crt`)], { stdio: 'ignore' });
  }

  function setup() {
    const d = tmp();
    const src = join(d, 'src'), le = join(d, 'le');
    mkdirSync(src); mkdirSync(le);
    pair(src, 'a.b.pit.world');
    pair(src, 'chovy.hacker');
    pair(src, 'bad'); pair(src, 'other');
    writeFileSync(join(src, 'bad.key'), readFileSync(join(src, 'other.key'))); // mismatched pair
    writeFileSync(join(src, 'moshpit-root-ca.crt'), readFileSync(join(src, 'chovy.hacker.crt'))); // no key: not served
    pair(le, 'fullchain'); // as fullchain.crt/key; listed explicitly below
    const sources = join(d, 'sources');
    writeFileSync(sources, `# test\n${src}\n${le} fullchain.crt fullchain.key pit.world\n`);
    const gid = execFileSync('id', ['-gn'], { encoding: 'utf8' }).trim();
    const env = { EDGE_CERT_OUT: join(d, 'out', 'edge-certs'), EDGE_CERT_SOURCES: sources, EDGE_CERT_GROUP: gid, EDGE_CERT_RELOAD: 'echo RELOADED' };
    return { d, env };
  }

  it('bundles every matching pair, skips a mismatched one, and reloads once', () => {
    const { d, env } = setup();
    const r = spawnSync('sh', [CERTS], { encoding: 'utf8', env: { ...process.env, ...env } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('RELOADED');
    expect(r.stderr).toContain('do not match');
    const out = join(d, 'out', 'edge-certs');
    expect(readdirSync(out).sort()).toEqual(['a.b.pit.world.pem', 'chovy.hacker.pem', 'other.pem', 'pit.world.pem']);
    const b = readFileSync(join(out, 'chovy.hacker.pem'), 'utf8');
    expect(b).toContain('BEGIN CERTIFICATE');
    expect(b).toContain('PRIVATE KEY');
    expect(statSync(join(out, 'chovy.hacker.pem')).mode & 0o777).toBe(0o640);

    const again = spawnSync('sh', [CERTS], { encoding: 'utf8', env: { ...process.env, ...env } });
    expect(again.status).toBe(0);
    expect(again.stdout).not.toContain('RELOADED');
    expect(existsSync(join(d, 'out', 'edge-certs.old'))).toBe(false);
  });
});
