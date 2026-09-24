/**
 * The set, exported the way each network takes it.
 *
 * Networks with custom emoji get emoji; networks without them (Signal,
 * WhatsApp) get sticker packs; Telegram gets both. Each export is sized,
 * encoded and named to that network's rules, split into packs where the
 * network caps a pack, and archived in the shape its bulk importer reads
 * when it has one (Mastodon's tootctl tarball, Misskey's meta.json zip,
 * Pleroma's pack.json, WhatsApp's .wastickers).
 *
 * The same table is written out as platforms.json, which is what the
 * catalog's "by network" filter and install steps read, so the site and the
 * files never disagree about what is in a bundle or how to install it.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';

import type { Manifest } from './emoji.ts';
import { runCommand } from './emoji.ts';

type Emoji = Manifest['emoji'][number];

export type Subset = 'all' | 'default-tone' | 'essentials' | 'flags';

export interface Platform {
  id: string;
  name: string;
  /** emoji: custom emoji; stickers: sticker packs; media: no upload at all, images to post. */
  kind: 'emoji' | 'stickers' | 'media';
  /** What the catalog opens on for this network: the subgroups worth showing first. */
  highlight?: { subgroups: string[]; why: string };
  /** Square edge in pixels. */
  size: number;
  format: 'png' | 'webp';
  /** Per-file ceiling; files are re-encoded smaller until they fit. */
  maxBytes: number;
  /** Shortcode rules; stickers have no names. */
  name_rule?: { max: number; pattern: string; prefix: string };
  /** Most emoji or stickers one pack (server, set, upload) can hold. */
  packSize?: number;
  /** Uses another network's packs instead of building its own (same files, different steps). */
  packsFrom?: string;
  subsets: Subset[];
  archive: 'zip' | 'tar.gz' | 'wastickers';
  /** Install steps, in order. Plain sentences; the catalog renders them. */
  steps: string[];
  limits: string;
  docs: string[];
}

const SHORT = { max: 32, pattern: '^[a-z0-9_]+$', prefix: 'oe_' };
const LONG = { max: 100, pattern: '^[a-z0-9_]+$', prefix: 'oe_' };

/**
 * One row per network. Limits are the documented ones (see `docs`); where a
 * network documents none, the smaller of the common values is used.
 */
