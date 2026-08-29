/**
 * Making a torrent out of a directory, and getting it seeded.
 *
 * Two programs do the work and neither is bundled: `create-torrent` writes the
 * .torrent, and torlnk seeds it. Everything here is the part in between --
 * argv, the info hash, the magnet, and the trackers -- because that part can be
 * reasoned about and tested without a network or a peer.
 *
 * The info hash is computed here rather than read from a library on purpose.
 * `create-torrent` writes a file and does not tell you the hash, and the only
 * thing standing between that file and a magnet URI is a SHA-1 over the
 * bencoded `info` dictionary. Pulling in a bencode parser to find one span in a
 * buffer would be a dependency for forty lines, in a repository whose only
 * dependency is optional.
 */

import { createHash } from 'node:crypto';

/**
 * The trackers a new torrent announces to, and why these ones.
 *
 * Both halves are load-bearing and they serve different peers:
 *
 *   wss://   the only way a browser can be a peer. A page running WebTorrent
 *            speaks WebRTC and nothing else, so a torrent with no WSS tracker
 *            is invisible to every web player -- it is on the DHT, desktop
 *            clients find it, and the browser sees a torrent with no peers.
 *   udp://   everything else, and the reason a DHT crawler notices you exist
 *            in the first place.
 *
 * The list is short because it was checked rather than copied. The default
 * announce list shipped by the WebTorrent tooling still carries
 * tracker.leechers-paradise.org (no DNS at all), coppersurfer.tk and
 * empire-js.us (both time out on a UDP connect), and tracker.btorrent.xyz
 * (a self-signed certificate, so a browser refuses it outright). Every entry
 * below completed a real handshake -- a WebSocket open, or a UDP connect that
 * came back with a connection id.
 */
export const WSS_TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
];

export const UDP_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://explodie.org:6969/announce',
];

export const DEFAULT_TRACKERS = [...WSS_TRACKERS, ...UDP_TRACKERS];

/** The argv for `create-torrent`. */
export function createArgs(
  path: string,
  { out, trackers = DEFAULT_TRACKERS, name, comment, isPrivate = false, webSeeds = [] }: {
    out?: string;
    trackers?: readonly string[];
    name?: string;
    comment?: string;
    isPrivate?: boolean;
    /** HTTP URLs that already serve this exact data (BEP 19 web seeds). */
    webSeeds?: readonly string[];
  } = {},
): string[] {
  const args = [path];
  if (out) args.push('-o', out);
  if (name) args.push('-n', name);
  if (comment) args.push('--comment', comment);
  // A private torrent is excluded from the DHT by every client that honours the
  // flag, which is the opposite of the point here -- so it is opt-in and named.
  if (isPrivate) args.push('--private');
  for (const tracker of trackers) args.push('--announce', tracker);
  // A web seed is a plain HTTP URL every peer can also pull bytes from, so a
  // torrent with one is downloadable the moment it exists -- before any peer
  // has it, and without a seeding process at all. The URL has to serve the
  // exact bytes the torrent was made from; a redirect to a different encoding
  // is a torrent that fails its hash check rather than one that is merely slow.
  for (const url of webSeeds) args.push('--urlList', url);
  return args;
}

/**
 * The end offset of the bencoded value that starts at `at`.
 *
 * Bencode is four shapes and each one says where it ends, so finding a span
 * never needs the value itself: `i…e` is an integer, `<len>:<bytes>` a string,
 * `l…e` a list and `d…e` a dictionary, the last two holding more of the same.
 */
