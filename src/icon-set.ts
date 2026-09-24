/**
 * The OpenIcon reference set: every icon a UI keeps reaching for.
 *
 * Generic icons are drawn here, by hand, on a 24x24 grid: 2px strokes,
 * round caps and joins, 2 units of padding, `currentColor`. The body of each
 * is the inside of an <svg>, so one wrapper (STROKE) gives the whole set the
 * same weight. Shapes that repeat (gear teeth, sun rays, signal bars) are
 * computed rather than typed, so they stay exact.
 *
 * Brand logos are never drawn here: they come from Simple Icons (CC0) or,
 * where Simple Icons has none, Font Awesome Free (CC BY 4.0); see
 * icon-brands.ts.
 *
 * Every icon also carries its terminal fallbacks: a Unicode symbol and an
 * ASCII spelling (1-3 characters). The Nerd Font glyph is looked up by name
 * at build time, from the `nerd` candidates, in Nerd Fonts' glyphnames.json.
 */

export interface IconDef {
  key: string;
  category: string;
  /** SVG body on the 24x24 stroke grid. */
  body: string;
  aliases?: string[];
  keywords?: string[];
  /** Best single Unicode character or emoji for a terminal without Nerd Fonts. */
  unicode: string;
  /** 1-3 ASCII characters, for anything else. */
  ascii: string;
  /** Nerd Font glyph names to try, best first (without the `nf-` prefix). */
  nerd: string[];
}

// ------------------------------------------------------------- helpers

const f = (n: number) => Number(n.toFixed(2)).toString();
const c = (cx: number, cy: number, r: number) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`;
const r = (x: number, y: number, w: number, h: number, rx = 2) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"/>`;
const p = (d: string) => `<path d="${d}"/>`;
/** A dot: a zero-radius-looking circle that the 2px stroke fills to 4px across. */
const dot = (cx: number, cy: number) => `<circle cx="${cx}" cy="${cy}" r="1"/>`;

/** A gear: `teeth` flat-topped teeth between rInner and rOuter, and a hub. */
function gear(teeth: number, rOuter: number, rInner: number, hub: number, cx = 12, cy = 12): string {
  const pts: string[] = [];
  const step = (Math.PI * 2) / teeth;
  for (let i = 0; i < teeth; i += 1) {
    const a = i * step - Math.PI / 2;
    const w = step * 0.22;
    const angles = [a - step / 2 + w * 0.2, a - w, a - w * 0.7, a + w * 0.7, a + w];
    const radii = [rInner, rInner, rOuter, rOuter, rInner];
    angles.forEach((ang, j) => {
      const rad = radii[j]!;
      pts.push(`${f(cx + rad * Math.cos(ang))} ${f(cy + rad * Math.sin(ang))}`);
    });
  }
  return `${p(`M${pts.join('L')}Z`)}${c(cx, cy, hub)}`;
}

/** Evenly spaced rays around a centre, from r1 to r2. */
function rays(n: number, r1: number, r2: number, cx = 12, cy = 12, offset = 0): string {
  let d = '';
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * Math.PI * 2 + offset;
    d += `M${f(cx + r1 * Math.cos(a))} ${f(cy + r1 * Math.sin(a))}L${f(cx + r2 * Math.cos(a))} ${f(cy + r2 * Math.sin(a))}`;
  }
  return p(d);
}

const magnifier = `${c(11, 11, 7)}${p('m21 21-5-5')}`;
const doc = p('M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z') + p('M14 2v6h6');
const folder = p('M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z');
const envelope = `${r(2, 4, 20, 16)}${p('m22 7-10 6L2 7')}`;
const bubble = p('M21 11.5a8.4 8.4 0 0 1-9 8.4 8.8 8.8 0 0 1-3.8-.9L3 21l1.9-5.2A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z');
const square = p('M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z');
const handset = p('M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z');
const person = `${c(12, 8, 4)}${p('M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1')}`;
const cloud = p('M17.5 19H7a5 5 0 1 1 1.3-9.8A6 6 0 0 1 19.6 11 4 4 0 0 1 17.5 19z');
const speaker = p('M11 5 6 9H2v6h4l5 4z');
const bell = p('M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9') + p('M10.3 21a1.9 1.9 0 0 0 3.4 0');
const lockBody = r(4, 11, 16, 11);
const shield = p('M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z');
const cal = `${r(3, 4, 18, 18)}${p('M16 2v4M8 2v4M3 10h18')}`;
const clockFace = `${c(12, 12, 10)}${p('M12 6v6l4 2')}`;
const screen = `${r(2, 3, 20, 14)}${p('M8 21h8M12 17v4')}`;
const circleI = c(12, 12, 10);
const tri = p('M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z');
const cardBody = r(2, 5, 20, 14);
const heartPath = p('M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7z');
const star = p('m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.2-6.2 3.2L7 14.2 2 9.3l6.9-1z');
const volWaves = p('M15.5 8.5a5 5 0 0 1 0 7') + p('M19 5a10 10 0 0 1 0 14');
const node = (x: number, y: number) => c(x, y, 3);

// ---------------------------------------------------------------- icons

type Row = [key: string, body: string, unicode: string, ascii: string, nerd: string[], keywords?: string[]];

/**
 * Aliases are other names that must find exactly one icon (so `email` is
 * `mail` everywhere); keywords are search terms and may be shared. Only the
 * names people actually type for an icon are aliases.
 */
export const ALIASES: Record<string, string[]> = {
  add: ['plus'],
  close: ['x-mark', 'times'],
  delete: ['trash', 'bin'],
  edit: ['pencil'],
  search: ['magnify', 'find'],
  settings: ['gear', 'cog', 'preferences'],
  menu: ['hamburger'],
  'more-horizontal': ['ellipsis'],
  'more-vertical': ['kebab'],
  copy: ['duplicate'],
  cut: ['scissors'],
  refresh: ['reload', 'sync'],
  save: ['floppy'],
  print: ['printer'],
  'external-link': ['open-in-new'],
  maximize: ['fullscreen'],
  minimize: ['exit-fullscreen'],
  'eye-off': ['hide'],
  eye: ['show', 'view'],
  pin: ['thumbtack'],
  star: ['favorite'],
  heart: ['love'],
  'thumbs-up': ['like'],
  'thumbs-down': ['dislike'],
  tag: ['label'],
  send: ['paper-plane'],
  'log-in': ['sign-in', 'login'],
  'log-out': ['sign-out', 'logout'],
  home: ['house'],
  'map-pin': ['location', 'marker'],
  globe: ['world', 'web'],
  mail: ['email', 'envelope'],
  phone: ['telephone', 'call'],
  chat: ['message', 'comment'],
  at: ['at-sign', 'mention'],
  mic: ['microphone'],
  bell: ['notification'],
  megaphone: ['bullhorn', 'announce'],
  contact: ['address-book'],
  user: ['person', 'account', 'profile'],
  users: ['people', 'team'],
  'user-plus': ['add-user', 'invite'],
  'id-card': ['identity'],
  volume: ['sound', 'speaker'],
  'volume-off': ['mute'],
  music: ['song'],
  image: ['picture', 'photo'],
  camera: ['photo-camera'],
  film: ['movie'],
  tv: ['television'],
  file: ['document'],
  folder: ['directory'],
  paperclip: ['attachment', 'attach'],
  database: ['db'],
  package: ['box'],
  info: ['information'],
  warning: ['alert-triangle', 'caution'],
  error: ['alert-circle'],
  help: ['question', 'faq'],
  ban: ['blocked', 'forbidden'],
  loader: ['spinner', 'loading'],
  hourglass: ['pending'],
  zap: ['bolt', 'lightning'],
  sparkles: ['ai', 'magic'],
  checkbox: ['check-square'],
  'checkbox-empty': ['square'],
  calendar: ['date'],
  alarm: ['alarm-clock'],
  timer: ['stopwatch'],
  history: ['recent'],
  cart: ['shopping-cart'],
  bag: ['shopping-bag'],
  'credit-card': ['payment', 'card'],
  dollar: ['usd', 'currency'],
  receipt: ['invoice'],
  gift: ['present'],
  store: ['storefront'],
  truck: ['shipping', 'delivery'],
  percent: ['discount'],
  'qr-code': ['qr'],
  terminal: ['console', 'shell', 'cli'],
  code: ['source-code'],
  braces: ['json', 'curly-braces'],
  'git-pull-request': ['pull-request', 'merge-request'],
  cpu: ['chip', 'processor'],
  command: ['cmd'],
  hash: ['hashtag'],
  plug: ['integration'],
  flask: ['experiment', 'lab'],
  smartphone: ['mobile', 'cellphone'],
  monitor: ['desktop', 'display'],
  laptop: ['computer'],
  moon: ['dark-mode', 'night'],
  sun: ['light-mode', 'day'],
  theme: ['contrast'],
  lightbulb: ['idea'],
  rocket: ['deploy'],
  puzzle: ['plugin', 'extension'],
  palette: ['color'],
  translate: ['language', 'i18n'],
  accessibility: ['a11y'],
  smile: ['happy'],
  fingerprint: ['biometric'],
  briefcase: ['work', 'job'],
  building: ['company', 'office'],
  trophy: ['prize'],
  target: ['goal', 'bullseye'],
  'cell-signal': ['reception'],
};