export const PLATFORMS: Platform[] = [
  {
    id: 'slack',
    name: 'Slack',
    kind: 'emoji',
    size: 128,
    format: 'png',
    maxBytes: 128 * 1024,
    name_rule: LONG,
    subsets: ['essentials', 'all'],
    archive: 'zip',
    limits: 'JPG, PNG or GIF under 128 KB, square works best; names lowercase. Any member except guests can add them, unless an owner restricts it.',
    steps: [
      'Click the smiley in any message box, then Add Emoji.',
      'Upload a file from the unzipped pack and use its file name (without .png) as the name.',
      'Slack has no bulk upload in the app; Enterprise workspaces can script it with admin.emoji.add. Start with the Essentials pack.',
      'Type :oe_ and pick from the list.',
    ],
    docs: ['https://slack.com/help/articles/206870177', 'https://docs.slack.dev/reference/methods/admin.emoji.add'],
  },
  {
    id: 'discord',
    name: 'Discord',
    kind: 'emoji',
    size: 128,
    format: 'png',
    maxBytes: 256 * 1024,
    name_rule: SHORT,
    packSize: 50,
    subsets: ['essentials', 'all'],
    archive: 'zip',
    limits: 'PNG, JPEG, GIF, WebP or AVIF under 256 KB, 128x128 recommended. 50 static emoji per server, 100/150/250 at boost levels 1/2/3. Names: 2+ letters, digits, _.',
    steps: [
      'Open Server Settings, then Emoji (you need the Create Expressions permission).',
      'Click Upload Emoji and select the files from one unzipped pack; Discord names each emoji after its file.',
      'A server starts with 50 static slots, one pack\'s worth: start with Essentials, then add a group pack per boost level.',
      'Type :oe_ in any channel of that server.',
    ],
    docs: ['https://support.discord.com/hc/en-us/articles/360036479811', 'https://discord.com/blog/beginners-guide-to-custom-emojis'],
  },
  {
    id: 'stoat',
    name: 'Stoat (formerly Revolt)',
    kind: 'emoji',
    size: 128,
    format: 'png',
    maxBytes: 256 * 1024,
    name_rule: SHORT,
    packSize: 50,
    packsFrom: 'discord',
    subsets: [],
    archive: 'zip',
    limits: '100 emoji per server, up to 500 KB each; names lowercase a-z, 0-9 and _, up to 32. Needs the ManageCustomisation permission.',
    steps: [
      'Use the Discord packs: they are already 50 per pack with names Stoat accepts.',
      'Open Server Settings, then Emojis, and upload the files from one or two packs.',
    ],
    docs: ['https://stoat.chat'],
  },
  {
    id: 'mastodon',
    name: 'Mastodon',
    kind: 'emoji',
    size: 128,
    format: 'png',
    maxBytes: 256 * 1024,
    name_rule: LONG,
    subsets: ['all', 'essentials'],
    archive: 'tar.gz',
    limits: 'PNG, GIF or WebP under 256 KB; shortcodes 2-128 letters, digits and _. No count limit. Needs the Manage Custom Emojis permission.',
    steps: [
      'Copy the tarball to the server. tootctl reads each .png in it and uses the file name as the shortcode.',
      'Run: RAILS_ENV=production bin/tootctl emoji import --category OpenEmoji openemoji-mastodon-all.tar.gz',
      'Add --unlisted to keep them out of the picker, or --overwrite to replace an earlier version.',
      'Or upload one at a time in Preferences, Administration, Custom emojis, Upload.',
    ],
    docs: ['https://docs.joinmastodon.org/admin/tootctl/#emoji-import'],
  },
  {
    id: 'misskey',
    name: 'Misskey',
    kind: 'emoji',
    size: 128,
    format: 'png',
    maxBytes: 256 * 1024,
    name_rule: LONG,
    subsets: ['all', 'essentials'],
    archive: 'zip',
    limits: 'Names letters, digits and _, up to 255. Admins and moderators only. Import replaces local emoji of the same name.',
    steps: [
      'Open the Control Panel, then Custom Emojis.',
      'Choose Import and select the zip; its meta.json sets each name, category, aliases and licence.',
      'Type :oe_ in a note.',
    ],
    docs: ['https://misskey-hub.net/en/docs/for-admin/features/managing-emojis/'],
  },
  {
    id: 'pleroma',
    name: 'Pleroma / Akkoma',
    kind: 'emoji',
    size: 128,
    format: 'png',
    maxBytes: 50 * 1024,
    name_rule: LONG,
    subsets: ['all', 'essentials'],
    archive: 'zip',
    limits: 'A pack folder with pack.json; PNG, under 50 KB recommended. Admins only.',
    steps: [
      'Unzip into instance/static/emoji/ on the server, so the pack is a folder holding pack.json.',
      'Reload: pleroma_ctl emoji reload (or Admin-FE, Emoji packs, Import from the filesystem), or restart.',
      'Type :oe_ in a post.',
    ],
    docs: ['https://docs.akkoma.dev/stable/configuration/custom_emoji/', 'https://docs.akkoma.dev/stable/administration/CLI_tasks/emoji/'],
  },
  {
    id: 'mattermost',
    name: 'Mattermost',
    kind: 'emoji',
    size: 128,
    format: 'png',
    maxBytes: 512 * 1024,
    name_rule: { max: 64, pattern: '^[a-z0-9_]+$', prefix: 'oe_' },
    packsFrom: 'generic',
    subsets: [],
    archive: 'zip',
    limits: 'JPG, GIF or PNG up to 512 KB, shown at 128x128; names up to 64, built-in names refused. Admins can turn custom emoji off.',
    steps: [
      'Open the emoji picker, then Custom Emoji, then Add Custom Emoji, and upload a file with its name.',
      'Admins can load a whole pack with mmctl import, one {"type":"emoji"} line per file.',
    ],
    docs: ['https://docs.mattermost.com/end-user-guide/collaborate/react-with-emojis-gifs.html', 'https://docs.mattermost.com/administration-guide/onboard/bulk-loading-data.html'],
  },
  {
    id: 'zulip',
    name: 'Zulip',
    kind: 'emoji',
    size: 128,
    format: 'png',
    maxBytes: 5 * 1024 * 1024,
    name_rule: LONG,
    packsFrom: 'generic',
    subsets: [],
    archive: 'zip',
    limits: 'PNG, JPG or GIF up to 5 MB; names are letters, digits, dashes and spaces (an underscore counts as a space). Who may add them is an organization setting.',
    steps: [
      'Open Settings, then Custom emoji, and add a file with its name.',
      'For a whole pack, the API takes one emoji per call: POST /api/v1/realm/emoji/<name>.',
    ],
    docs: ['https://zulip.com/help/custom-emoji', 'https://zulip.com/api/upload-custom-emoji'],
  },
  {
    id: 'rocketchat',
    name: 'Rocket.Chat',
    kind: 'emoji',
    size: 128,
    format: 'png',
    maxBytes: 256 * 1024,
    name_rule: LONG,
    packsFrom: 'generic',
    subsets: [],
    archive: 'zip',
    limits: 'PNG or JPEG; names without spaces or , : > < & " \' / \\ ( ). Needs the manage-emoji permission.',
    steps: [
      'Open Manage, Workspace, Emoji, then New, and upload a file with its name.',
      'For a whole pack, POST /api/v1/emoji-custom.create once per file.',
    ],
    docs: ['https://docs.rocket.chat/docs/manage-custom-sounds-and-emojis', 'https://developer.rocket.chat/apidocs/create-an-emoji'],
  },
  {
    id: 'teams',
    name: 'Microsoft Teams',
    kind: 'emoji',
    size: 128,
    format: 'png',
    maxBytes: 256 * 1024,
    name_rule: LONG,
    packsFrom: 'generic',
    subsets: [],
    archive: 'zip',
    limits: 'JPEG, PNG or GIF under 256 KB, up to 5,000 per organization; admins can turn it off. Not available in education tenants.',
    steps: [
      'Open Emoji, GIFs and Stickers, then Emoji, then Your org\'s emoji, and click +.',
      'Upload a file from the unzipped pack and name it. There is no bulk import, so start with Essentials.',
    ],
    docs: ['https://support.microsoft.com/en-us/office/use-custom-emoji-in-microsoft-teams-84feb1c4-6d2b-4ecd-8e55-a93c828fc53a'],
  },
  {
    id: 'matrix',
    name: 'Matrix (Cinny, FluffyChat, Nheko)',
    kind: 'emoji',
    size: 128,
    format: 'png',
    maxBytes: 256 * 1024,
    name_rule: LONG,
    packsFrom: 'generic',
    subsets: [],
    archive: 'zip',
    limits: 'Image packs (spec v1.19), per room or per account; 128x128 or larger. Cinny, FluffyChat, Nheko and SchildiChat support them; Element Web does not yet.',
    steps: [
      'In Cinny, open Settings, Emojis & Stickers (or a room\'s settings for a room pack) and upload the files.',
      'In FluffyChat, open Settings, Emotes, and add them.',
      'The shortcode is the file name.',
    ],
    docs: ['https://github.com/matrix-org/matrix-spec-proposals/blob/main/proposals/2545-emotes.md'],
  },
  {
    id: 'telegram-emoji',
    name: 'Telegram custom emoji',
    kind: 'emoji',
    size: 100,
    format: 'webp',
    maxBytes: 64 * 1024,
    packSize: 200,
    subsets: ['essentials', 'default-tone'],
    archive: 'zip',
    limits: 'Exactly 100x100 PNG or WebP, up to 200 per pack. Anyone can publish a pack; using custom emoji needs Telegram Premium.',
    steps: [
      'Open @Stickers and start a new emoji pack (static).',
      'Send each file from the unzipped pack as a file, then the emoji it stands for; emoji.txt lists them in order.',
      'Publish, pick an icon and a short name; the pack is then at t.me/addemoji/<short name>.',
      'To script it, the Bot API createNewStickerSet with sticker_type custom_emoji takes the same files.',
    ],
    docs: ['https://core.telegram.org/stickers', 'https://core.telegram.org/bots/api#createnewstickerset'],
  },
  {
    id: 'telegram-stickers',
    name: 'Telegram stickers',
    kind: 'stickers',
    size: 512,
    format: 'webp',
    maxBytes: 512 * 1024,
    packSize: 120,
    subsets: ['essentials', 'default-tone'],
    archive: 'zip',
    limits: '512 px WebP or PNG, up to 120 per pack; free for everyone.',
    steps: [
      'Open @Stickers and start a new sticker pack.',
      'Send each file from the unzipped pack as a file, then its emoji from emoji.txt.',
      'Publish and choose a short name; share t.me/addstickers/<short name>.',
    ],
    docs: ['https://core.telegram.org/stickers'],
  },
  {
    id: 'signal',
    name: 'Signal',
    kind: 'stickers',
    size: 512,
    format: 'webp',
    maxBytes: 300 * 1024,
    packSize: 200,
    subsets: ['essentials', 'default-tone'],
    archive: 'zip',
    limits: 'No custom emoji. Sticker packs: PNG or WebP, 512x512, up to 300 KB each and 200 per pack, one emoji per sticker. A pack cannot be edited after upload.',
    steps: [
      'Signal has no custom emoji, so the set ships as sticker packs.',
      'In Signal Desktop choose File, Create/Upload Sticker Pack, and drag in the files from one unzipped pack.',
      'Give each sticker its emoji from emoji.txt, set the title and author, and upload. Check it first: a pack cannot be edited afterwards.',
      'Share the signal.art/addstickers link it gives you; anyone can install the pack from it.',
    ],
    docs: ['https://support.signal.org/hc/en-us/articles/360031836512-Stickers'],
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    kind: 'stickers',
    size: 512,
    format: 'webp',
    maxBytes: 100 * 1024,
    packSize: 30,
    subsets: ['essentials', 'default-tone'],
    archive: 'wastickers',
    limits: 'No custom emoji. Sticker packs: exactly 512x512 WebP up to 100 KB, 3-30 per pack, a 96x96 tray icon; third-party packs arrive through an app.',
    steps: [
      'WhatsApp has no custom emoji, so the set ships as sticker packs of up to 30.',
      'On Android, open a .wastickers file with a sticker-pack importer app and tap Add to WhatsApp.',
      'Or make your own: in a chat open Stickers, then Create, and pick images from the unzipped pack.',
    ],
    docs: ['https://github.com/WhatsApp/stickers', 'https://faq.whatsapp.com/4148445205479237'],
  },
  {
    id: 'twitch',
    name: 'Twitch',
    kind: 'emoji',
    size: 128,
    format: 'png',
    maxBytes: 1024 * 1024,
    packsFrom: 'generic',
    subsets: [],
    archive: 'zip',
    limits: 'Affiliates and Partners. One square PNG from 112 to 4096 px under 1 MB (Twitch resizes it). New Affiliates get 35 standard slots, Partners up to 350. Codes are your channel prefix plus a suffix.',
    steps: [
      'Open the Creator Dashboard, then the emote settings, and upload a 128 px file with auto-resize on.',
      'Give it your channel prefix and a suffix of your own; the file name is only a suggestion.',
    ],
    docs: ['https://help.twitch.tv/s/article/emote-guidelines', 'https://help.twitch.tv/s/article/emote-slots'],
  },
  {
    id: 'youtube',
    name: 'YouTube (channel memberships)',
    kind: 'emoji',
    size: 128,
    format: 'png',
    maxBytes: 1024 * 1024,
    packsFrom: 'generic',
    subsets: [],
    archive: 'zip',
    limits: 'For channels with memberships: JPEG, PNG or GIF under 1 MB, 48x48 to 480x480; up to 54 as membership grows. Names 3-10 letters or digits under a family name.',
    steps: [
      'In YouTube Studio open Memberships, then Your badges and emoji, then Edit.',
      'Upload files from the Essentials pack and name each one yourself: YouTube names are 3-10 characters, too short for the file names.',
    ],
    docs: ['https://support.google.com/youtube/answer/7544492'],
  },
  {
    id: 'reddit',
    name: 'Reddit (flair emoji)',
    kind: 'emoji',
    size: 128,
    format: 'png',
    maxBytes: 64 * 1024,
    name_rule: LONG,
    subsets: ['essentials', 'flags'],
    archive: 'zip',
    limits: 'Post and user flair only, not in comments. Up to 128x128 and 64 KB, 5,000 per subreddit; moderators can upload 100 at a time.',
    steps: [
      'As a moderator, open Mod tools, Look and Feel, the emoji tool, then Add Emoji.',
      'Select up to 100 files from the unzipped pack at once.',
      'Use them in post or user flair.',
    ],
    docs: ['https://support.reddithelp.com/hc/en-us/articles/15484571863188-Custom-Emojis'],
  },
  {
    id: 'kick',
    name: 'Kick',
    kind: 'emoji',
    size: 512,
    format: 'png',
    maxBytes: 1024 * 1024,
    packsFrom: 'x',
    subsets: [],
    archive: 'zip',
    limits: 'PNG around 500x500 under 1 MB; 60 channel emotes for every channel, 24 subscriber emotes for Affiliates.',
    steps: [
      'Open the Streamer Dashboard, then Channel, then Community, and add an emote.',
      'Upload a 512 px PNG from the catalog (or the Essentials pack here) and name it.',
    ],
    docs: ['https://help.kick.com/en/articles/7113467-how-to-add-or-edit-kick-emotes'],
  },
  {
    id: 'x',
    name: 'X (Twitter)',
    kind: 'media',
    size: 512,
    format: 'png',
    maxBytes: 5 * 1024 * 1024,
    subsets: ['flags', 'essentials'],
    archive: 'zip',
    highlight: {
      subgroups: ['country-flag', 'subdivision-flag', 'flag'],
      why: 'Flags are what people put in X display names and bios.',
    },
    limits: 'No custom emoji and no sticker uploads. A flag in a name or bio is the Unicode character, drawn by X; the artwork goes out as an image, up to 5 MB.',
    steps: [
      'X has no custom emoji or stickers, so the set is for copying characters and posting images.',
      'For a flag in your display name or bio, open it in the catalog and use Copy emoji.',
      'To post the OpenEmoji artwork itself, download the 512 px PNG from the catalog or a pack here and attach it to a post or banner.',
    ],
    docs: ['https://help.x.com/en/using-x/posting-gifs-and-pictures'],
  },
  {
    id: 'bluesky',
    name: 'Bluesky',
    kind: 'media',
    size: 512,
    format: 'png',
    maxBytes: 1024 * 1024,
    packsFrom: 'x',
    subsets: [],
    archive: 'zip',
    limits: 'No custom emoji: the protocol only carries Unicode emoji. Some third-party clients add their own.',
    steps: [
      'Copy the character from the catalog into a post or your profile.',
      'Post the 512 px PNG as an image to use the artwork itself.',
    ],
    docs: ['https://github.com/bluesky-social/atproto'],
  },
  {
    id: 'social',
    name: 'Threads, Instagram, Facebook, LinkedIn',
    kind: 'media',
    size: 512,
    format: 'png',
    maxBytes: 5 * 1024 * 1024,
    packsFrom: 'x',
    subsets: [],
    archive: 'zip',
    highlight: {
      subgroups: ['face-smiling', 'face-affection', 'heart', 'country-flag'],
      why: 'None of these take custom emoji or uploaded sticker packs; the artwork goes out as images.',
    },
    limits: 'No custom emoji and no user sticker-pack uploads on any of them.',
    steps: [
      'Copy the character from the catalog into a post or profile; each app draws it in its own style.',
      'To use the OpenEmoji artwork, post the 512 px PNG as an image, a story sticker or a profile picture.',
    ],
    docs: [],
  },
  {
    id: 'generic',
    name: 'Any other app (128 px PNG, named)',
    kind: 'emoji',
    size: 128,
    format: 'png',
    maxBytes: 64 * 1024,
    name_rule: LONG,
    subsets: ['essentials', 'all'],
    archive: 'zip',
    limits: '128x128 transparent PNG under 64 KB, named in lowercase a-z, 0-9 and _: that fits Slack, Discord, Mastodon, Misskey, Mattermost, Stoat, Reddit and Matrix at once.',
    steps: ['Unzip and upload wherever the app takes custom emoji; the file name is the name to give each one.'],
    docs: [],
  },
];

