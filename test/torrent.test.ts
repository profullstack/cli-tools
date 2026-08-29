import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_TRACKERS,
  UDP_TRACKERS,
  WSS_TRACKERS,
  addBody,
  createArgs,
  infoHash,
  infoSection,
  magnetFor,
  magnetUri,
  spanEnd,
  torrentName,
} from '../src/torrent.ts';

/* A minimal bencoder, so the fixtures below are readable rather than hex. */
const bstr = (s: string) => `${Buffer.byteLength(s)}:${s}`;
const TORRENT = Buffer.from(
  `d8:announce${bstr('udp://a.test:1337/announce')}4:infod6:lengthi12e4:name${bstr('thing.txt')}12:piece lengthi16384ee5:extra${bstr('after the info dict')}e`,
  'utf8',
);

describe('trackers', () => {
  /*
   * The half of the list that decides whether a web player can see the torrent
   * at all. A browser is only ever a WebRTC peer, so with no wss:// tracker the
   * torrent is on the DHT, desktop clients find it, and the browser sees a
   * torrent with no peers -- which reads as a dead torrent rather than as a
   * missing tracker.
   */
  it('always announces to both kinds', () => {
    expect(WSS_TRACKERS.length).toBeGreaterThan(0);
    expect(UDP_TRACKERS.length).toBeGreaterThan(0);
    expect(DEFAULT_TRACKERS).toEqual([...WSS_TRACKERS, ...UDP_TRACKERS]);
  });

  /*
   * These four ship in the WebTorrent tooling's default announce list and none
   * of them answers: leechers-paradise has no DNS at all, coppersurfer and
   * empire-js time out on a UDP connect, and btorrent.xyz serves a self-signed
   * certificate that a browser refuses outright.
   */
  it('carries none of the dead defaults', () => {
    const dead = ['leechers-paradise', 'coppersurfer', 'empire-js', 'btorrent.xyz'];
    for (const host of dead) {
      expect(DEFAULT_TRACKERS.join(' ')).not.toContain(host);
    }
  });
});

describe('createArgs', () => {
  it('repeats --announce once per tracker', () => {
    const args = createArgs('dir', { trackers: ['udp://a', 'wss://b'] });
    expect(args.filter((a) => a === '--announce')).toHaveLength(2);
    expect(args).toEqual(expect.arrayContaining(['udp://a', 'wss://b']));
  });

  it('puts the path first, where create-torrent wants it', () => {
    expect(createArgs('dir', { out: 'x.torrent' })[0]).toBe('dir');
  });

  /*
   * A private torrent is excluded from the DHT by every client that honours the
   * flag, which is the exact opposite of the reason to make one here.
   */
  it('is public unless privacy was asked for by name', () => {
    expect(createArgs('dir')).not.toContain('--private');
    expect(createArgs('dir', { isPrivate: true })).toContain('--private');
  });
});

describe('reading a torrent', () => {
  it('finds the end of each bencoded shape', () => {
    expect(spanEnd(Buffer.from('i42e'), 0)).toBe(4);
    expect(spanEnd(Buffer.from('4:spam'), 0)).toBe(6);
    expect(spanEnd(Buffer.from('l4:spami1ee'), 0)).toBe(11);
    expect(spanEnd(Buffer.from('d3:onei1ee'), 0)).toBe(10);
  });

  /*
   * The span has to be the ORIGINAL bytes. The info hash is a SHA-1 over them,
   * so decoding the dictionary and re-encoding it would produce a different
   * hash the moment a client wrote a key in an order or a form we did not
   * reproduce -- and the torrent would be a different torrent.
   */
  it('takes the info dictionary verbatim, and stops at its end', () => {
    const info = infoSection(TORRENT);
    expect(info.toString('utf8').startsWith('d6:length')).toBe(true);
    expect(info.toString('utf8').endsWith('e')).toBe(true);
    expect(info.toString('utf8')).not.toContain('after the info dict');
  });

  it('reads the name out of the info dictionary', () => {
    expect(torrentName(TORRENT)).toBe('thing.txt');
  });

  it('refuses a file that is not a torrent rather than hashing rubbish', () => {
    expect(() => infoHash(Buffer.from('not a torrent'))).toThrow(/not a torrent/);
    expect(() => infoHash(Buffer.from('d4:spam'))).toThrow(/truncated|not a torrent/);
  });
});

describe('magnetUri', () => {
  it('builds xt, dn and one tr per tracker', () => {
    const hash = 'a'.repeat(40);
    const magnet = magnetUri({ hash, name: 'my thing', trackers: ['udp://a', 'wss://b'] });
    expect(magnet).toContain(`xt=urn:btih:${hash}`);
    expect(magnet).toContain('dn=my%20thing');
    expect(magnet.match(/tr=/g)).toHaveLength(2);
    // The tracker itself must survive the round trip; a bare & would truncate it.
    expect(magnet).toContain(encodeURIComponent('udp://a'));
  });

  it('refuses anything that is not an info hash', () => {
    expect(() => magnetUri({ hash: 'nope' })).toThrow(/not an info hash/);
    expect(() => magnetUri({ hash: 'a'.repeat(39) })).toThrow(/not an info hash/);
  });
});

describe('addBody', () => {
  it('is the shape torlnk POST /add takes', () => {
    expect(JSON.parse(addBody('magnet:?xt=urn:btih:abc'))).toEqual({ magnet: 'magnet:?xt=urn:btih:abc' });
  });
});

/*
 * The assertion the rest of this file rests on.
 *
 * Everything above is our own arithmetic checked against our own fixture, which
 * proves only that it is self-consistent. This hashes a torrent produced by a
 * real client and compares against the info hash that client computed: if the
 * bencode scan is off by a byte at either end, this is what says so.
 */
describe('against a real client', () => {
  it('computes the info hash WebTorrent computes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-tools-torrent-'));
    const data = join(dir, 'sample');
    mkdirSync(data);
    writeFileSync(join(data, 'a.txt'), 'hello torrent world\n');

    let created: string;
    try {
      created = join(dir, 'sample.torrent');
      execFileSync('npx', ['--yes', 'create-torrent', data, '-o', created], {
        stdio: 'ignore',
        timeout: 120_000,
      });
    } catch {
      // No network, or no npx: the offline assertions above still stand.
      return;
    }

    const buf = readFileSync(created);
    // create-torrent embeds the same info dict WebTorrent would, so its own
    // reader is the reference for what we computed.
    const expected = execFileSync('npx', ['--yes', 'parse-torrent', created], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(expected).toContain(infoHash(buf));
    expect(magnetFor(buf)).toContain(infoHash(buf));
  });
});

describe('web seeds', () => {
  /*
   * A web seed is what makes a torrent downloadable before any peer has it: an
   * HTTP URL every client can pull the same bytes from, with no seeding process
   * in the path at all.
   */
  it('adds one --urlList per URL, and none when there are none', () => {
    expect(createArgs('dir')).not.toContain('--urlList');
    const args = createArgs('dir', { webSeeds: ['https://a.test/f', 'https://b.test/f'] });
    expect(args.filter((a) => a === '--urlList')).toHaveLength(2);
    expect(args).toEqual(expect.arrayContaining(['https://a.test/f', 'https://b.test/f']));
  });
});
