import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEMPLATE,
  downloadArgs,
  formatSelector,
  formatsArgs,
  infoArgs,
  looksLikeUrl,
  parseInfo,
  parseInfoStream,
  splitCommand,
} from '../src/download.ts';

const URL = 'https://example.com/watch?v=abc';

describe('formatSelector', () => {
  it('prefers separate streams, then a progressive one', () => {
    expect(formatSelector()).toBe('bv*+ba/b');
    expect(formatSelector(720)).toBe('bv*[height<=720]+ba/b[height<=720]/bv*+ba/b');
  });

  /*
   * The alternative that keeps a capped request from failing outright.
   *
   * A site that reports no height metadata matches neither capped branch, and
   * without the uncapped tail yt-dlp answers "requested format not available"
   * -- which reads as "this video is gone" rather than "we asked for something
   * this extractor cannot describe".
   */
  it('still has an answer for a site with no height metadata', () => {
    expect(formatSelector(1080).endsWith('/bv*+ba/b')).toBe(true);
  });

  /*
   * Without ffmpeg, `bv*+ba` is not a lower-quality option -- it is a wasted
   * download. yt-dlp fetches both halves and only then finds it cannot mux, so
   * the whole transfer is spent to produce nothing.
   */
  it('offers nothing that needs muxing when ffmpeg is absent', () => {
    expect(formatSelector(720, false)).toBe('b[height<=720]/b');
    expect(formatSelector(undefined, false)).toBe('b');
    expect(formatSelector(720, false)).not.toContain('+');
  });
});

describe('downloadArgs', () => {
  /*
   * The default that matters most.
   *
   * A YouTube URL copied from the browser while a mix is playing carries
   * `list=`, and yt-dlp reads that as the whole list. That is the difference
   * between one file and two hundred, on a command whose whole input is a
   * pasted URL.
   */
  it('takes one entry unless the whole list was asked for', () => {
    expect(downloadArgs({ url: URL, kind: 'video' })).toContain('--no-playlist');
    expect(downloadArgs({ url: URL, kind: 'video', playlist: true })).toContain('--yes-playlist');
    expect(downloadArgs({ url: URL, kind: 'video', playlist: true })).not.toContain('--no-playlist');
  });

  it('passes the URL after -- so a leading dash is not read as a flag', () => {
    const args = downloadArgs({ url: URL, kind: 'video' });
    expect(args.slice(-2)).toEqual(['--', URL]);
  });

  it('names the output template rather than leaving it implicit', () => {
    expect(downloadArgs({ url: URL, kind: 'video' })).toContain(DEFAULT_TEMPLATE);
    expect(downloadArgs({ url: URL, kind: 'video', template: '%(id)s.%(ext)s' })).toContain(
      '%(id)s.%(ext)s',
    );
  });

  it('extracts audio into the container asked for', () => {
    expect(downloadArgs({ url: URL, kind: 'audio' })).toEqual(
      expect.arrayContaining(['-x', '--audio-format', 'm4a']),
    );
    expect(downloadArgs({ url: URL, kind: 'audio', audioFormat: 'mp3' })).toContain('mp3');
  });

  /*
   * A height cap on an audio-only download is a stream fetched and discarded:
   * -x throws the video track away, so selecting for it costs a download and
   * buys nothing.
   */
  it('does not select a video stream it is about to throw away', () => {
    const args = downloadArgs({ url: URL, kind: 'audio', height: 720 });
    expect(args).not.toContain('-f');
    expect(args.join(' ')).not.toContain('height<=');
  });

  it('only asks for a remux when there is something to merge', () => {
    expect(downloadArgs({ url: URL, kind: 'video' })).toContain('--merge-output-format');
    expect(downloadArgs({ url: URL, kind: 'video', canMerge: false })).not.toContain(
      '--merge-output-format',
    );
  });

  it('writes where it was told to', () => {
    expect(downloadArgs({ url: URL, kind: 'video', dir: '/tmp/out' })).toEqual(
      expect.arrayContaining(['-P', '/tmp/out']),
    );
  });
});