export function spanEnd(buf: Buffer, at: number): number {
  const byte = buf[at];
  if (byte === undefined) throw new Error('truncated torrent: ran off the end');

  const I = 0x69; // 'i'
  const L = 0x6c; // 'l'
  const D = 0x64; // 'd'
  const E = 0x65; // 'e'
  const COLON = 0x3a;

  if (byte === I) {
    const end = buf.indexOf(E, at + 1);
    if (end === -1) throw new Error('truncated torrent: unterminated integer');
    return end + 1;
  }

  if (byte === L || byte === D) {
    let cursor = at + 1;
    while (buf[cursor] !== E) {
      if (cursor >= buf.length) throw new Error('truncated torrent: unterminated container');
      cursor = spanEnd(buf, cursor);
    }
    return cursor + 1;
  }

  // A string: decimal length, a colon, then exactly that many bytes.
  const colon = buf.indexOf(COLON, at);
  if (colon === -1) throw new Error('truncated torrent: unterminated string length');
  const length = Number(buf.toString('ascii', at, colon));
  if (!Number.isInteger(length) || length < 0) {
    throw new Error(`not a torrent: bad string length at byte ${at}`);
  }
  return colon + 1 + length;
}

/**
 * The bytes of the `info` dictionary, exactly as they appear in the file.
 *
 * Exactly as they appear is the whole requirement: the info hash is a SHA-1
 * over the original bytes, so decoding the dictionary and re-encoding it would
 * produce a different hash the moment a client wrote its keys in an order or a
 * form we did not reproduce.
 */
export function infoSection(buf: Buffer): Buffer {
  if (buf[0] !== 0x64) throw new Error('not a torrent: the file does not start with a dictionary');

  let cursor = 1;
  while (cursor < buf.length && buf[cursor] !== 0x65) {
    const keyEnd = spanEnd(buf, cursor);
    const colon = buf.indexOf(0x3a, cursor);
    const key = buf.toString('utf8', colon + 1, keyEnd);
    const valueEnd = spanEnd(buf, keyEnd);
    if (key === 'info') return buf.subarray(keyEnd, valueEnd);
    cursor = valueEnd;
  }
  throw new Error('not a torrent: no info dictionary');
}

/** The info hash of a .torrent file's bytes, lowercase hex. */
export function infoHash(buf: Buffer): string {
  return createHash('sha1').update(infoSection(buf)).digest('hex');
}

/** The `name` a torrent gives itself, for the magnet's display name. */
export function torrentName(buf: Buffer): string | null {
  const info = infoSection(buf);
  let cursor = 1;
  while (cursor < info.length && info[cursor] !== 0x65) {
    const keyEnd = spanEnd(info, cursor);
    const colon = info.indexOf(0x3a, cursor);
    const key = info.toString('utf8', colon + 1, keyEnd);
    const valueEnd = spanEnd(info, keyEnd);
    if (key === 'name') {
      const valueColon = info.indexOf(0x3a, keyEnd);
      return info.toString('utf8', valueColon + 1, valueEnd);
    }
    cursor = valueEnd;
  }
  return null;
}

/** A magnet URI. Trackers are `tr` parameters, in the order given. */
export function magnetUri({
  hash,
  name,
  trackers = [],
}: {
  hash: string;
  name?: string | null;
  trackers?: readonly string[];
}): string {
  if (!/^[0-9a-f]{40}$/i.test(hash)) throw new Error(`not an info hash: ${hash}`);
  const parts = [`magnet:?xt=urn:btih:${hash.toLowerCase()}`];
  if (name) parts.push(`dn=${encodeURIComponent(name)}`);
  for (const tracker of trackers) parts.push(`tr=${encodeURIComponent(tracker)}`);
  return parts.join('&');
}

/** Everything a magnet needs, read straight out of a .torrent file. */
export function magnetFor(buf: Buffer, trackers: readonly string[] = DEFAULT_TRACKERS): string {
  return magnetUri({ hash: infoHash(buf), name: torrentName(buf), trackers });
}

/** The body torlnk's `serve` API takes on POST /add. */
export function addBody(magnet: string): string {
  return JSON.stringify({ magnet });
}

/** Where torlnk's serve API listens unless told otherwise. */
export const DEFAULT_TORLINK_API = 'http://127.0.0.1:9161';
