#!/usr/bin/env -S npx --yes tsx
/**
 * torrent -- turn a directory into a torrent, and get it seeded.
 *
 * Two programs do the work, in the same way `dl` leans on yt-dlp and `vid` on
 * ffmpeg: `create-torrent` writes the .torrent, and torlnk seeds it. What this
 * adds is the part neither of them does -- handing you the magnet.
 *
 * `create-torrent` writes a file and never prints a hash, and torlnk takes a
 * magnet rather than a file, so the two do not actually meet without something
 * in between. src/torrent.ts is that something.
 */

import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { UsageError, csv, parseArgs } from '../src/args.ts';
import { isMain } from '../src/is-main.ts';
import { MissingEngineError, findBinary, humanBytes } from '../src/media.ts';
import {
  DEFAULT_TORLINK_API,
  DEFAULT_TRACKERS,
  addBody,
  createArgs,
  infoHash,
  magnetFor,
  torrentName,
} from '../src/torrent.ts';

const USAGE = `Usage:
  torrent create <path> [-o OUT.torrent]   make a torrent, print its magnet
  torrent seed <path>                      make it, then hand it to torlnk
  torrent magnet <file.torrent>            the magnet for a torrent you have
  torrent info <file.torrent>              what is inside one

Options:
  -o, --out PATH       where to write the .torrent (default: <name>.torrent)
      --tracker URLS   comma-separated announce list, replacing the default
      --name NAME      torrent name, if not the directory's own
      --comment TEXT   a comment to embed
      --private        exclude it from the DHT (opt-in; the opposite of sharing)
      --api URL        torlnk's serve API (default: ${DEFAULT_TORLINK_API})
      --watch DIR      a torlnk watch directory, instead of its API
      --json           machine-readable output
      --help           show this help

Trackers matter more than they look. A browser can only be a peer over WebRTC,
so a torrent with no wss:// tracker is invisible to every web player -- it is on
the DHT, desktop clients find it, and the browser sees a torrent with no peers.
The default list carries both kinds, and every entry in it was checked rather
than copied: the announce list the WebTorrent tooling ships by default still
names three trackers that are dead and one with a self-signed certificate.

Needs \`create-torrent\` on PATH (npm i -g create-torrent). \`seed\` also needs
torlnk running -- either its serve API, or a watch directory.
`;

/** Run a child with our stdio, and resolve its exit code. */
function passthrough(file: string, args: string[]): Promise<number> {
  return new Promise((done) => {
    const child = spawn(file, args, { stdio: 'inherit' });
    child.on('error', () => done(127));
    child.on('close', (code) => done(code ?? 1));
  });
}

if (isMain(import.meta.url)) {
  try {
    const { flags, values, positional } = parseArgs(process.argv.slice(2), {
      boolean: ['--help', '--private', '--json'],
      string: ['-o', '--out', '--tracker', '--name', '--comment', '--api', '--watch'],
    });

    if (flags.has('--help') || positional.length === 0) {
      process.stdout.write(USAGE);
      process.exit(positional.length === 0 ? 1 : 0);
    }

    const [command, target] = positional;
    if (!target) throw new UsageError(`${command} needs a path`);

    const trackers = values.has('--tracker') ? csv(values, '--tracker') : DEFAULT_TRACKERS;
    if (trackers.length === 0) throw new UsageError('--tracker was given no URLs');

    // Reading an existing torrent needs nothing installed at all.
    if (command === 'magnet' || command === 'info') {
      const buf = await readFile(target);
      if (command === 'magnet') {
        process.stdout.write(`${magnetFor(buf, trackers)}\n`);
        process.exit(0);
      }
      const out = {
        name: torrentName(buf),
        infoHash: infoHash(buf),
        size: humanBytes(buf.length),
        magnet: magnetFor(buf, trackers),
      };
      process.stdout.write(
        flags.has('--json')
          ? `${JSON.stringify(out, null, 2)}\n`
          : `${out.name}\n${out.infoHash}\n${out.magnet}\n`,
      );
      process.exit(0);
    }

    if (command !== 'create' && command !== 'seed') {
      throw new UsageError(`unknown command "${command}"`);
    }

    const creator = await findBinary(['create-torrent'], '--help');
    if (!creator) {
      throw new MissingEngineError(
        'create-torrent is not on PATH. Install it (npm i -g create-torrent).',
      );
    }

    const out = resolve(
      values.get('-o') ?? values.get('--out') ?? `${values.get('--name') ?? basename(resolve(target))}.torrent`,
    );

    const code = await passthrough(
      creator,
      createArgs(target, {
        out,
        trackers,
        ...(values.has('--name') ? { name: values.get('--name') as string } : {}),
        ...(values.has('--comment') ? { comment: values.get('--comment') as string } : {}),
        isPrivate: flags.has('--private'),
      }),
    );
    if (code !== 0) throw new Error(`create-torrent exited ${code}`);

    const buf = await readFile(out);
    const magnet = magnetFor(buf, trackers);
    const hash = infoHash(buf);

    if (command === 'create') {
      process.stdout.write(
        flags.has('--json')
          ? `${JSON.stringify({ torrent: out, infoHash: hash, magnet }, null, 2)}\n`
          : `${out}\n${magnet}\n`,
      );
      process.exit(0);
    }

    // seed: hand the magnet to torlnk, which is the thing that stays running.
    //
    // A watch directory is the offline handoff -- drop the file, torlnk picks it
    // up whenever it next looks -- and the API is the online one. The API is
    // tried first when either is available, because it answers.
    const watch = values.get('--watch') ?? process.env.TORLINK_WATCH;
    const api = values.get('--api') ?? process.env.TORLINK_API ?? (watch ? null : DEFAULT_TORLINK_API);

    if (api) {
      const res = await fetch(`${api.replace(/\/$/, '')}/add`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // torlnk requires a token only when it is bound to a public address;
          // sending one it did not ask for is harmless, so this is set-and-forget.
          ...(process.env.TORLINK_API_TOKEN
            ? { authorization: `Bearer ${process.env.TORLINK_API_TOKEN}` }
            : {}),
        },
        body: addBody(magnet),
      }).catch((err: Error) => {
        throw new MissingEngineError(
          `torlnk's API did not answer at ${api} (${err.message}). Start it with \`torlnk serve --daemon\`, or pass --watch <dir>.`,
        );
      });
      if (!res.ok) throw new Error(`torlnk answered ${res.status} ${res.statusText}`);
      process.stdout.write(`${out}\n${magnet}\nqueued with torlnk at ${api}\n`);
      process.exit(0);
    }

    // A .magnet file is what torlnk's watch mode reads; the .torrent would work
    // too, but the magnet carries the tracker list we just chose.
    const dropped = join(resolve(watch as string), `${basename(out, '.torrent')}.magnet`);
    await writeFile(dropped, `${magnet}\n`, 'utf8');
    process.stdout.write(`${out}\n${magnet}\ndropped for torlnk at ${dropped}\n`);
    process.exit(0);
  } catch (err) {
    if (err instanceof MissingEngineError) {
      process.stderr.write(`torrent: ${err.message}\n`);
      process.exit(2);
    }
    if (err instanceof UsageError) {
      process.stderr.write(`torrent: ${err.message}\n\n${USAGE}`);
      process.exit(1);
    }
    process.stderr.write(`torrent: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
