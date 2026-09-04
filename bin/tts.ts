#!/usr/bin/env node
/**
 * tts — read text aloud with ElevenLabs and keep the audio.
 *
 *   tts "the deploy finished"
 *   blog-post list | tts --voice George --out digest.mp3
 *   tts --voices
 *
 * The path of what it wrote goes to stdout, so it composes:
 *
 *   mpv "$(tts 'build is green')"
 */

import { writeFileSync } from 'node:fs';

import { UsageError, integer, parseArgs } from '../src/args.ts';
import { resolveCredentials } from '../src/credentials.ts';
import { isMain } from '../src/is-main.ts';
import {
  DEFAULT_FORMAT,
  DEFAULT_MODEL,
  DEFAULT_VOICE,
  FORMATS,
  type Format,
  type SpeakOptions,
  VoiceError,
  elevenLabsClient,
  formatVoices,
  outputPathFor,
  parseFraction,
  resolveVoice,
} from '../src/tts.ts';

const USAGE = `Usage:
  tts "<text>"
  tts --voices
  cat post.md | tts --voice George --out post.mp3

Synthesises speech and writes an audio file, printing its path to stdout.

Options:
      --voice V       voice ID, full name, or just the first word
                      (default: ${DEFAULT_VOICE})
      --voices        list the account's voices and exit
  -o, --out PATH      where to write; "-" streams the audio to stdout
      --model M       (default: ${DEFAULT_MODEL}; --model eleven_v3 for the newest)
      --format F      ${FORMATS.join(' | ')}
                      (default: ${DEFAULT_FORMAT})
      --stability N   0-1, higher is flatter and more consistent
      --similarity N  0-1, how closely to imitate the original voice
      --style N       0-1, above 0 the delivery gets theatrical and slower
      --timeout MS    API timeout (default: 120000)
  -h, --help          show this help

Text comes from the arguments, or from stdin when there are none.

Needs an ElevenLabs key. Store one once:

  cli-tools config set elevenlabs      # prompts, nothing echoed or logged
  cli-tools config                     # what is set, and where it came from

kept 0600 in ~/.config/cli-tools/credentials.json. ELEVENLABS_API_KEY still
works and takes precedence over a stored key.

Synthesis spends characters from the account quota. Nothing here retries, so a
failed call costs nothing twice.
`;

/** Read all of stdin. Used when the text is piped rather than quoted. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

if (isMain(import.meta.url)) {
  try {
    const { flags, values, positional } = parseArgs(process.argv.slice(2), {
      boolean: ['-h', '--help', '--voices'],
      string: [
        '--voice', '-o', '--out', '--model', '--format',
        '--stability', '--similarity', '--style', '--timeout',
      ],
    });

    if (flags.has('-h') || flags.has('--help')) {
      process.stdout.write(USAGE);
      process.exit(0);
    }

    const format = values.get('--format') ?? DEFAULT_FORMAT;
    if (!FORMATS.includes(format as Format)) {
      throw new UsageError(`unknown --format: ${format} (expected ${FORMATS.join(', ')})`);
    }

    const timeout = integer(values, '--timeout', 120_000, { min: 1000, max: 600_000 });

    // Stored keys first, environment on top — see src/credentials.ts.
    const credentials = resolveCredentials(process.env);
    const apiKey = credentials['ELEVENLABS_API_KEY'];
    if (!apiKey) {
      throw new UsageError(
        'no ElevenLabs key — run `cli-tools config set elevenlabs`, ' +
          'or export ELEVENLABS_API_KEY',
      );
    }

    const client = elevenLabsClient(apiKey, timeout, format);

    if (flags.has('--voices')) {
      const voices = await client.listVoices();
      process.stdout.write(`${formatVoices(voices)}\n`);
      process.stderr.write(`${voices.length} voices\n`);
      process.exit(0);
    }

    const text = (positional.length > 0 ? positional.join(' ') : await readStdin()).trim();
    if (!text) {
      process.stdout.write(USAGE);
      process.exit(1);
    }

    // Only fetch the voice list when the name needs looking up. A voice given
    // as an ID goes straight through, which keeps `--voice <id>` working on a
    // key whose plan cannot list voices.
    const wanted = values.get('--voice') ?? DEFAULT_VOICE;
    const voiceId = /^[A-Za-z0-9]{20}$/.test(wanted)
      ? wanted
      : resolveVoice(await client.listVoices(), wanted);

    const options: SpeakOptions = { model: values.get('--model') ?? DEFAULT_MODEL };
    for (const [flag, key] of [
      ['--stability', 'stability'],
      ['--similarity', 'similarity'],
      ['--style', 'style'],
    ] as const) {
      const raw = values.get(flag);
      if (raw !== undefined) options[key] = parseFraction(flag, raw);
    }

    const audio = await client.speak(voiceId, text, options);

    const out = values.get('-o') ?? values.get('--out');
    if (out === '-') {
      // The audio itself is the output here, so nothing else may touch stdout.
      process.stdout.write(audio);
      process.stderr.write(`${audio.length} bytes · ${options.model} · ${voiceId}\n`);
    } else {
      const path = out ?? outputPathFor(text, format);
      writeFileSync(path, audio);
      process.stdout.write(`${path}\n`);
      process.stderr.write(`${audio.length} bytes · ${options.model} · ${voiceId}\n`);
    }
  } catch (error) {
    if (error instanceof UsageError || error instanceof VoiceError) {
      process.stderr.write(`tts: ${error.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`tts: ${error instanceof Error ? error.message : error}\n`);
    process.exit(2);
  }
}