describe('infoArgs and formatsArgs', () => {
  /*
   * -j rather than -J: the capital streams one object per entry, while -J
   * buffers an entire playlist before printing anything.
   */
  it('asks for one JSON object per line', () => {
    expect(infoArgs(URL)).toContain('-j');
    expect(infoArgs(URL)).not.toContain('-J');
  });

  it('only flattens when it was asked for a playlist', () => {
    expect(infoArgs(URL)).not.toContain('--flat-playlist');
    expect(infoArgs(URL, { playlist: true })).toContain('--flat-playlist');
  });

  it('ends both with a guarded URL', () => {
    expect(infoArgs(URL).slice(-2)).toEqual(['--', URL]);
    expect(formatsArgs(URL).slice(-2)).toEqual(['--', URL]);
  });
});

describe('parseInfo', () => {
  it('reads the fields a person wants to see', () => {
    const info = parseInfo(
      JSON.stringify({
        title: 'A talk',
        uploader: 'Someone',
        duration: 3725,
        extractor_key: 'Youtube',
        webpage_url: URL,
      }),
    );
    expect(info).toEqual({
      title: 'A talk',
      uploader: 'Someone',
      duration: 3725,
      extractor: 'Youtube',
      url: URL,
    });
  });

  /*
   * Extractors disagree about which fields exist -- `uploader` is `channel` on
   * some and absent on others -- and a missing uploader is not a reason to fail
   * a lookup that got the title right.
   */
  it('falls back through the names different extractors use', () => {
    const info = parseInfo(JSON.stringify({ title: 'X', channel: 'C', extractor: 'generic' }));
    expect(info?.uploader).toBe('C');
    expect(info?.extractor).toBe('generic');
  });

  /* A livestream has null duration; 0 renders as 0:00, which is honest. */
  it('does not invent a duration for a livestream', () => {
    expect(parseInfo(JSON.stringify({ title: 'Live', duration: null }))?.duration).toBe(0);
  });

  it('returns null rather than throwing on a line that is not JSON', () => {
    expect(parseInfo('WARNING: something')).toBeNull();
    expect(parseInfo('')).toBeNull();
  });

  it('skips the noise in a stream rather than losing the stream', () => {
    const stdout = ['not json', JSON.stringify({ title: 'One' }), '', 'also not'].join('\n');
    expect(parseInfoStream(stdout).map((i) => i.title)).toEqual(['One']);
  });
});

describe('splitCommand', () => {
  it('treats a bare URL as a video download', () => {
    expect(splitCommand([URL])).toEqual({ verb: 'video', urls: [URL] });
  });

  it('reads the verbs it knows', () => {
    expect(splitCommand(['audio', URL])).toEqual({ verb: 'audio', urls: [URL] });
    expect(splitCommand(['info', URL, URL])).toEqual({ verb: 'info', urls: [URL, URL] });
  });

  /*
   * The check that makes an optional verb safe: a first argument that is
   * neither a verb nor URL-shaped is a typo worth naming, not a hostname to
   * hand to yt-dlp -- which would go and look it up.
   */
  it('leaves a mistyped verb visible instead of downloading it', () => {
    const { verb, urls } = splitCommand(['audi0', URL]);
    expect(verb).toBe('video');
    expect(urls[0]).toBe('audi0');
    expect(looksLikeUrl('audi0')).toBe(false);
  });

  it('knows a URL when it sees one', () => {
    expect(looksLikeUrl('https://x.test/a')).toBe(true);
    expect(looksLikeUrl('HTTP://x.test/a')).toBe(true);
    expect(looksLikeUrl('x.test/a')).toBe(false);
    expect(looksLikeUrl('file:///etc/passwd')).toBe(false);
  });
});