/**
 * The most-used emoji, after Unicode's published frequency data. A pack for
 * networks with few slots, and the first pack anyone should try.
 */
export const ESSENTIALS = [
  '1f602', '2764-fe0f', '1f923', '1f44d', '1f62d', '1f64f', '1f618', '1f970', '1f60d', '1f60a',
  '1f389', '1f601', '1f495', '1f97a', '1f605', '1f525', '263a-fe0f', '1f926', '2665-fe0f', '1f937',
  '1f644', '1f606', '1f917', '1f609', '1f382', '1f914', '1f44f', '1f642', '1f633', '1f973',
  '1f60e', '1f44c', '1f49c', '1f614', '1f4aa', '2728', '1f496', '1f440', '1f60b', '1f60f',
  '1f622', '1f449', '1f497', '1f629', '1f4af', '1f339', '1f49e', '1f388', '1f499', '1f603',
];

// ------------------------------------------------------------- shortcodes

const TONE_SUFFIX: Record<string, string> = {
  'light skin tone': 't1',
  'medium-light skin tone': 't2',
  'medium skin tone': 't3',
  'medium-dark skin tone': 't4',
  'dark skin tone': 't5',
};

/**
 * The set's own shortcode for an emoji: `oe_` and the CLDR name in snake
 * case, with skin tones as `_t1`…`_t5` rather than spelled out, so
 * `woman technologist: medium-dark skin tone` is `oe_woman_technologist_t4`.
 */