const group = (category: string, rows: Row[]): IconDef[] =>
  rows.map(([key, body, unicode, ascii, nerd, terms]) => {
    const aliases = ALIASES[key] ?? [];
    const keywords = (terms ?? []).filter((t) => !aliases.includes(t) && t !== key);
    return {
      key,
      category,
      body,
      unicode,
      ascii,
      nerd,
      ...(aliases.length ? { aliases } : {}),
      ...(keywords.length ? { keywords } : {}),
    };
  });

export const GENERIC: IconDef[] = [
  ...group('action', [
    ['add', p('M12 5v14M5 12h14'), '+', '+', ['md-plus', 'fa-plus'], ['plus', 'new', 'create']],
    ['minus', p('M5 12h14'), '−', '-', ['md-minus', 'fa-minus'], ['subtract', 'remove']],
    ['close', p('M18 6 6 18M6 6l12 12'), '✕', 'x', ['md-close', 'fa-xmark'], ['x', 'dismiss', 'cancel']],
    ['check', p('M20 6 9 17l-5-5'), '✓', 'v', ['md-check', 'fa-check'], ['done', 'ok', 'tick', 'confirm']],
    ['check-circle', circleI + p('m8 12 3 3 5-6'), '✅', '(v)', ['md-check_circle_outline', 'md-check_circle'], ['success', 'complete']],
    ['x-circle', circleI + p('m15 9-6 6M9 9l6 6'), '❎', '(x)', ['md-close_circle_outline', 'md-close_circle'], ['error-close']],
    ['plus-circle', circleI + p('M12 8v8M8 12h8'), '⊕', '(+)', ['md-plus_circle_outline', 'md-plus_circle']],
    ['minus-circle', circleI + p('M8 12h8'), '⊖', '(-)', ['md-minus_circle_outline', 'md-minus_circle']],
    ['edit', p('M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z') + p('m15 5 4 4'), '✎', '/e', ['md-pencil', 'fa-pencil'], ['pencil', 'write', 'modify']],
    ['delete', p('M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6'), '🗑', 'del', ['md-trash_can_outline', 'md-delete', 'fa-trash'], ['trash', 'remove', 'bin']],
    ['search', magnifier, '🔍', '?', ['md-magnify', 'fa-magnifying_glass'], ['find', 'magnify', 'lookup']],
    ['zoom-in', magnifier + p('M11 8v6M8 11h6'), '🔎', '+?', ['md-magnify_plus_outline', 'md-magnify_plus']],
    ['zoom-out', magnifier + p('M8 11h6'), '🔎', '-?', ['md-magnify_minus_outline', 'md-magnify_minus']],
    ['settings', gear(8, 10, 7.5, 3), '⚙', '*', ['md-cog', 'fa-gear'], ['gear', 'cog', 'preferences', 'options']],
    ['sliders', p('M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6'), '🎚', '=|=', ['md-tune_variant', 'md-tune', 'fa-sliders'], ['adjust', 'controls', 'tune']],
    ['filter', p('M22 3H2l8 9.5V19l4 2v-8.5z'), '⏷', 'Y', ['md-filter_outline', 'md-filter', 'fa-filter'], ['funnel']],
    ['sort', p('m3 8 4-4 4 4M7 4v16M21 16l-4 4-4-4M17 20V4'), '⇅', '^v', ['md-sort', 'fa-sort'], ['order']],
    ['sort-asc', p('m3 8 4-4 4 4M7 4v16M11 12h4M11 16h7M11 20h10'), '↑', 'a-z', ['md-sort_ascending', 'fa-arrow_up_short_wide']],
    ['sort-desc', p('m3 16 4 4 4-4M7 20V4M11 4h10M11 8h7M11 12h4'), '↓', 'z-a', ['md-sort_descending', 'fa-arrow_down_wide_short']],
    ['menu', p('M4 6h16M4 12h16M4 18h16'), '☰', '=', ['md-menu', 'fa-bars'], ['hamburger', 'bars', 'navigation']],
    ['more-horizontal', dot(5, 12) + dot(12, 12) + dot(19, 12), '⋯', '...', ['md-dots_horizontal', 'fa-ellipsis'], ['ellipsis', 'overflow']],
    ['more-vertical', dot(12, 5) + dot(12, 12) + dot(12, 19), '⋮', ':', ['md-dots_vertical', 'fa-ellipsis_vertical'], ['kebab', 'overflow']],
    ['copy', r(8, 8, 14, 14) + p('M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2'), '⧉', 'cp', ['md-content_copy', 'fa-copy'], ['duplicate', 'clone']],
    ['clipboard', r(8, 2, 8, 4, 1) + p('M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2'), '📋', '[=]', ['md-clipboard_outline', 'md-clipboard', 'fa-clipboard'], ['paste']],
    ['clipboard-check', r(8, 2, 8, 4, 1) + p('M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2') + p('m9 14 2 2 4-4'), '📋', '[v]', ['md-clipboard_check_outline', 'md-clipboard_check'], ['copied']],
    ['cut', c(6, 6, 3) + c(6, 18, 3) + p('M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12'), '✂', '8<', ['md-content_cut', 'fa-scissors'], ['scissors']],
    ['share', c(18, 5, 3) + c(6, 12, 3) + c(18, 19, 3) + p('m8.6 13.5 6.8 4M15.4 6.5l-6.8 4'), '⤴', '<', ['md-share_variant_outline', 'md-share_variant', 'fa-share_nodes']],
    ['share-out', p('M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13'), '⇪', '^', ['md-export_variant', 'fa-arrow_up_from_bracket'], ['export']],
    ['download', p('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3'), '⤓', 'v_', ['md-download', 'fa-download'], ['save-file']],
    ['upload', p('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12'), '⤒', '^_', ['md-upload', 'fa-upload']],
    ['refresh', p('M21 12a9 9 0 0 1-15.4 6.4L3 16M3 12a9 9 0 0 1 15.4-6.4L21 8M21 3v5h-5M3 21v-5h5'), '⟳', '@', ['md-refresh', 'fa-arrows_rotate'], ['reload', 'sync']],
    ['undo', p('M3 7v6h6') + p('M21 17a9 9 0 0 0-15-6.7L3 13'), '↶', '<-', ['md-undo', 'fa-rotate_left']],
    ['redo', p('M21 7v6h-6') + p('M3 17a9 9 0 0 1 15-6.7L21 13'), '↷', '->', ['md-redo', 'fa-rotate_right']],
    ['save', p('M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z') + p('M17 21v-8H7v8M7 3v5h8'), '💾', '[s]', ['md-content_save_outline', 'md-content_save', 'fa-floppy_disk'], ['floppy', 'disk']],
    ['print', p('M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2') + r(6, 14, 12, 8, 1), '🖨', 'prn', ['md-printer_outline', 'md-printer', 'fa-print'], ['printer']],
    ['external-link', p('M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'), '↗', '->]', ['md-open_in_new', 'fa-arrow_up_right_from_square'], ['open-new', 'launch']],
    ['maximize', p('M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3'), '⛶', '[ ]', ['md-fullscreen', 'fa-expand'], ['fullscreen', 'expand']],
    ['minimize', p('M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3'), '⊡', '][', ['md-fullscreen_exit', 'fa-compress'], ['exit-fullscreen', 'collapse']],
    ['lock', lockBody + p('M7 11V7a5 5 0 0 1 10 0v4'), '🔒', '[#]', ['md-lock_outline', 'md-lock', 'fa-lock'], ['secure', 'private', 'password']],
    ['unlock', lockBody + p('M7 11V7a5 5 0 0 1 9.9-1'), '🔓', '[ ]', ['md-lock_open_variant_outline', 'md-lock_open_outline', 'fa-lock_open'], ['open-lock']],
    ['key', c(7.5, 15.5, 5.5) + p('m11.5 11.5 9-9M15.5 7.5l3 3L22 7l-3-3'), '🔑', 'o-', ['md-key_outline', 'md-key', 'fa-key'], ['password', 'credential']],
    ['eye', p('M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z') + c(12, 12, 3), '👁', 'o', ['md-eye_outline', 'md-eye', 'fa-eye'], ['view', 'show', 'visible']],
    ['eye-off', p('M9.9 4.2A10 10 0 0 1 12 4c6.5 0 10 8 10 8a17 17 0 0 1-2.2 3.2M6.6 6.6A17 17 0 0 0 2 12s3.5 8 10 8a9.7 9.7 0 0 0 5.4-1.6M14.1 14.1a3 3 0 0 1-4.2-4.2M2 2l20 20'), '🙈', '-o-', ['md-eye_off_outline', 'md-eye_off', 'fa-eye_slash'], ['hide', 'hidden', 'invisible']],
    ['pin', p('M12 17v5M9 10.8V4h6v6.8l3 3.2v3H6v-3z') + p('M8 4h8'), '📌', '-|', ['md-pin_outline', 'md-pin', 'fa-thumbtack'], ['thumbtack']],
    ['bookmark', p('m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z'), '🔖', '[]>', ['md-bookmark_outline', 'md-bookmark', 'fa-bookmark'], ['save-for-later']],
    ['star', star, '★', '*', ['md-star_outline', 'md-star', 'fa-star'], ['favorite', 'rating']],
    ['heart', heartPath, '♥', '<3', ['md-heart_outline', 'md-heart', 'fa-heart'], ['love', 'like', 'favorite']],
    ['thumbs-up', p('M7 10v12M15 5.9 14 10h5.8a2 2 0 0 1 2 2.3l-1.4 8A2 2 0 0 1 18.4 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.8a2 2 0 0 0 1.8-1.1L12 2a3.1 3.1 0 0 1 3 3.9z'), '👍', '+1', ['md-thumb_up_outline', 'md-thumb_up', 'fa-thumbs_up'], ['like', 'approve']],
    ['thumbs-down', p('M17 14V2M9 18.1 10 14H4.2a2 2 0 0 1-2-2.3l1.4-8A2 2 0 0 1 5.6 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.8a2 2 0 0 0-1.8 1.1L12 22a3.1 3.1 0 0 1-3-3.9z'), '👎', '-1', ['md-thumb_down_outline', 'md-thumb_down', 'fa-thumbs_down'], ['dislike']],
    ['flag', p('M4 22V4s1-1 4-1 5 2 8 2 4-1 4-1v12s-1 1-4 1-5-2-8-2-4 1-4 1'), '⚑', '|>', ['md-flag_outline', 'md-flag', 'fa-flag'], ['report']],
    ['tag', p('M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z') + dot(7.5, 7.5), '🏷', '#', ['md-tag_outline', 'md-tag', 'fa-tag'], ['label']],
    ['archive', r(2, 3, 20, 5, 1) + p('M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4'), '🗄', '[_]', ['md-archive_outline', 'md-archive', 'fa-box_archive']],
    ['inbox', p('M22 12h-6l-2 3h-4l-2-3H2') + p('M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z'), '📥', '[v]', ['md-inbox', 'fa-inbox']],
    ['send', p('M22 2 11 13M22 2l-7 20-4-9-9-4z'), '➤', '>>', ['md-send_outline', 'md-send', 'fa-paper_plane'], ['submit', 'paper-plane']],
    ['reply', p('M9 17 4 12l5-5') + p('M20 18v-2a4 4 0 0 0-4-4H4'), '↩', '<-', ['md-reply', 'fa-reply'], ['respond']],
    ['forward', p('m15 17 5-5-5-5') + p('M4 18v-2a4 4 0 0 1 4-4h12'), '↪', '->', ['md-share', 'fa-share'], []],
    ['log-in', p('M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3'), '⇥', '->|', ['md-login', 'fa-right_to_bracket'], ['sign-in', 'enter']],
    ['log-out', p('M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9'), '⇤', '|->', ['md-logout', 'fa-right_from_bracket'], ['sign-out', 'exit']],
    ['power', p('M12 2v10') + p('M18.4 6.6a9 9 0 1 1-12.8 0'), '⏻', '(|)', ['md-power', 'fa-power_off'], ['shutdown', 'on-off']],
    ['grid', r(3, 3, 7, 7, 1) + r(14, 3, 7, 7, 1) + r(14, 14, 7, 7, 1) + r(3, 14, 7, 7, 1), '▦', '::', ['md-view_grid_outline', 'md-view_grid', 'fa-table_cells_large'], ['apps', 'tiles']],
    ['list', p('M8 6h13M8 12h13M8 18h13') + dot(3, 6) + dot(3, 12) + dot(3, 18), '☷', '-=', ['md-format_list_bulleted', 'fa-list'], ['rows']],
    ['grip', dot(9, 5) + dot(9, 12) + dot(9, 19) + dot(15, 5) + dot(15, 12) + dot(15, 19), '⠿', '::', ['md-drag', 'fa-grip_vertical'], ['drag', 'handle']],
    ['link', p('M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7') + p('M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7'), '🔗', '~', ['md-link_variant', 'md-link', 'fa-link'], ['url', 'hyperlink', 'chain']],
    ['unlink', p('m18.8 13.4 1.7-1.7a5 5 0 0 0-7-7l-1.7 1.7M5.2 10.6l-1.7 1.7a5 5 0 0 0 7 7l1.7-1.7M8 2v3M2 8h3M16 22v-3M22 16h-3'), '⛓', '~/', ['md-link_variant_off', 'md-link_off', 'fa-link_slash'], ['broken-link']],
  ]),

  ...group('navigation', [
    ['home', p('m3 10 9-7 9 7v10a2 2 0 0 1-2 2h-4v-7h-6v7H5a2 2 0 0 1-2-2z'), '🏠', '~', ['md-home_outline', 'md-home', 'fa-house'], ['house', 'start']],
    ['arrow-up', p('M12 19V5M5 12l7-7 7 7'), '↑', '^', ['md-arrow_up', 'fa-arrow_up']],
    ['arrow-down', p('M12 5v14M19 12l-7 7-7-7'), '↓', 'v', ['md-arrow_down', 'fa-arrow_down']],
    ['arrow-left', p('M19 12H5M12 19l-7-7 7-7'), '←', '<-', ['md-arrow_left', 'fa-arrow_left'], ['back']],
    ['arrow-right', p('M5 12h14M12 5l7 7-7 7'), '→', '->', ['md-arrow_right', 'fa-arrow_right'], ['next']],
    ['arrow-up-right', p('M7 17 17 7M7 7h10v10'), '↗', '/^', ['md-arrow_top_right', 'fa-arrow_up_right']],
    ['chevron-up', p('m18 15-6-6-6 6'), '⌃', '^', ['md-chevron_up', 'fa-chevron_up']],
    ['chevron-down', p('m6 9 6 6 6-6'), '⌄', 'v', ['md-chevron_down', 'fa-chevron_down'], ['expand']],
    ['chevron-left', p('m15 18-6-6 6-6'), '‹', '<', ['md-chevron_left', 'fa-chevron_left']],
    ['chevron-right', p('m9 18 6-6-6-6'), '›', '>', ['md-chevron_right', 'fa-chevron_right']],
    ['chevrons-left', p('m11 17-5-5 5-5M18 17l-5-5 5-5'), '«', '<<', ['md-chevron_double_left', 'fa-angles_left'], ['first']],
    ['chevrons-right', p('m13 17 5-5-5-5M6 17l5-5-5-5'), '»', '>>', ['md-chevron_double_right', 'fa-angles_right'], ['last']],
    ['enter', p('M20 4v7a4 4 0 0 1-4 4H4') + p('m9 10-5 5 5 5'), '↵', '<-|', ['md-keyboard_return', 'fa-arrow_turn_down'], ['return', 'corner-down-left']],
    ['sidebar', r(3, 3, 18, 18) + p('M9 3v18'), '▥', '|=', ['md-dock_left', 'fa-table_columns'], ['panel', 'drawer']],
    ['compass', circleI + p('m16.2 7.8-2.1 6.3-6.3 2.1 2.1-6.3z'), '🧭', '(N)', ['md-compass_outline', 'md-compass', 'fa-compass'], ['explore']],
    ['map', p('M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z') + p('M9 4v14M15 6v14'), '🗺', '[#]', ['md-map_outline', 'md-map', 'fa-map']],
    ['map-pin', p('M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z') + c(12, 10, 3), '📍', '@', ['md-map_marker_outline', 'md-map_marker', 'fa-location_dot'], ['location', 'place', 'address']],
    ['navigation', p('m3 11 19-9-9 19-2-8z'), '➶', '>', ['md-navigation_variant_outline', 'md-navigation', 'fa-location_arrow'], ['gps', 'direction']],
    ['globe', circleI + p('M2 12h20M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10z'), '🌐', '(#)', ['md-web', 'md-earth', 'fa-globe'], ['world', 'web', 'website', 'internet']],
    ['layers', p('m12 2 10 5-10 5L2 7z') + p('m2 17 10 5 10-5M2 12l10 5 10-5'), '☰', '=', ['md-layers_outline', 'md-layers', 'fa-layer_group'], ['stack']],
  ]),

  ...group('communication', [
    ['mail', envelope, '✉', '@', ['md-email_outline', 'md-email', 'fa-envelope'], ['email', 'envelope', 'message', 'inbox']],
    ['mail-open', p('M21.2 8.4c.5.4.8 1 .8 1.6v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 .8-1.6l8-6a2 2 0 0 1 2.4 0z') + p('m22 10-10 7L2 10'), '📨', '@', ['md-email_open_outline', 'md-email_open', 'fa-envelope_open'], ['email-read']],
    ['phone', handset, '☎', 'tel', ['md-phone_outline', 'md-phone', 'fa-phone'], ['call', 'telephone']],
    ['phone-call', handset + p('M14.1 2a9 9 0 0 1 7.9 7.9M14.1 6a5 5 0 0 1 3.9 3.9'), '📞', 'tel', ['md-phone_in_talk_outline', 'md-phone_in_talk', 'fa-phone_volume'], ['calling', 'ringing']],
    ['phone-off', p('M10.7 13.3a16 16 0 0 0 3.4 2.6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.4 19.4 0 0 1-3.3-2.7M5.2 13.2A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9M22 2 2 22'), '📵', 'x-t', ['md-phone_off_outline', 'md-phone_off', 'fa-phone_slash'], ['hang-up']],
    ['sms', square + p('M8 10h.01M12 10h.01M16 10h.01'), '💬', 'sms', ['md-message_processing_outline', 'md-message_text_outline', 'fa-comment_sms'], ['text-message', 'message-square']],
    ['chat', bubble, '💬', '()', ['md-chat_outline', 'md-chat', 'fa-comment'], ['message', 'comment', 'talk', 'conversation']],
    ['chat-dots', bubble + dot(8, 11.5) + dot(12, 11.5) + dot(16, 11.5), '💬', '(..)', ['md-chat_processing_outline', 'md-chat_processing', 'fa-comment_dots'], ['typing']],
    ['at', c(12, 12, 4) + p('M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8'), '@', '@', ['md-at', 'fa-at'], ['at-sign', 'mention', 'handle', 'email-address']],
    ['voicemail', c(6, 12, 4) + c(18, 12, 4) + p('M6 16h12'), '⌨', 'oo', ['md-voicemail', 'fa-voicemail']],
    ['video', p('m16 13 6 4V7l-6 4') + r(2, 5, 14, 14), '📹', '[>', ['md-video_outline', 'md-video', 'fa-video'], ['camera-video', 'video-call']],
    ['mic', r(9, 2, 6, 12, 3) + p('M19 10v2a7 7 0 0 1-14 0v-2M12 19v3'), '🎤', 'mic', ['md-microphone_outline', 'md-microphone', 'fa-microphone'], ['microphone', 'record', 'voice']],
    ['mic-off', p('M2 2l20 20M18.9 13a7 7 0 0 0 .1-1v-2M5 10v2a7 7 0 0 0 12 5M15 9.3V5a3 3 0 0 0-5.7-1.3M9 9v3a3 3 0 0 0 5.1 2.1M12 19v3'), '🔇', 'x-m', ['md-microphone_off', 'fa-microphone_slash'], ['mute-mic']],
    ['bell', bell, '🔔', '(!)', ['md-bell_outline', 'md-bell', 'fa-bell'], ['notification', 'alert', 'alarm']],
    ['bell-off', p('M8.7 3A6 6 0 0 1 18 8c0 2.7.4 4.6 1 6M17 17H3s3-2 3-9a4.7 4.7 0 0 1 .3-1.7M10.3 21a1.9 1.9 0 0 0 3.4 0M2 2l20 20'), '🔕', '(x)', ['md-bell_off_outline', 'md-bell_off', 'fa-bell_slash'], ['mute', 'silent']],
    ['megaphone', p('M3 10v4a1 1 0 0 0 1 1h3l9 5V4L7 9H4a1 1 0 0 0-1 1zM20 9a4 4 0 0 1 0 6M8 15l1.5 5'), '📣', '<|', ['md-bullhorn_outline', 'md-bullhorn', 'fa-bullhorn'], ['announce', 'broadcast']],
    ['rss', p('M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16') + c(5, 19, 1), '📡', 'rss', ['md-rss', 'fa-rss'], ['feed', 'subscribe']],
    ['contact', r(3, 2, 16, 20) + c(11, 10, 3) + p('M6 18a5 5 0 0 1 10 0M21 6v4M21 14v4'), '📇', '[@]', ['md-card_account_details_outline', 'md-contacts', 'fa-address_book'], ['address-book', 'contacts']],
    ['user', person, '👤', '@', ['md-account_outline', 'md-account', 'fa-user'], ['person', 'account', 'profile']],
    ['users', c(9, 7, 4) + p('M2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1M16 3.1a4 4 0 0 1 0 7.8M22 21v-1a6 6 0 0 0-4-5.7'), '👥', '@@', ['md-account_multiple_outline', 'md-account_multiple', 'fa-users'], ['people', 'team', 'group', 'members']],
    ['user-plus', c(9, 7, 4) + p('M2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1M19 8v6M22 11h-6'), '👤', '@+', ['md-account_plus_outline', 'md-account_plus', 'fa-user_plus'], ['add-user', 'invite', 'sign-up']],
    ['user-minus', c(9, 7, 4) + p('M2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1M22 11h-6'), '👤', '@-', ['md-account_minus_outline', 'md-account_minus', 'fa-user_minus'], ['remove-user']],
    ['user-check', c(9, 7, 4) + p('M2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1M16 11l2 2 4-4'), '👤', '@v', ['md-account_check_outline', 'md-account_check', 'fa-user_check'], ['verified-user']],
    ['user-circle', circleI + c(12, 10, 3) + p('M6.2 18.8a7 7 0 0 1 11.6 0'), '👤', '(@)', ['md-account_circle_outline', 'md-account_circle', 'fa-circle_user'], ['avatar']],
    ['id-card', cardBody + c(8, 11, 2) + p('M5 16a3 3 0 0 1 6 0M14 10h5M14 14h4'), '🪪', '[id]', ['md-card_account_details_outline', 'md-card_account_details', 'fa-id_card'], ['identity', 'badge', 'license']],
  ]),

  ...group('media', [
    ['play', p('m6 3 14 9-14 9z'), '▶', '>', ['md-play', 'fa-play'], ['start', 'run']],
    ['pause', r(6, 4, 4, 16, 1) + r(14, 4, 4, 16, 1), '⏸', '||', ['md-pause', 'fa-pause']],
    ['stop', r(5, 5, 14, 14), '⏹', '[]', ['md-stop', 'fa-stop']],
    ['skip-forward', p('m5 4 10 8-10 8zM19 5v14'), '⏭', '>|', ['md-skip_next', 'fa-forward_step'], ['next-track']],
    ['skip-back', p('m19 20-10-8 10-8zM5 19V5'), '⏮', '|<', ['md-skip_previous', 'fa-backward_step'], ['previous-track']],
    ['fast-forward', p('m13 19 9-7-9-7zM2 19l9-7-9-7z'), '⏩', '>>', ['md-fast_forward', 'fa-forward']],
    ['rewind', p('m11 19-9-7 9-7zM22 19l-9-7 9-7z'), '⏪', '<<', ['md-rewind', 'fa-backward']],
    ['repeat', p('m17 2 4 4-4 4') + p('M3 11V10a4 4 0 0 1 4-4h14M7 22l-4-4 4-4') + p('M21 13v1a4 4 0 0 1-4 4H3'), '🔁', '<->', ['md-repeat', 'fa-repeat'], ['loop']],
    ['shuffle', p('M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6A4 4 0 0 1 16.1 6H22M18 2l4 4-4 4M2 6h1.9c1.5 0 2.9.9 3.6 2.2M22 18h-5.9a4 4 0 0 1-3.3-1.7l-.4-.5M18 14l4 4-4 4'), '🔀', '><', ['md-shuffle_variant', 'md-shuffle', 'fa-shuffle'], ['random']],
    ['volume', speaker + volWaves, '🔊', '<))', ['md-volume_high', 'fa-volume_high'], ['sound', 'audio', 'speaker']],
    ['volume-low', speaker + p('M15.5 8.5a5 5 0 0 1 0 7'), '🔉', '<)', ['md-volume_medium', 'fa-volume_low']],
    ['volume-off', speaker + p('m22 9-6 6M16 9l6 6'), '🔇', '<x', ['md-volume_off', 'fa-volume_xmark'], ['mute', 'silent']],
    ['music', p('M9 18V5l12-2v13') + c(6, 18, 3) + c(18, 16, 3), '🎵', '#', ['md-music_note', 'md-music', 'fa-music'], ['song', 'audio', 'note']],
    ['headphones', p('M3 18v-6a9 9 0 0 1 18 0v6') + p('M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z'), '🎧', 'hp', ['md-headphones', 'fa-headphones'], ['listen', 'audio']],
    ['camera', p('M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z') + c(12, 13, 3), '📷', '[o]', ['md-camera_outline', 'md-camera', 'fa-camera'], ['photo', 'picture']],
    ['image', r(3, 3, 18, 18) + c(9, 9, 2) + p('m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21'), '🖼', '[^]', ['md-image_outline', 'md-image', 'fa-image'], ['picture', 'photo', 'gallery']],
    ['film', r(2, 2, 20, 20) + p('M7 3v18M17 3v18M3 7.5h4M3 12h18M3 16.5h4M17 7.5h4M17 16.5h4'), '🎞', '[#]', ['md-filmstrip', 'fa-film'], ['movie', 'cinema']],
    ['radio', c(12, 12, 2) + p('M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19.1 4.9a10 10 0 0 1 0 14.2M4.9 19.1a10 10 0 0 1 0-14.2'), '📻', '(o)', ['md-access_point', 'fa-tower_broadcast'], ['broadcast', 'live', 'signal']],
    ['tv', r(2, 7, 20, 15) + p('m17 2-5 5-5-5'), '📺', '[_]', ['md-television', 'fa-tv'], ['television']],
    ['cast', p('M2 16.1A5 5 0 0 1 5.9 20M2 12.1A9 9 0 0 1 9.9 20M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6') + dot(2, 20), '📡', '))', ['md-cast', 'fa-chromecast'], ['screen-share']],
  ]),

  ...group('file', [
    ['file', doc, '📄', '[f]', ['md-file_outline', 'md-file', 'fa-file'], ['document', 'page']],
    ['file-text', doc + p('M16 13H8M16 17H8M10 9H8'), '📄', '[t]', ['md-file_document_outline', 'md-file_document', 'fa-file_lines'], ['document-text', 'text-file']],
    ['file-plus', doc + p('M12 18v-6M9 15h6'), '📄', '[+]', ['md-file_plus_outline', 'md-file_plus', 'fa-file_circle_plus'], ['new-file']],
    ['file-code', doc + p('m10 13-2 2 2 2M14 17l2-2-2-2'), '📄', '[<>]', ['md-file_code_outline', 'md-file_code', 'fa-file_code'], ['source']],
    ['folder', folder, '📁', '[d]', ['md-folder_outline', 'md-folder', 'fa-folder'], ['directory']],
    ['folder-open', p('m6 14 1.5-2.9A2 2 0 0 1 9.2 10H20a2 2 0 0 1 1.9 2.5l-1.5 6A2 2 0 0 1 18.4 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.7.9l.8 1.2a2 2 0 0 0 1.7.9H18a2 2 0 0 1 2 2v2'), '📂', '[d]', ['md-folder_open_outline', 'md-folder_open', 'fa-folder_open']],
    ['folder-plus', folder + p('M12 10v6M9 13h6'), '📁', '[d+]', ['md-folder_plus_outline', 'md-folder_plus', 'fa-folder_plus'], ['new-folder']],
    ['paperclip', p('m21.4 11-9.2 9.2a6 6 0 0 1-8.5-8.5l8.6-8.6a4 4 0 0 1 5.7 5.7l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.5-8.5'), '📎', '0/', ['md-paperclip', 'fa-paperclip'], ['attachment', 'attach']],
    ['cloud', cloud, '☁', '(~)', ['md-cloud_outline', 'md-cloud', 'fa-cloud']],
    ['cloud-upload', cloud + p('M12 12v6M9 15l3-3 3 3'), '☁', '(^)', ['md-cloud_upload_outline', 'md-cloud_upload', 'fa-cloud_arrow_up']],
    ['cloud-download', cloud + p('M12 12v6M9 15l3 3 3-3'), '☁', '(v)', ['md-cloud_download_outline', 'md-cloud_download', 'fa-cloud_arrow_down']],
    ['database', p('M3 5v14a9 3 0 0 0 18 0V5M3 12a9 3 0 0 0 18 0') + '<ellipse cx="12" cy="5" rx="9" ry="3"/>', '🛢', '[=]', ['md-database_outline', 'md-database', 'fa-database'], ['db', 'storage', 'sql']],
    ['server', r(2, 2, 20, 8) + r(2, 14, 20, 8) + dot(6, 6) + dot(6, 18), '🖥', '[:]', ['md-server', 'fa-server'], ['host', 'rack']],
    ['hard-drive', p('M22 12H2M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z') + dot(6, 16) + dot(10, 16), '🖴', '[o]', ['md-harddisk', 'fa-hard_drive'], ['disk', 'storage']],
    ['package', p('M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.7z') + p('M3.3 7 12 12l8.7-5M12 22V12M7.5 4.2l9 5.2'), '📦', '[#]', ['md-package_variant_closed', 'md-package', 'fa-box'], ['box', 'module', 'npm-package']],
    ['book', p('M4 19.5V5a2 2 0 0 1 2-2h14v18H6.5a2.5 2.5 0 0 1 0-5H20'), '📕', '[B]', ['md-book_outline', 'md-book', 'fa-book'], ['docs', 'manual', 'read']],
    ['book-open', p('M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2zM22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z'), '📖', '[]', ['md-book_open_outline', 'md-book_open_page_variant', 'fa-book_open'], ['docs', 'reading']],
    ['newspaper', p('M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2') + p('M18 14h-8M15 18h-5') + r(10, 6, 8, 4, 1), '📰', '[n]', ['md-newspaper_variant_outline', 'md-newspaper', 'fa-newspaper'], ['news', 'article', 'blog']],
  ]),

  ...group('status', [
    ['info', circleI + p('M12 16v-4') + dot(12, 8), 'ℹ', 'i', ['md-information_outline', 'md-information', 'fa-circle_info'], ['information', 'about']],
    ['warning', tri + p('M12 9v4') + dot(12, 17), '⚠', '!', ['md-alert_outline', 'md-alert', 'fa-triangle_exclamation'], ['alert', 'caution', 'alert-triangle']],
    ['error', circleI + p('M12 8v4') + dot(12, 16), '⛔', '!!', ['md-alert_circle_outline', 'md-alert_circle', 'fa-circle_exclamation'], ['alert-circle', 'danger', 'failure']],
    ['help', circleI + p('M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3') + dot(12, 17), '❓', '?', ['md-help_circle_outline', 'md-help_circle', 'fa-circle_question'], ['question', 'support', 'faq']],
    ['ban', circleI + p('m4.9 4.9 14.2 14.2'), '🚫', '(/)', ['md-cancel', 'fa-ban'], ['blocked', 'forbidden', 'prohibited']],
    ['loader', rays(8, 4, 9, 12, 12, -Math.PI / 2), '◌', '...', ['md-loading', 'fa-spinner'], ['spinner', 'loading', 'busy']],
    ['clock', clockFace, '🕒', '(t)', ['md-clock_outline', 'md-clock', 'fa-clock'], ['time']],
    ['hourglass', p('M5 22h14M5 2h14M17 22v-4.2a2 2 0 0 0-.6-1.4L12 12l-4.4 4.4a2 2 0 0 0-.6 1.4V22M7 2v4.2a2 2 0 0 0 .6 1.4L12 12l4.4-4.4a2 2 0 0 0 .6-1.4V2'), '⏳', '8', ['md-timer_sand', 'fa-hourglass_half'], ['wait', 'pending']],
    ['activity', p('M22 12h-4l-3 9L9 3l-3 9H2'), '📈', '/\\/', ['md-pulse', 'fa-heart_pulse'], ['pulse', 'health', 'monitor']],
    ['zap', p('M13 2 3 14h9l-1 8 10-12h-9z'), '⚡', '/', ['md-lightning_bolt_outline', 'md-lightning_bolt', 'fa-bolt'], ['bolt', 'lightning', 'fast', 'power']],
    ['shield', shield, '🛡', '[S]', ['md-shield_outline', 'md-shield', 'fa-shield'], ['security', 'protection']],
    ['shield-check', shield + p('m9 12 2 2 4-4'), '🛡', '[v]', ['md-shield_check_outline', 'md-shield_check', 'fa-shield_halved'], ['secure', 'verified', 'protected']],
    ['bug', p('M8 2l1.9 1.9M16 2l-1.9 1.9M9 7.1V6a3 3 0 1 1 6 0v1.1') + p('M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6zM12 20v-9M6.5 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M20.97 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4'), '🐛', 'bug', ['md-bug_outline', 'md-bug', 'fa-bug'], ['issue', 'defect']],
    ['sparkles', p('M9.9 15.5A2 2 0 0 0 8.5 14l-6.1-1.6a.5.5 0 0 1 0-1L8.5 9.9A2 2 0 0 0 9.9 8.5l1.6-6.1a.5.5 0 0 1 1 0l1.6 6.1a2 2 0 0 0 1.4 1.4l6.1 1.6a.5.5 0 0 1 0 1l-6.1 1.6a2 2 0 0 0-1.4 1.4l-1.6 6.1a.5.5 0 0 1-1 0z') + p('M20 3v4M22 5h-4'), '✨', '*+', ['md-creation', 'md-shimmer', 'fa-wand_magic_sparkles'], ['ai', 'magic', 'new']],
    ['checkbox', r(3, 3, 18, 18) + p('m9 12 2 2 4-4'), '☑', '[x]', ['md-checkbox_marked_outline', 'md-checkbox_marked', 'fa-square_check'], ['checked', 'check-square']],
    ['checkbox-empty', r(3, 3, 18, 18), '☐', '[ ]', ['md-checkbox_blank_outline', 'fa-square'], ['unchecked', 'square']],
    ['radio-on', circleI + c(12, 12, 4), '◉', '(*)', ['md-radiobox_marked', 'fa-circle_dot'], ['selected']],
    ['radio-off', circleI, '○', '( )', ['md-radiobox_blank', 'fa-circle'], ['circle', 'unselected']],
    ['toggle-on', r(1, 6, 22, 12, 6) + c(17, 12, 3), '🔘', '[=o]', ['md-toggle_switch', 'fa-toggle_on'], ['switch-on', 'enabled']],
    ['toggle-off', r(1, 6, 22, 12, 6) + c(7, 12, 3), '🔘', '[o=]', ['md-toggle_switch_off_outline', 'md-toggle_switch_off', 'fa-toggle_off'], ['switch-off', 'disabled']],
    ['online', c(12, 12, 4) + c(12, 12, 9), '🟢', '(o)', ['md-circle_slice_8', 'md-record_circle_outline'], ['status', 'presence', 'live']],
  ]),

  ...group('time', [
    ['calendar', cal, '📅', '[=]', ['md-calendar_blank_outline', 'md-calendar', 'fa-calendar'], ['date', 'schedule', 'event']],
    ['calendar-check', cal + p('m9 16 2 2 4-4'), '📅', '[v]', ['md-calendar_check_outline', 'md-calendar_check', 'fa-calendar_check'], ['booked']],
    ['calendar-plus', cal + p('M12 14v6M9 17h6'), '📅', '[+]', ['md-calendar_plus', 'fa-calendar_plus'], ['add-event']],
    ['alarm', c(12, 13, 8) + p('M12 9v4l2 2M5 3 2 6M22 6l-3-3M6.4 19.1 4 21M17.6 19.1 20 21'), '⏰', '(!)', ['md-alarm', 'fa-stopwatch'], ['alarm-clock', 'reminder', 'wake']],
    ['timer', c(12, 14, 8) + p('M10 2h4M12 14l3-3'), '⏱', '(:)', ['md-timer_outline', 'md-timer', 'fa-stopwatch_20'], ['stopwatch', 'countdown']],
    ['history', p('M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l4 2'), '🕘', '<(t)', ['md-history', 'fa-clock_rotate_left'], ['recent', 'past', 'log']],
  ]),

  ...group('commerce', [
    ['cart', c(8, 21, 1) + c(19, 21, 1) + p('M2 2h3l2.7 12.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 1.9-1.6L23 6H6'), '🛒', '\\_/', ['md-cart_outline', 'md-cart', 'fa-cart_shopping'], ['shopping-cart', 'basket', 'checkout']],
    ['bag', p('M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4zM3 6h18M16 10a4 4 0 0 1-8 0'), '🛍', '[u]', ['md-shopping_outline', 'md-shopping', 'fa-bag_shopping'], ['shopping-bag', 'shop']],
    ['credit-card', cardBody + p('M2 10h20M6 15h4'), '💳', '[=]', ['md-credit_card_outline', 'md-credit_card', 'fa-credit_card'], ['payment', 'card', 'billing']],
    ['wallet', p('M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1') + p('M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4'), '👛', '[$]', ['md-wallet_outline', 'md-wallet', 'fa-wallet'], ['money', 'crypto-wallet']],
    ['dollar', p('M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6'), '$', '$', ['md-currency_usd', 'fa-dollar_sign'], ['money', 'price', 'usd', 'currency']],
    ['receipt', p('M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z') + p('M16 8H8M16 12H8M13 16H8'), '🧾', '[$]', ['md-receipt', 'fa-receipt'], ['invoice', 'bill', 'order']],
    ['gift', r(3, 8, 18, 4, 1) + p('M12 8v13M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5'), '🎁', '[+]', ['md-gift_outline', 'md-gift', 'fa-gift'], ['present', 'reward']],
    ['store', p('m2 7 2-4h16l2 4M4 7v13a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V7M15 21v-6H9v6') + p('M2 7h20v1a3 3 0 0 1-5 2.2A3 3 0 0 1 12 10a3 3 0 0 1-5 .2A3 3 0 0 1 2 8z'), '🏪', '[S]', ['md-storefront_outline', 'md-store', 'fa-store'], ['shop', 'marketplace']],
    ['truck', p('M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2M15 18H9M19 18h2a1 1 0 0 0 1-1v-3.7a1 1 0 0 0-.2-.6l-3.5-4.3A1 1 0 0 0 17.5 8H14') + c(17, 18, 2) + c(7, 18, 2), '🚚', '[=o', ['md-truck_outline', 'md-truck', 'fa-truck'], ['shipping', 'delivery']],
    ['percent', p('M19 5 5 19') + c(6.5, 6.5, 2.5) + c(17.5, 17.5, 2.5), '%', '%', ['md-percent', 'fa-percent'], ['discount', 'sale', 'coupon']],
    ['coins', c(9, 9, 6) + p('M18.1 10.4A6 6 0 1 1 10.4 18.1'), '🪙', '(o)', ['md-hand_coin_outline', 'md-circle_multiple_outline', 'fa-coins'], ['money', 'tokens', 'credits']],
    ['barcode', p('M3 5v14M8 5v14M12 5v14M17 5v14M21 5v14'), '▥', '|||', ['md-barcode', 'fa-barcode'], ['scan', 'sku']],
    ['qr-code', r(3, 3, 7, 7, 1) + r(14, 3, 7, 7, 1) + r(3, 14, 7, 7, 1) + p('M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3'), '▦', '[#]', ['md-qrcode', 'fa-qrcode'], ['qr', 'scan']],
  ]),

  ...group('dev', [
    ['terminal', p('m4 17 6-6-6-6M12 19h8'), '⌨', '>_', ['md-console', 'oct-terminal', 'fa-terminal'], ['console', 'shell', 'command-line', 'cli']],
    ['code', p('m16 18 6-6-6-6M8 6l-6 6 6 6'), '⟨⟩', '</>', ['md-code_tags', 'fa-code'], ['source', 'html', 'develop']],
    ['braces', p('M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1M16 21h1a2 2 0 0 0 2-2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1'), '{}', '{}', ['md-code_braces', 'cod-json'], ['json', 'object', 'curly']],
    ['git-branch', node(6, 18) + node(18, 6) + p('M6 3v12M18 9a9 9 0 0 1-9 9'), '⎇', 'Y', ['oct-git_branch', 'md-source_branch', 'fa-code_branch'], ['branch']],
    ['git-commit', c(12, 12, 3) + p('M3 12h6M15 12h6'), '⊸', '-o-', ['oct-git_commit', 'md-source_commit', 'fa-code_commit'], ['commit']],
    ['git-merge', node(18, 18) + node(6, 6) + p('M6 21V9a9 9 0 0 0 9 9'), '⑂', '>-', ['oct-git_merge', 'md-source_merge', 'fa-code_merge'], ['merge']],
    ['git-pull-request', node(18, 18) + node(6, 6) + p('M13 6h3a2 2 0 0 1 2 2v7M6 9v12'), '⇄', 'PR', ['oct-git_pull_request', 'md-source_pull', 'fa-code_pull_request'], ['pull-request', 'pr', 'merge-request']],
    ['cpu', r(4, 4, 16, 16) + r(9, 9, 6, 6, 1) + p('M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2'), '🔲', '[#]', ['md-chip', 'oct-cpu', 'fa-microchip'], ['chip', 'processor', 'hardware']],
    ['command', p('M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3'), '⌘', 'cmd', ['md-apple_keyboard_command', 'fa-command'], ['cmd', 'shortcut', 'keyboard-shortcut']],
    ['hash', p('M4 9h16M4 15h16M10 3 8 21M16 3l-2 18'), '#', '#', ['md-pound', 'fa-hashtag'], ['hashtag', 'number', 'channel']],
    ['plug', p('M12 22v-5M9 8V2M15 8V2M18 8v5a6 6 0 0 1-6 6 6 6 0 0 1-6-6V8z'), '🔌', '-[', ['md-power_plug_outline', 'md-power_plug', 'fa-plug'], ['integration', 'connect', 'api']],
    ['webhook', p('M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2') + p('m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06') + p('m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8'), '🪝', '<~>', ['md-webhook', 'cod-plug'], ['callback', 'hook']],
    ['gauge', p('m12 14 4-4M3.3 19a10 10 0 1 1 17.4 0'), '⏲', '(/)', ['md-gauge', 'fa-gauge'], ['speed', 'performance', 'dashboard', 'meter']],
    ['flask', p('M9 3h6M10 3v7.5L4.4 19A2 2 0 0 0 6.1 22h11.8a2 2 0 0 0 1.7-3L14 10.5V3M7 15h10'), '⚗', '/_\\', ['md-flask_outline', 'md-flask', 'fa-flask'], ['test', 'experiment', 'lab', 'beta']],
    ['api', p('m2 17 3-10 3 10M3 14h4M11 17V7h3a2.5 2.5 0 0 1 0 5h-3M19 7v10M17 7h4M17 17h4'), '⚙', 'api', ['md-api', 'cod-symbol_interface'], ['endpoint', 'rest']],
    ['container', r(2, 6, 20, 12, 1) + p('M6 9v6M10 9v6M14 9v6M18 9v6'), '📦', '[c]', ['md-cube_outline', 'md-docker', 'fa-cube'], ['docker', 'cube', 'image']],
  ]),

  ...group('device', [
    ['laptop', p('M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.3 2.6a1 1 0 0 1-.9 1.4H3.6a1 1 0 0 1-.9-1.4L4 16'), '💻', '[_]', ['md-laptop', 'fa-laptop'], ['computer', 'notebook']],
    ['monitor', screen, '🖥', '[ ]', ['md-monitor', 'fa-desktop'], ['desktop', 'display', 'screen']],
    ['smartphone', r(5, 2, 14, 20) + dot(12, 18), '📱', '[.]', ['md-cellphone', 'fa-mobile_screen'], ['mobile', 'phone-device', 'cell']],
    ['tablet', r(4, 2, 16, 20) + dot(12, 18), '📱', '[..]', ['md-tablet', 'fa-tablet_screen_button'], ['ipad']],
    ['watch', c(12, 12, 6) + p('M12 10v2l1 1M16.1 7.5 15.4 3.2A2 2 0 0 0 13.4 2h-2.8a2 2 0 0 0-2 1.2L7.9 7.5M7.9 16.5l.7 4.3a2 2 0 0 0 2 1.2h2.8a2 2 0 0 0 2-1.2l.7-4.3'), '⌚', '(:)', ['md-watch', 'fa-clock'], ['smartwatch', 'wearable']],
    ['keyboard', r(2, 4, 20, 16) + p('M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10'), '⌨', '[kb]', ['md-keyboard_outline', 'md-keyboard', 'fa-keyboard'], ['typing', 'input']],
    ['mouse', r(5, 2, 14, 20, 7) + p('M12 6v4'), '🖱', '(|)', ['md-mouse', 'fa-computer_mouse'], ['pointer', 'click']],
    ['wifi', p('M5 12.9a10 10 0 0 1 14 0M8.5 16.4a5 5 0 0 1 7 0M2 8.8a15 15 0 0 1 20 0') + dot(12, 20), '📶', '((.', ['md-wifi', 'fa-wifi'], ['wireless', 'network', 'internet']],
    ['wifi-off', p('M12 20h.01M8.5 16.4a5 5 0 0 1 7 0M2 8.8a15 15 0 0 1 4.2-2.7M19 12.9a10 10 0 0 0-2.9-2M22 8.8a15 15 0 0 0-11.3-3.8M5 12.9a10 10 0 0 1 5.2-2.8M2 2l20 20'), '📵', 'x((', ['md-wifi_off', 'fa-wifi'], ['offline', 'no-network']],
    ['bluetooth', p('m7 7 10 10-5 5V2l5 5L7 17'), 'ᛒ', 'B', ['md-bluetooth', 'fa-bluetooth_b'], ['wireless', 'pair']],
    ['battery', r(2, 7, 16, 10) + p('M22 11v2M6 11v2M10 11v2'), '🔋', '[==', ['md-battery_outline', 'md-battery', 'fa-battery_half'], ['power', 'charge']],
    ['battery-charging', p('M15 7h1a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-2M6 7H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h1M11 7l-3 5h4l-3 5M22 11v2'), '🔌', '[=~', ['md-battery_charging', 'fa-battery_full'], ['charging']],
    ['cell-signal', p('M2 20h.01M7 20v-4M12 20v-8M17 20V8M22 4v16'), '📶', '.:|', ['md-signal', 'fa-signal'], ['bars', 'reception', 'cellular']],
  ]),

  ...group('editor', [
    ['bold', p('M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8'), '𝐁', 'B', ['md-format_bold', 'fa-bold'], ['strong']],
    ['italic', p('M19 4h-9M14 20H5M15 4 9 20'), '𝐼', '/', ['md-format_italic', 'fa-italic'], ['emphasis']],
    ['underline', p('M6 4v6a6 6 0 0 0 12 0V4M4 20h16'), 'U̲', '_', ['md-format_underline', 'fa-underline']],
    ['strikethrough', p('M16 4H9a3 3 0 0 0-2.8 4M14 12a4 4 0 0 1 0 8H6M4 12h16'), 'S̶', '-s-', ['md-format_strikethrough', 'fa-strikethrough']],
    ['heading', p('M6 12h12M6 20V4M18 20V4'), 'H', 'H', ['md-format_header_pound', 'fa-heading'], ['title', 'h1']],
    ['list-ordered', p('M10 6h11M10 12h11M10 18h11M4 6h1v4M4 10h2M6 18H4c0-1 2-2 2-3s-1-1.5-2-1'), '⒈', '1.', ['md-format_list_numbered', 'fa-list_ol'], ['numbered-list']],
    ['list-bullet', p('M9 6h12M9 12h12M9 18h12') + c(4, 6, 1) + c(4, 12, 1) + c(4, 18, 1), '•', '*', ['md-format_list_bulleted', 'fa-list_ul'], ['bullet-list', 'unordered-list']],
    ['quote', p('M3 21c3 0 7-1 7-8V5c0-1.3-.8-2-2-2H4c-1.3 0-2 .7-2 2v6c0 1.3.7 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 0-1 1v3c0 1 0 1 1 1zM15 21c3 0 7-1 7-8V5c0-1.3-.8-2-2-2h-4c-1.3 0-2 .7-2 2v6c0 1.3.7 2 2 2h.8c0 2.3.2 4-2.8 4v3c0 1 0 1 1 1z'), '❝', '"', ['md-format_quote_open', 'fa-quote_left'], ['blockquote', 'citation']],
    ['align-left', p('M21 6H3M15 12H3M17 18H3'), '⫷', '|=', ['md-format_align_left', 'fa-align_left']],
    ['align-center', p('M21 6H3M17 12H7M19 18H5'), '≡', '=', ['md-format_align_center', 'fa-align_center']],
    ['align-right', p('M21 6H3M21 12H9M21 18H7'), '⫸', '=|', ['md-format_align_right', 'fa-align_right']],
    ['type', p('M4 7V4h16v3M9 20h6M12 4v16'), 'T', 'T', ['md-format_text', 'fa-font'], ['text', 'font', 'typography']],
    ['table', r(3, 3, 18, 18) + p('M3 9h18M3 15h18M9 3v18M15 3v18'), '▦', '[#]', ['md-table', 'fa-table'], ['spreadsheet', 'grid-data']],
    ['image-plus', r(3, 3, 18, 18) + c(9, 9, 2) + p('m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21M16 5h6M19 2v6'), '🖼', '[+]', ['md-image_plus', 'fa-file_image'], ['add-image', 'insert-image']],
  ]),

  ...group('misc', [
    ['sun', c(12, 12, 4) + rays(8, 7, 10), '☀', '*', ['md-white_balance_sunny', 'fa-sun'], ['light-mode', 'day', 'weather']],
    ['moon', p('M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z'), '🌙', 'C', ['md-weather_night', 'fa-moon'], ['dark-mode', 'night']],
    ['theme', circleI + p('M12 2v20a10 10 0 0 0 0-20z'), '◐', '(|)', ['md-theme_light_dark', 'fa-circle_half_stroke'], ['contrast', 'appearance', 'light-dark']],
    ['thermometer', p('M14 14.8V4a2 2 0 0 0-4 0v10.8a4 4 0 1 0 4 0z'), '🌡', '|o', ['md-thermometer', 'fa-temperature_half'], ['temperature', 'weather']],
    ['droplet', p('M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5S12.5 5.5 12 3c-.5 2.5-2 4.9-4 6.5S5 13 5 15a7 7 0 0 0 7 7z'), '💧', 'o', ['md-water_outline', 'md-water', 'fa-droplet'], ['water', 'liquid', 'rain']],
    ['leaf', p('M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10z') + p('M2 21c0-3 1.9-5.4 5.1-6C9.5 14.5 12 13 13 12'), '🍃', '~', ['md-leaf', 'fa-leaf'], ['eco', 'nature', 'green']],
    ['building', r(4, 2, 16, 20) + p('M9 22v-4h6v4M8 6h.01M16 6h.01M12 6h.01M12 10h.01M12 14h.01M16 10h.01M16 14h.01M8 10h.01M8 14h.01'), '🏢', '[#]', ['md-office_building_outline', 'md-office_building', 'fa-building'], ['company', 'office', 'organization']],
    ['briefcase', r(2, 7, 20, 14) + p('M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16'), '💼', '[b]', ['md-briefcase_outline', 'md-briefcase', 'fa-briefcase'], ['work', 'job', 'business']],
    ['award', c(12, 8, 6) + p('M15.5 12.9 17 22l-5-3-5 3 1.5-9.1'), '🏅', '(*)', ['md-medal_outline', 'md-medal', 'fa-award'], ['badge', 'achievement', 'certificate']],
    ['trophy', p('M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.7V17c0 .6-.5 1-1 1.2C7.8 18.8 7 20.2 7 22M14 14.7V17c0 .6.5 1 1 1.2 1.2.6 2 2 2 3.8M18 2H6v7a6 6 0 0 0 12 0z'), '🏆', '\\_/', ['md-trophy_outline', 'md-trophy', 'fa-trophy'], ['winner', 'prize', 'leaderboard']],
    ['target', circleI + c(12, 12, 6) + c(12, 12, 2), '🎯', '(o)', ['md-target', 'fa-bullseye'], ['goal', 'aim', 'bullseye']],
    ['lightbulb', p('M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5M9 18h6M10 22h4'), '💡', 'i', ['md-lightbulb_outline', 'md-lightbulb', 'fa-lightbulb'], ['idea', 'tip', 'hint']],
    ['rocket', p('M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2.1-.1-2.9a2.2 2.2 0 0 0-2.9-.1z') + p('m12 15-3-3a22 22 0 0 1 2-3.9A12.9 12.9 0 0 1 22 2c0 2.7-.8 7.5-6 11a22.4 22.4 0 0 1-4 2z') + p('M9 12H4s.6-3 2-4c1.6-1.1 5 0 5 0M12 15v5s3-.6 4-2c1.1-1.6 0-5 0-5'), '🚀', '^', ['md-rocket_launch_outline', 'md-rocket', 'fa-rocket'], ['launch', 'deploy', 'ship', 'startup']],
    ['coffee', p('M17 8h1a4 4 0 1 1 0 8h-1M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4zM6 2v2M10 2v2M14 2v2'), '☕', 'c[_]', ['md-coffee_outline', 'md-coffee', 'fa-mug_hot'], ['cafe', 'break', 'donate']],
    ['puzzle', p('M19 13h1a2 2 0 1 0 0-4h-1V5a1 1 0 0 0-1-1h-4V3a2 2 0 1 0-4 0v1H6a1 1 0 0 0-1 1v4h1a2 2 0 1 1 0 4H5v5a1 1 0 0 0 1 1h4v-1a2 2 0 1 1 4 0v1h4a1 1 0 0 0 1-1z'), '🧩', '[+]', ['md-puzzle_outline', 'md-puzzle', 'fa-puzzle_piece'], ['plugin', 'extension', 'addon']],
    ['palette', p('M12 22a10 10 0 1 1 10-10c0 2.8-2.2 4-4 4h-2.5a1.5 1.5 0 0 0-1.1 2.5A1.5 1.5 0 0 1 12 22z') + dot(8, 11) + dot(10, 7) + dot(15, 7) + dot(17, 11), '🎨', '(:)', ['md-palette_outline', 'md-palette', 'fa-palette'], ['color', 'design', 'theme-color']],
    ['brush', p('m9.1 11.1 7.8-7.8a2.1 2.1 0 0 1 3 3l-7.8 7.8M7 14a3 3 0 0 0-3 3c0 1.3-2 2-2 3 2.7 0 5-1 5-4a3 3 0 0 0 0-2z'), '🖌', '/~', ['md-brush', 'fa-paintbrush'], ['paint', 'draw']],
    ['pen-tool', p('m12 19 7-7 3 3-7 7zM18 13l-1.5-7.5L2 2l3.5 14.5L13 18zM2 2l7.6 7.6') + c(11, 11, 2), '✒', '_/', ['md-fountain_pen_tip', 'fa-pen_nib'], ['vector', 'bezier']],
    ['ruler', p('M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.4 2.4 0 0 1 0-3.4l2.6-2.6a2.4 2.4 0 0 1 3.4 0zM14.5 12.5l2-2M11.5 9.5l2-2M8.5 6.5l2-2M17.5 15.5l2-2'), '📏', '|-|', ['md-ruler', 'fa-ruler'], ['measure']],
    ['crop', p('M6 2v14a2 2 0 0 0 2 2h14M18 22V8a2 2 0 0 0-2-2H2'), '⌗', '[_', ['md-crop', 'fa-crop_simple']],
    ['move', p('M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20'), '✥', '+', ['md-cursor_move', 'fa-up_down_left_right'], ['drag', 'pan', 'arrows']],
    ['crosshair', circleI + p('M22 12h-4M6 12H2M12 6V2M12 22v-4'), '⌖', '-+-', ['md-crosshairs', 'fa-crosshairs'], ['aim', 'precise', 'locate']],
    ['translate', p('m5 8 6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6'), '🌐', 'A/a', ['md-translate', 'fa-language'], ['language', 'i18n', 'localize']],
    ['accessibility', c(16, 4, 1) + p('m18 19 1-7-6 1M5 8l3-3 5.5 3-2.4 3.5M4.2 14.5a5 5 0 0 0 6.9 5.8M13.8 17.5a5 5 0 0 0-6.9-5.8'), '♿', 'a11y', ['md-human', 'fa-universal_access'], ['a11y', 'wheelchair', 'inclusive']],
    ['smile', circleI + p('M8 14s1.5 2 4 2 4-2 4-2') + dot(9, 9) + dot(15, 9), '🙂', ':)', ['md-emoticon_happy_outline', 'md-emoticon_outline', 'fa-face_smile'], ['emoji', 'happy', 'reaction']],
    ['frown', circleI + p('M16 16s-1.5-2-4-2-4 2-4 2') + dot(9, 9) + dot(15, 9), '🙁', ':(', ['md-emoticon_sad_outline', 'md-emoticon_sad', 'fa-face_frown'], ['sad', 'unhappy']],
    ['fingerprint', p('M2 12C2 6.5 6.5 2 12 2a10 10 0 0 1 8 4M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .3-2M17.3 21.5c.1-.7.7-3.5.7-5.5M12 12c0 4.5-1 8-2.5 10M14 13.1c0 2.5 0 5.5-.8 8.4M22 16c.5-2.4.5-5 0-7M8.7 22c.3-1 .7-2 .8-3M9 6.8a6 6 0 0 1 9 5.2v2'), '🫆', '(@)', ['md-fingerprint', 'fa-fingerprint'], ['biometric', 'passkey', 'touch-id']],
    ['anchor', c(12, 5, 3) + p('M12 22V8M5 12H2a10 10 0 0 0 20 0h-3'), '⚓', 't', ['md-anchor', 'fa-anchor'], ['link-anchor', 'marine']],
    ['umbrella', p('M22 12a10 10 0 0 0-20 0zM12 12v8a2 2 0 0 0 4 0'), '☂', 'T', ['md-umbrella_outline', 'md-umbrella', 'fa-umbrella'], ['insurance', 'rain', 'cover']],
  ]),
];
