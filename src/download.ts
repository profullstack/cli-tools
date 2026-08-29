/**
 * Pulling media off the web, through yt-dlp.
 *
 * yt-dlp is a system binary like ffmpeg and ImageMagick: it is on the box or it
 * is not, and there is no npm fallback that speaks a thousand site extractors.
 * So this module is argv construction and output parsing -- everything that can
 * be reasoned about without a network or a download -- and bin/dl.ts is the
 * part that spawns.
 *
 * Two things here are decisions rather than plumbing, and both are about not
 * surprising the person who pasted a URL:
 *
 *   playlists   yt-dlp downloads the WHOLE list when the URL carries `list=`,
 *               and a YouTube link copied from the browser while a mix is
 *               playing carries one. That is the difference between one file
 *               and two hundred, so the default here is --no-playlist and the
 *               whole list is something you ask for.
 *   containers  a single progressive stream tops out well below what YouTube
 *               actually has, so the good formats arrive as separate video and
 *               audio that ffmpeg has to mux. That makes ffmpeg a requirement
 *               for anything but the smallest download, which is worth saying
 *               up front rather than at 98%.
 */

export type DownloadKind = 'video' | 'audio';

export interface DownloadRequest {
  url: string;
  kind: DownloadKind;
  /** Cap the video height, e.g. 720. Undefined takes the best available. */
  height?: number;
  /** Container for `dl audio`. */
  audioFormat?: string;
  /** Directory to write into. */
  dir?: string;
  /** yt-dlp output template, if the default naming is not what is wanted. */
  template?: string;
  /** Take the whole playlist rather than the one entry the URL points at. */
  playlist?: boolean;
  /**
   * Is ffmpeg available to mux separate video and audio streams?
   *
   * False restricts the request to what can be written without it. Not a
   * preference: yt-dlp downloads both halves and then fails at the merge, so a
   * box without ffmpeg spends the whole transfer to produce nothing.
   */
  canMerge?: boolean;
}

/** The default filename template: yt-dlp's own, stated rather than assumed. */
export const DEFAULT_TEMPLATE = '%(title)s [%(id)s].%(ext)s';

/**
 * A yt-dlp format selector for a height cap.
 *
 * The three alternatives matter. `bv*+ba` is separate video and audio, which is
 * where the good formats live; `b[height<=N]` is a single progressive stream,
 * for sites that only serve one; and a bare `b` is the last resort, because a
 * site with no height metadata at all matches neither of the first two and
 * failing there would read as "this video does not exist".
 */
export function formatSelector(height?: number, canMerge = true): string {
  const cap = height === undefined ? '' : `[height<=${height}]`;
  // Without ffmpeg the `bv*+ba` alternatives are traps: yt-dlp picks them,
  // downloads both halves, and only then discovers it cannot mux.
  if (!canMerge) return cap ? `b${cap}/b` : 'b';
  if (!cap) return 'bv*+ba/b';
  return `bv*${cap}+ba/b${cap}/bv*+ba/b`;
}

/** The argv for a download. */
export function downloadArgs(request: DownloadRequest): string[] {
  const args: string[] = ['--no-warnings'];

  // Ask for one thing unless told otherwise. See the playlist note above.
  args.push(request.playlist ? '--yes-playlist' : '--no-playlist');

  if (request.kind === 'audio') {
    args.push('-x', '--audio-format', request.audioFormat ?? 'm4a');
    // Height is meaningless once the video track is thrown away, and passing a
    // video selector alongside -x makes yt-dlp fetch a stream it then discards.
  } else {
    const canMerge = request.canMerge !== false;
    args.push('-f', formatSelector(request.height, canMerge));
    // Nothing to ask for when there will be no merge, and passing it anyway
    // makes yt-dlp remux a file that arrived whole.
    if (canMerge) args.push('--merge-output-format', 'mp4');
  }

  args.push('-o', request.template ?? DEFAULT_TEMPLATE);
  if (request.dir) args.push('-P', request.dir);

  // Four fragments at once is most of the speed available on a segmented
  // stream, and enough of them to saturate a home line without looking like a
  // scraper to the far end.
  args.push('-N', '4');

  args.push('--', request.url);
  return args;
}

/** The argv for `dl info` -- one JSON object per line, nothing downloaded. */
export function infoArgs(url: string, { playlist = false } = {}): string[] {
  return [
    '--no-warnings',
    playlist ? '--yes-playlist' : '--no-playlist',
    // -J on a playlist buffers the entire thing before printing; -j streams one
    // object per entry, which is also the shape a single video comes back in.
    '-j',
    ...(playlist ? ['--flat-playlist'] : []),
    '--',
    url,
  ];
}

/** The argv for `dl formats`. */
export function formatsArgs(url: string): string[] {
  return ['--no-warnings', '--no-playlist', '-F', '--', url];
}

export interface MediaInfo {
  title: string;
  uploader: string;
  duration: number;
  extractor: string;
  url: string;
}

/**
 * What yt-dlp said about a URL, from its `-j` output.
 *
 * Written against the fields rather than a schema because extractors disagree
 * about which of them exist: `uploader` is `channel` on some, absent on others,
 * and `duration` is null for a livestream. Every field falls back to something
 * printable, because a missing uploader is not a reason to fail a lookup.
 */
export function parseInfo(line: string): MediaInfo | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;

  const str = (...keys: string[]): string => {
    for (const key of keys) {
      const value = raw[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  };

  const duration = raw.duration;
  return {
    title: str('title', 'fulltitle', 'id') || '(untitled)',
    uploader: str('uploader', 'channel', 'creator', 'uploader_id') || '(unknown)',
    // A livestream has no duration; 0 is what humanDuration renders as 0:00,
    // which is honest -- there is no length to report yet.
    duration: typeof duration === 'number' && Number.isFinite(duration) ? duration : 0,
    extractor: str('extractor_key', 'extractor') || '?',
    url: str('webpage_url', 'original_url', 'url'),
  };
}

/** Every JSON object in a `-j` stream, skipping anything that is not one. */
export function parseInfoStream(stdout: string): MediaInfo[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseInfo)
    .filter((info): info is MediaInfo => info !== null);
}


/** The verbs `dl` takes before a URL. */
export const VERBS = ['audio', 'info', 'formats'] as const;
export type Verb = (typeof VERBS)[number];

/**
 * Which verb was asked for, and which URLs it was asked about.
 *
 * `dl <url>` is the common case and typing `dl video <url>` for it would be
 * noise, so the verb is optional and the default is a video download. That is
 * only unambiguous because a URL never collides with one of the three words --
 * every one of them has a scheme in front of it -- which is what this asserts
 * rather than assumes: a first argument that is neither a verb nor URL-shaped
 * is a typo worth naming, not a hostname to hand to yt-dlp.
 */
export function splitCommand(positional: readonly string[]): {
  verb: Verb | 'video';
  urls: string[];
} {
  const [first, ...rest] = positional;
  if (first !== undefined && (VERBS as readonly string[]).includes(first)) {
    return { verb: first as Verb, urls: rest };
  }
  return { verb: 'video', urls: [...positional] };
}

/** Does this read as something yt-dlp can be handed? */
export function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}