export function shortcodeOf(name: string): string {
  let rest = name.toLowerCase();
  const tones: string[] = [];
  rest = rest.replace(/(?:light|medium-light|medium|medium-dark|dark) skin tone/g, (tone) => {
    tones.push(TONE_SUFFIX[tone]!);
    return '';
  });
  const slug = rest
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/#/g, ' hash ')
    .replace(/\*/g, ' asterisk ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return ['oe', slug, ...tones].filter(Boolean).join('_');
}

/** Fit a shortcode to a network's length cap, keeping it unique with a short hash of the key. */
export function fitName(shortcode: string, key: string, max: number): string {
  if (shortcode.length <= max) return shortcode;
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 4);
  return `${shortcode.slice(0, max - 5).replace(/_+$/, '')}_${hash}`;
}

// ------------------------------------------------------------------ packs

export interface Pack {
  id: string;
  title: string;
  subset: Subset;
  keys: string[];
}

const GROUP_SLUG: Record<string, string> = {
  'Smileys & Emotion': 'smileys',
  'People & Body': 'people',
  'Animals & Nature': 'nature',
  'Food & Drink': 'food',
  'Travel & Places': 'travel',
  Activities: 'activities',
  Objects: 'objects',
  Symbols: 'symbols',
  Flags: 'flags',
  Component: 'components',
};

