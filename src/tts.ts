/**
 * Turn text into speech with ElevenLabs.
 *
 * The API is one POST returning audio bytes, so the interesting code here is
 * not the request — it is naming a voice. The account's voices are called
 * things like "River - Relaxed, Neutral, Informative", which nobody is going to
 * type, and the IDs are opaque 20-character strings that say nothing about who
 * they are. So a voice may be given as an ID, a full name, or just the human
 * part of it, and an ambiguous name is an error listing the candidates rather
 * than a silent pick of the first match.
 */

/**
 * Multilingual v2 rather than v3.
 *
 * v3 is the better model and is worth asking for by name, but it is also the
 * one with the sharp edges — it wants a longer passage to sound right and is
 * priced accordingly. A default that costs more and sounds worse on a
 * one-sentence test is the wrong default; `--model eleven_v3` is one flag.
 */
export const DEFAULT_MODEL = 'eleven_multilingual_v2';

/** A neutral narrator that ships with every account. */
export const DEFAULT_VOICE = 'River';

/**
 * MP3 at 128kbps: the only format every plan can request, and the one anything
 * will play. The rest are here so `--format` can be validated rather than
 * passed through to a 422.
 */
export const DEFAULT_FORMAT = 'mp3_44100_128';

export const FORMATS = [
  'mp3_44100_128',
  'mp3_44100_64',
  'mp3_22050_32',
  'pcm_16000',
  'pcm_22050',
  'pcm_24000',
  'ulaw_8000',
] as const;

export type Format = (typeof FORMATS)[number];

export interface Voice {
  id: string;
  /** The full label, suffix and all. */
  name: string;
  /** The part before the first " - ", which is what people call it. */
  shortName: string;
  category: string | null;
}

const BASE = 'https://api.elevenlabs.io/v1';

export function speechUrl(voiceId: string, format: string = DEFAULT_FORMAT): string {
  return `${BASE}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(format)}`;
}

export function voicesUrl(): string {
  return `${BASE}/voices`;
}

export interface SpeakOptions {
  model?: string;
  /** 0–1. Higher is more consistent and flatter; the API's own default is 0.5. */
  stability?: number;
  /** 0–1. How closely to imitate the original voice. */
  similarity?: number;
  /** 0–1. Above 0 the delivery gets theatrical, and slower. */
  style?: number;
}

/**
 * The request body.
 *
 * `voice_settings` is omitted entirely unless something was asked for. Sending
 * a full settings object with our own numbers in it would override whatever the
 * voice was tuned with in the dashboard, which is a surprising thing for a CLI
 * to do to a shared account.
 */
export function buildBody(text: string, options: SpeakOptions = {}): string {
  const body: Record<string, unknown> = {
    text,
    model_id: options.model ?? DEFAULT_MODEL,
  };

  const settings: Record<string, number> = {};
  if (options.stability !== undefined) settings['stability'] = options.stability;
  if (options.similarity !== undefined) settings['similarity_boost'] = options.similarity;
  if (options.style !== undefined) settings['style'] = options.style;
  if (Object.keys(settings).length > 0) body['voice_settings'] = settings;

  return JSON.stringify(body);
}

export function parseVoices(raw: string): Voice[] {
  let parsed: { voices?: { voice_id?: string; name?: string; category?: string }[] };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch (error) {
    throw new Error(`elevenlabs returned non-JSON — ${(error as Error).message}`);
  }

  return (parsed.voices ?? [])
    .filter((voice): voice is { voice_id: string; name?: string; category?: string } =>
      Boolean(voice.voice_id),
    )
    .map((voice) => {
      const name = voice.name?.trim() ?? voice.voice_id;
      return {
        id: voice.voice_id,
        name,
        shortName: name.split(' - ')[0]!.trim(),
        category: voice.category ?? null,
      };
    });
}

/**
 * An ElevenLabs voice ID: 20 characters of base62, no separators.
 *
 * Checked by shape rather than by looking it up, so `--voice <id>` for a voice
 * that is not in this account still reaches the API and fails with the API's
 * own message, instead of us claiming it does not exist.
 */
export function looksLikeVoiceId(value: string): boolean {
  return /^[A-Za-z0-9]{20}$/.test(value);
}

export class VoiceError extends Error {}

