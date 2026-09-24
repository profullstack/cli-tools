/**
 * Which hue every icon gets, in one place, because the model will not decide
 * it well: left to itself it drifts the whole set to a single hue (orange with
 * warm references, blue with cool ones). Each category has its own colour, so
 * a page of icons reads as grouped, and meaning overrides the category where
 * colour carries meaning (delete is red whatever category it sits in).
 *
 * Each entry carries the hue twice, because the two style families describe
 * material differently and a prompt is read literally:
 *
 *   - `hq` is the glossy vocabulary the shipped HQ style was drawn with
 *     ("deep indigo-violet (#5B4BDB) glass") and is kept verbatim, so nothing
 *     already drawn would come back different if it were drawn again;
 *   - `accent` is the same hue named plainly ("indigo-violet #5B4BDB"), which
 *     the agentic styles put into their own material sentence.
 */

import type { IconDef } from './icon-set.ts';

export interface Hue {
  /** The HQ style's phrasing, glass and enamel. */
  hq: string;
  /** The hue alone, for a style that supplies its own material. */
  accent: string;
}

export const CATEGORY_PALETTE: Record<string, Hue> = {
  action: { hq: 'deep indigo-violet (#5B4BDB) glass', accent: 'indigo-violet #5B4BDB' },
  navigation: { hq: 'teal (#0FA3A3) glass', accent: 'teal #0FA3A3' },
  communication: { hq: 'sky blue (#1E88E5) glass', accent: 'sky blue #1E88E5' },
  media: { hq: 'magenta-pink (#E0337A) glass', accent: 'magenta-pink #E0337A' },
  file: { hq: 'warm amber-yellow (#F5B422) with white paper', accent: 'warm amber-yellow #F5B422, with white paper where the object has paper' },
  status: { hq: 'cobalt blue (#2F6FEB) glass', accent: 'cobalt blue #2F6FEB' },
  time: { hq: 'cyan (#12A8C9) glass with white faces', accent: 'cyan #12A8C9, with a pale face where the object has one' },
  commerce: { hq: 'emerald green (#1FA35C) glass', accent: 'emerald green #1FA35C' },
  dev: { hq: 'graphite slate (#39424E) with electric lime (#9BE22E) accents', accent: 'electric lime #9BE22E on graphite #39424E' },
  device: { hq: 'brushed silver aluminium with dark glass screens and a blue glow', accent: 'silver-grey #B4BAC2 with a blue #2F6FEB screen' },
  editor: { hq: 'violet-purple (#8E44D9) glass', accent: 'violet-purple #8E44D9' },
  misc: { hq: "the object's own natural colours", accent: "the object's own natural colours" },
};

/** Meaning beats category: these keys take their colour from what they mean. */
export const OVERRIDES: Array<{ keys: string[]; hue: Hue }> = [
  {
    keys: ['add', 'plus-circle', 'check', 'check-circle', 'checkbox', 'toggle-on', 'online', 'user-plus', 'user-check', 'shield-check', 'calendar-check', 'clipboard-check', 'download', 'cloud-download', 'folder-plus', 'file-plus', 'calendar-plus', 'battery-charging'],
    hue: { hq: 'fresh green (#22B35A) glass', accent: 'fresh green #22B35A' },
  },
  {
    keys: ['delete', 'close', 'x-circle', 'error', 'ban', 'minus-circle', 'user-minus', 'phone-off', 'mic-off', 'bell-off', 'volume-off', 'wifi-off', 'unlink', 'bug', 'power'],
    hue: { hq: 'coral red (#E5484D) glass', accent: 'coral red #E5484D' },
  },
  {
    keys: ['warning', 'bell', 'alarm', 'star', 'key', 'lightbulb', 'zap', 'award', 'trophy', 'sun', 'megaphone', 'coins', 'dollar'],
    hue: { hq: 'warm gold-amber (#F5A524) glass', accent: 'warm gold-amber #F5A524' },
  },
  { keys: ['heart'], hue: { hq: 'glossy red (#E0245E)', accent: 'red #E0245E' } },
  {
    keys: ['lock', 'unlock', 'shield', 'fingerprint'],
    hue: { hq: 'steel blue-grey (#5B6B82) metal with a gold keyhole or accent', accent: 'steel blue-grey #5B6B82, with a gold #F5A524 keyhole or accent' },
  },
  {
    keys: ['sparkles', 'palette', 'brush', 'pen-tool', 'theme'],
    hue: { hq: 'purple-to-magenta (#8E44D9 to #E0337A) glass', accent: 'purple #8E44D9 shading to magenta #E0337A' },
  },
  { keys: ['info', 'help'], hue: { hq: 'cobalt blue (#2F6FEB) glass', accent: 'cobalt blue #2F6FEB' } },
  { keys: ['moon'], hue: { hq: 'midnight indigo (#3949AB) with a pale gold rim', accent: 'midnight indigo #3949AB with a pale gold rim' } },
  { keys: ['leaf'], hue: { hq: 'leaf green (#3BAA35)', accent: 'leaf green #3BAA35' } },
  { keys: ['droplet'], hue: { hq: 'clear water blue (#2AA7F0)', accent: 'water blue #2AA7F0' } },
  { keys: ['coffee'], hue: { hq: 'white ceramic with a coffee-brown (#6F4E37) interior', accent: 'off-white #EDEDE8 with a coffee-brown #6F4E37 interior' } },
  { keys: ['rocket'], hue: { hq: 'white and silver with a teal window and a small orange flame', accent: 'off-white and silver with a teal #0FA3A3 window and a small orange #F57C00 flame' } },
  { keys: ['thermometer'], hue: { hq: 'glass with a red (#E5484D) mercury bulb', accent: 'pale grey with a red #E5484D bulb' } },
  { keys: ['umbrella', 'anchor', 'building', 'briefcase'], hue: { hq: 'navy (#24407A) with brass accents', accent: 'navy #24407A with brass #B08D45 accents' } },
  { keys: ['rss'], hue: { hq: 'orange (#F57C00) glass', accent: 'orange #F57C00' } },
];

export function hueFor(icon: IconDef): Hue {
  for (const { keys, hue } of OVERRIDES) if (keys.includes(icon.key)) return hue;
  return CATEGORY_PALETTE[icon.category] ?? CATEGORY_PALETTE.misc!;
}

/** The HQ style's colour sentence for an icon. */
export function hqColorFor(icon: IconDef): string {
  return hueFor(icon).hq;
}

/** The hue alone, for a style that describes its own material. */
export function accentFor(icon: IconDef): string {
  return hueFor(icon).accent;
}

/** Kept as it was published: the HQ phrasing, by category. */
export const CATEGORY_COLORS: Record<string, string> = Object.fromEntries(
  Object.entries(CATEGORY_PALETTE).map(([category, hue]) => [category, hue.hq]),
);