const hasTone = (e: Emoji) => /-1f3f[b-f]/.test(`-${e.key}`);

/** Split a subset into packs no larger than the network allows, one group at a time. */
export function packsFor(platform: Platform, emoji: readonly Emoji[], subset: Subset): Pack[] {
  const drawn = emoji.filter((e) => e.png);
  let chosen: Emoji[];
  if (subset === 'essentials') {
    const byKey = new Map(drawn.map((e) => [e.key, e]));
    chosen = ESSENTIALS.map((k) => byKey.get(k)).filter((e): e is Emoji => Boolean(e));
  } else if (subset === 'flags') {
    chosen = drawn.filter((e) => e.subgroup === 'country-flag' || e.subgroup === 'subdivision-flag' || e.subgroup === 'flag');
  } else if (subset === 'default-tone') {
    chosen = drawn.filter((e) => !hasTone(e) && e.group !== 'Component');
  } else {
    chosen = drawn.filter((e) => e.group !== 'Component');
  }
  if (chosen.length === 0) return [];

  const limit = platform.packSize;
  if (subset === 'essentials' || !limit) {
    const title = { essentials: 'Essentials', flags: 'Flags', all: 'complete', 'default-tone': 'default tone' }[subset];
    return [{ id: subset, title: `OpenEmoji ${title}`, subset, keys: chosen.map((e) => e.key) }];
  }
  const packs: Pack[] = [];
  const groups = new Map<string, Emoji[]>();
  for (const e of chosen) groups.set(e.group, [...(groups.get(e.group) ?? []), e]);
  for (const [group, list] of groups) {
    const slug = GROUP_SLUG[group] ?? group.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const parts = Math.ceil(list.length / limit);
    for (let i = 0; i < parts; i += 1) {
      packs.push({
        id: parts > 1 ? `${slug}-${i + 1}` : slug,
        title: parts > 1 ? `OpenEmoji ${group} ${i + 1}` : `OpenEmoji ${group}`,
        subset,
        keys: list.slice(i * limit, (i + 1) * limit).map((e) => e.key),
      });
    }
  }
  return packs;
}