/**
 * Resolve what somebody typed to a voice ID.
 *
 * Exact matches win over prefixes, and case never matters. A prefix that hits
 * more than one voice is an error naming all of them: picking one would be a
 * coin flip that produces a different narrator tomorrow when the account gains
 * a voice, with nothing on screen to explain why.
 */
export function resolveVoice(voices: readonly Voice[], wanted: string): string {
  const query = wanted.trim();
  if (looksLikeVoiceId(query)) return query;

  const folded = query.toLowerCase();
  const exact = voices.filter(
    (voice) => voice.shortName.toLowerCase() === folded || voice.name.toLowerCase() === folded,
  );
  if (exact.length === 1) return exact[0]!.id;
  if (exact.length > 1) throw ambiguous(query, exact);

  const prefixed = voices.filter((voice) => voice.shortName.toLowerCase().startsWith(folded));
  if (prefixed.length === 1) return prefixed[0]!.id;
  if (prefixed.length > 1) throw ambiguous(query, prefixed);

  throw new VoiceError(`no voice matching "${query}" — run \`tts --voices\` to list them`);
}

function ambiguous(query: string, matches: readonly Voice[]): VoiceError {
  const names = matches.map((voice) => voice.shortName).join(', ');
  return new VoiceError(`"${query}" matches ${matches.length} voices: ${names}`);
}

/** Extension for a format, so `--format pcm_24000` does not write a `.mp3`. */
export function extensionFor(format: string): string {
  if (format.startsWith('mp3')) return 'mp3';
  if (format.startsWith('pcm')) return 'pcm';
  if (format.startsWith('ulaw')) return 'ulaw';
  return 'audio';
}

/**
 * Where the audio goes when nobody said.
 *
 * Named from the text itself rather than from a timestamp: a directory of
 * `speech-1755794400.mp3` tells you nothing, and the whole point of a
 * throwaway synthesis is being able to see which one it was.
 */
export function outputPathFor(text: string, format: string = DEFAULT_FORMAT): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 6)
    .join('-');

  return `${slug || 'speech'}.${extensionFor(format)}`;
}

/**
 * Pull the useful sentence out of an error body.
 *
 * ElevenLabs nests it as `{detail: {status, message}}`, and the status is the
 * half that tells you what to do — `quota_exceeded` and `invalid_api_key` are
 * both a 401 otherwise.
 */
export function describeError(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      detail?: { status?: string; message?: string } | string;
    };
    if (typeof parsed.detail === 'string') return parsed.detail;
    if (parsed.detail?.message) {
      return parsed.detail.status
        ? `${parsed.detail.message} (${parsed.detail.status})`
        : parsed.detail.message;
    }
  } catch {
    // Not JSON — pass it through below.
  }
  return body.trim().slice(0, 400);
}

/**
 * A 0–1 knob from the command line.
 *
 * `integer()` in src/args.ts cannot express these, and the failure without a
 * check is quiet: `--stability high` becomes NaN, JSON.stringify turns NaN into
 * `null`, and the API accepts the object while ignoring the setting.
 */
export function parseFraction(name: string, raw: string): number {
  if (!/^(0|1|0?\.\d+|1\.0+)$/.test(raw.trim())) {
    throw new VoiceError(`${name} must be between 0 and 1, got ${JSON.stringify(raw)}`);
  }
  return Number(raw);
}

export interface Client {
  listVoices(): Promise<Voice[]>;
  speak(voiceId: string, text: string, options?: SpeakOptions): Promise<Uint8Array>;
}

/** The real client. Plain fetch; this repo has no runtime dependencies. */
export function elevenLabsClient(
  apiKey: string,
  timeoutMs: number,
  format: string = DEFAULT_FORMAT,
): Client {
  const request = async (url: string, init: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: { ...init.headers, 'xi-api-key': apiKey },
      });
      if (!response.ok) {
        throw new Error(`elevenlabs ${response.status}: ${describeError(await response.text())}`);
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async listVoices() {
      return parseVoices(await (await request(voicesUrl(), { method: 'GET' })).text());
    },
    async speak(voiceId, text, options) {
      const response = await request(speechUrl(voiceId, format), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: buildBody(text, options),
      });
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

/** One line per voice, for `--voices`. */
export function formatVoices(voices: readonly Voice[]): string {
  const width = Math.max(0, ...voices.map((voice) => voice.shortName.length));
  return voices
    .map((voice) => `${voice.shortName.padEnd(width)}  ${voice.id}  ${voice.category ?? ''}`.trimEnd())
    .join('\n');
}
