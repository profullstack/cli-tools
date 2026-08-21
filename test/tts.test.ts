import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_FORMAT,
  DEFAULT_MODEL,
  type Voice,
  VoiceError,
  buildBody,
  describeError,
  elevenLabsClient,
  extensionFor,
  formatVoices,
  looksLikeVoiceId,
  outputPathFor,
  parseFraction,
  parseVoices,
  resolveVoice,
  speechUrl,
} from '../src/tts.ts';

const VOICES: Voice[] = [
  { id: 'SAz9YHcvj6GT2YYXdXww', name: 'River - Relaxed, Neutral', shortName: 'River', category: 'premade' },
  { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George - Warm Storyteller', shortName: 'George', category: 'premade' },
  { id: 'pqHfZKP75CvOlQylNhV4', name: 'Bill - Wise, Mature', shortName: 'Bill', category: 'premade' },
  { id: 'bIHbv24MWmeRgasZH58o', name: 'Will - Relaxed Optimist', shortName: 'Will', category: 'premade' },
];

describe('parseVoices', () => {
  // The account's names carry a description after " - " that nobody is going
  // to type, so the part in front of it is what a name has to match.
  it('splits the human part off the label', () => {
    const voices = parseVoices(
      JSON.stringify({ voices: [{ voice_id: 'x', name: 'River - Relaxed, Neutral' }] }),
    );
    expect(voices[0]).toMatchObject({ id: 'x', shortName: 'River' });
  });

  it('drops entries with no id rather than emitting an unusable voice', () => {
    expect(parseVoices(JSON.stringify({ voices: [{ name: 'Nobody' }] }))).toEqual([]);
  });
});

describe('resolveVoice', () => {
  it('takes an ID unchanged', () => {
    expect(resolveVoice([], 'SAz9YHcvj6GT2YYXdXww')).toBe('SAz9YHcvj6GT2YYXdXww');
  });

  it('matches a short name, ignoring case', () => {
    expect(resolveVoice(VOICES, 'george')).toBe('JBFqnCBsd6RMkjVDRZzb');
  });

  it('matches the full label too', () => {
    expect(resolveVoice(VOICES, 'River - Relaxed, Neutral')).toBe('SAz9YHcvj6GT2YYXdXww');
  });

  // "Bill" is also a prefix of nothing else, but "Wil" hits both Will and
  // nothing named Wilma — an arbitrary pick would change narrator the day the
  // account gains a voice, with nothing on screen to explain it.
  it('refuses an ambiguous prefix and names the candidates', () => {
    const voices = [...VOICES, { id: 'z', name: 'Willow - Bright', shortName: 'Willow', category: null }];
    expect(() => resolveVoice(voices, 'wil')).toThrow(/matches 2 voices: Will, Willow/);
  });

  it('prefers an exact name over a longer one it prefixes', () => {
    const voices = [...VOICES, { id: 'z', name: 'Willow - Bright', shortName: 'Willow', category: null }];
    expect(resolveVoice(voices, 'will')).toBe('bIHbv24MWmeRgasZH58o');
  });

  it('says how to list them when nothing matches', () => {
    expect(() => resolveVoice(VOICES, 'nobody')).toThrow(VoiceError);
    expect(() => resolveVoice(VOICES, 'nobody')).toThrow(/tts --voices/);
  });
});

describe('looksLikeVoiceId', () => {
  it('is 20 characters of base62', () => {
    expect(looksLikeVoiceId('SAz9YHcvj6GT2YYXdXww')).toBe(true);
    expect(looksLikeVoiceId('River')).toBe(false);
    expect(looksLikeVoiceId('SAz9YHcvj6GT2YYXdXw-')).toBe(false);
  });
});

describe('buildBody', () => {
  it('sends the text and the default model', () => {
    const body = JSON.parse(buildBody('hello'));
    expect(body).toEqual({ text: 'hello', model_id: DEFAULT_MODEL });
  });

  // Sending our own numbers would override whatever the voice was tuned with
  // in the dashboard, on an account other people share.
  it('omits voice_settings entirely when nothing was asked for', () => {
    expect(JSON.parse(buildBody('hello'))).not.toHaveProperty('voice_settings');
    expect(JSON.parse(buildBody('hello', { stability: 0.3 })).voice_settings).toEqual({
      stability: 0.3,
    });
  });
});

describe('parseFraction', () => {
  // Without the check this becomes NaN, JSON.stringify writes null, and the
  // API accepts the object while ignoring the setting.
  it('rejects anything outside 0-1', () => {
    expect(() => parseFraction('--stability', 'high')).toThrow(/between 0 and 1/);
    expect(() => parseFraction('--stability', '1.5')).toThrow(/between 0 and 1/);
    expect(parseFraction('--stability', '0.4')).toBe(0.4);
    expect(parseFraction('--stability', '1')).toBe(1);
  });
});

describe('outputPathFor', () => {
  it('names the file after the text', () => {
    expect(outputPathFor('The deploy finished')).toBe('the-deploy-finished.mp3');
  });

  it('keeps it short and drops punctuation', () => {
    expect(outputPathFor('one two three four five six seven eight')).toBe(
      'one-two-three-four-five-six.mp3',
    );
  });

  it('still produces a name when the text has no letters', () => {
    expect(outputPathFor('!!! ???')).toBe('speech.mp3');
  });

  // A pcm request that wrote a .mp3 would produce a file nothing can play.
  it('follows the format', () => {
    expect(outputPathFor('hi', 'pcm_24000')).toBe('hi.pcm');
    expect(extensionFor('ulaw_8000')).toBe('ulaw');
  });
});

describe('speechUrl', () => {
  it('carries the output format', () => {
    expect(speechUrl('abc', DEFAULT_FORMAT)).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/abc?output_format=mp3_44100_128',
    );
  });
});

describe('describeError', () => {
  // quota_exceeded and invalid_api_key are both a 401 without the status.
  it('keeps the status alongside the message', () => {
    expect(describeError('{"detail":{"status":"quota_exceeded","message":"out of credits"}}')).toBe(
      'out of credits (quota_exceeded)',
    );
  });

  it('handles a plain string detail', () => {
    expect(describeError('{"detail":"nope"}')).toBe('nope');
  });
});

describe('formatVoices', () => {
  it('lines the columns up', () => {
    expect(formatVoices(VOICES.slice(0, 2))).toBe(
      'River   SAz9YHcvj6GT2YYXdXww  premade\nGeorge  JBFqnCBsd6RMkjVDRZzb  premade',
    );
  });
});

describe('elevenLabsClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the key as a header and returns the audio bytes', async () => {
    const fetchMock = vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
      void init;
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const audio = await elevenLabsClient('secret', 1000).speak('abc', 'hi');
    expect(audio).toEqual(new Uint8Array([1, 2, 3]));
    expect(fetchMock.mock.calls[0]![1]!.headers['xi-api-key']).toBe('secret');
  });

  it('surfaces the API message on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        text: async () => '{"detail":{"status":"invalid_api_key","message":"bad key"}}',
      })),
    );
    await expect(elevenLabsClient('k', 1000).speak('abc', 'hi')).rejects.toThrow(
      'elevenlabs 401: bad key (invalid_api_key)',
    );
  });
});