// --------------------------------------------------------------- archives

/**
 * A stored (uncompressed) zip. The members are PNG and WEBP, which do not
 * compress further, so deflate would only cost time; and writing it here
 * means no `zip` binary is needed.
 */
export function zipStore(files: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const crc = crc32(file.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(0, 10); // time/date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, file.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + file.data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// ---------------------------------------------------------------- export

export interface ExportedPack extends Pack {
  file: string;
  bytes: number;
}

export interface PlatformIndex {
  generated: string;
  repo_raw: string;
  platforms: Array<
    Omit<Platform, 'subsets' | 'maxBytes'> & {
      max_bytes: number;
      packs: ExportedPack[];
      /** key -> the name on this network, only where it differs from `shortcodes[0]` in the manifest. */
      renamed: Record<string, string>;
    }
  >;
}

type Sharp = typeof import('sharp').default;

export interface ExportOptions {
  out: string;
  manifest: Manifest;
  platforms: Platform[];
  repoRaw: string;
  log: (line: string) => void;
}

/** Encode one glyph for a network, stepping quality down until it fits. */
async function encode(sharp: Sharp, source: Buffer, platform: Platform): Promise<Buffer> {
  const resized = sharp(source).resize(platform.size, platform.size, { kernel: 'lanczos3' });
  for (const quality of [92, 85, 75, 65, 50, 40]) {
    const data =
      platform.format === 'webp'
        ? await resized.clone().webp({ quality, alphaQuality: 90, effort: 5 }).toBuffer()
        : await resized.clone().png({ compressionLevel: 9, palette: quality < 92, quality }).toBuffer();
    if (data.length <= platform.maxBytes) return data;
  }
  throw new Error(`cannot fit under ${platform.maxBytes} bytes for ${platform.id}`);
}

export async function exportPlatforms(options: ExportOptions): Promise<PlatformIndex> {
  const sharp = ((await import('sharp')) as unknown as { default: Sharp }).default;
  const { manifest, out } = options;
  const byKey = new Map(manifest.emoji.map((e) => [e.key, e]));
  const root = join(out, 'platforms');
  await mkdir(root, { recursive: true });
  const index: PlatformIndex = { generated: new Date().toISOString(), repo_raw: options.repoRaw, platforms: [] };

  // Sources: the 512 PNG, read once per glyph and shared by every network.
  const cache = new Map<string, Buffer>();
  const source = async (key: string) => {
    let data = cache.get(key);
    if (!data) {
      data = await readFile(join(out, 'png', '512', `${key}.png`));
      cache.set(key, data);
    }
    return data;
  };

  // Networks that reuse another's files are indexed after it, never built.
  const builders = options.platforms.filter((p) => !p.packsFrom);
  const borrowers = options.platforms.filter((p) => p.packsFrom);
  for (const platform of builders) {
    const dir = join(root, platform.id);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const names = new Map<string, string>();
    const renamed: Record<string, string> = {};
    if (platform.name_rule) {
      const used = new Set<string>();
      for (const e of manifest.emoji) {
        const canonical = shortcodeOf(e.name);
        let fitted = fitName(canonical, e.key, platform.name_rule.max);
        if (used.has(fitted)) fitted = fitName(`${canonical}_${e.key.replace(/-/g, '_')}`, e.key, platform.name_rule.max);
        used.add(fitted);
        names.set(e.key, fitted);
        if (fitted !== canonical) renamed[e.key] = fitted;
      }
    }

    const packs: ExportedPack[] = [];
    for (const subset of platform.subsets) {
      for (const pack of packsFor(platform, manifest.emoji, subset)) {
        const files: Array<{ name: string; data: Buffer }> = [];
        const emojiLines: string[] = [];
        for (const [index_, key] of pack.keys.entries()) {
          const e = byKey.get(key)!;
          const data = await encode(sharp, await source(key), platform);
          const base = names.get(key) ?? `${String(index_ + 1).padStart(3, '0')}-${key}`;
          files.push({ name: `${base}.${platform.format}`, data });
          emojiLines.push(`${base}.${platform.format}\t${e.char}\t${e.name}`);
        }
        const packName = `openemoji-${platform.id}-${pack.id}`;
        const archiveFile = await writeArchive(platform, packName, pack, files, emojiLines, dir, manifest);
        const bytes = (await stat(join(dir, archiveFile))).size;
        packs.push({ ...pack, file: `platforms/${platform.id}/${archiveFile}`, bytes });
        options.log(`${platform.id}: ${archiveFile} (${pack.keys.length}, ${(bytes / 1048576).toFixed(1)} MB)`);
      }
    }

    const { subsets: _subsets, maxBytes, ...rest } = platform;
    index.platforms.push({ ...rest, max_bytes: maxBytes, packs, renamed });
    await writeFile(join(dir, 'README.md'), readmeFor(platform, packs));
  }

  for (const platform of borrowers) {
    const from = index.platforms.find((p) => p.id === platform.packsFrom);
    if (!from) throw new Error(`${platform.id} uses ${platform.packsFrom}'s packs; export ${platform.packsFrom} too`);
    const { subsets: _subsets, maxBytes, ...rest } = platform;
    index.platforms.push({ ...rest, max_bytes: maxBytes, packs: from.packs, renamed: from.renamed });
  }
  // Keep the table's order, which is the order the catalog lists them in.
  const order = new Map(PLATFORMS.map((p, i) => [p.id, i]));
  index.platforms.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  await writeFile(join(root, 'platforms.json'), `${JSON.stringify(index, null, 2)}\n`);
  return index;
}

async function writeArchive(
  platform: Platform,
  packName: string,
  pack: Pack,
  files: Array<{ name: string; data: Buffer }>,
  emojiLines: string[],
  dir: string,
  manifest: Manifest,
): Promise<string> {
  const listing = { name: 'emoji.txt', data: Buffer.from(`${emojiLines.join('\n')}\n`) };
  const license = {
    name: 'LICENSE.txt',
    data: Buffer.from(`${manifest.name} by Profullstack, Inc. ${manifest.license}. Drawn by ${manifest.ai_model}.\nhttps://github.com/profullstack/openemoji\n`),
  };

  if (platform.archive === 'tar.gz') {
    // tootctl emoji import reads every image in the tarball and uses its file
    // name as the shortcode; anything else in it is ignored.
    const staging = join(dir, `.${packName}`);
    await mkdir(staging, { recursive: true });
    for (const f of files) await writeFile(join(staging, f.name), f.data);
    const file = `${packName}.tar.gz`;
    await runCommand('tar', ['-czf', join(dir, file), '-C', staging, '.']);
    await rm(staging, { recursive: true, force: true });
    return file;
  }

  if (platform.id === 'misskey') {
    const meta = {
      metaVersion: 2,
      host: 'openemoji',
      exportedAt: new Date().toISOString(),
      emojis: files.map((f, i) => {
        const key = pack.keys[i]!;
        const e = manifest.emoji.find((x) => x.key === key)!;
        return {
          downloaded: true,
          fileName: f.name,
          emoji: {
            name: f.name.replace(/\.[a-z]+$/, ''),
            category: `OpenEmoji/${e.group}`,
            aliases: [e.char, ...(e.keywords ?? [])],
            license: manifest.license,
          },
        };
      }),
    };
    files = [...files, { name: 'meta.json', data: Buffer.from(JSON.stringify(meta, null, 2)) }];
  }

  if (platform.id === 'pleroma') {
    const packJson = {
      files: Object.fromEntries(files.map((f) => [f.name.replace(/\.[a-z]+$/, ''), f.name])),
      files_count: files.length,
      pack: {
        description: `${pack.title}: ${manifest.name}, drawn by ${manifest.ai_model}`,
        homepage: 'https://logicsrc.com/openemoji/catalog',
        license: manifest.license,
        'share-files': true,
      },
    };
    files = [...files, { name: 'pack.json', data: Buffer.from(JSON.stringify(packJson, null, 2)) }];
    // Pleroma expects the pack as a folder named after it.
    files = files.map((f) => ({ ...f, name: `${packName}/${f.name}` }));
  }

  if (platform.archive === 'wastickers') {
    // The .wastickers layout sticker importers read: title, author, a 96x96
    // tray icon and the webp stickers, flat in one zip.
    const sharp = ((await import('sharp')) as unknown as { default: Sharp }).default;
    const tray = await sharp(files[0]!.data).resize(96, 96).png().toBuffer();
    files = [
      { name: 'title.txt', data: Buffer.from(pack.title) },
      { name: 'author.txt', data: Buffer.from('OpenEmoji by Profullstack') },
      { name: 'tray.png', data: tray },
      ...files,
    ];
    const file = `${packName}.wastickers`;
    await writeFile(join(dir, file), zipStore([...files, listing]));
    return file;
  }

  const file = `${packName}.zip`;
  await writeFile(join(dir, file), zipStore([...files, listing, license]));
  return file;
}

function readmeFor(platform: Platform, packs: ExportedPack[]): string {
  return `# OpenEmoji for ${platform.name}

${platform.kind === 'stickers' ? `${platform.name} has no custom emoji, so the set ships as sticker packs.\n\n` : platform.kind === 'media' ? `${platform.name}: no custom emoji and no sticker uploads, so the set ships as images to post.\n\n` : ''}${platform.limits}

## Install

${platform.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}

## Packs

| Pack | Emoji | Size |
|---|---|---|
${packs.map((p) => `| [${p.title}](${p.file.replace(`platforms/${platform.id}/`, '')}) | ${p.keys.length} | ${(p.bytes / 1048576).toFixed(1)} MB |`).join('\n')}

Every pack includes emoji.txt: each file, its emoji and its name.
${platform.docs.length ? `\nOfficial documentation: ${platform.docs.join(', ')}\n` : ''}
Browse the set by network: https://logicsrc.com/openemoji/catalog?platform=${platform.id}
`;
}

export const exists = existsSync;
