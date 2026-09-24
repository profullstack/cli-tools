/**
 * The styles OpenIcon ships beside the canonical `simple` line set.
 *
 * `hq` came first and was drawn against glossy 3D emoji masters, which is
 * exactly what it looks like: specular hotspots, bevels, inflated bodies. It
 * stays, because plenty of surfaces want it, but it dates the set.
 *
 * The three `agentic-*` styles are the answer to that. They share one frame
 * (same composition, same silhouette pin, same 20px rule) and differ only in
 * the material paragraph, so the three can be compared honestly and a reader
 * can pick by surface rather than by taste:
 *
 *   agentic-matte      flat tonal planes, no gloss   — the general-purpose one
 *   agentic-machined   milled anodized aluminium     — hardware and rack UIs
 *   agentic-emissive   dark body, lit working part   — dark terminals only
 *
 * `agentic` on its own means `agentic-matte`: it is the only one of the three
 * that holds its colour coding at 20 pixels on a light ground as well as a
 * dark one, so it is the safe default for anything that is not known to be
 * dark-only.
 *
 * None of the three takes an emoji master as a reference. Their only reference
 * is the icon's own line glyph, which is what keeps `filter` a funnel; the
 * look comes from the prompt alone, and the hue from icon-palette.ts.
 */

import { accentFor, hqColorFor } from './icon-palette.ts';
import type { IconDef } from './icon-set.ts';
import { humanName } from './icon.ts';

/** Keys whose names mislead a model: say what the control is. */
export const DESCRIBE: Record<string, string> = {
  'radio-off': 'an empty, unselected radio button: a single ring with nothing inside (a form control, not a radio set)',
  'radio-on': 'a selected radio button: a ring with a solid dot in the middle (a form control)',
  'checkbox-empty': 'an empty, unchecked checkbox (a form control)',
  checkbox: 'a checked checkbox (a form control)',
  'toggle-on': 'a toggle switch in the on position (a form control)',
  'toggle-off': 'a toggle switch in the off position (a form control)',
  online: 'an online presence indicator: a solid dot inside a ring',
};

/** How an icon is named to the model: what it is, then what it is called. */
export function subjectLine(icon: IconDef): string {
  if (DESCRIBE[icon.key]) return `The icon: "${icon.key}", which is ${DESCRIBE[icon.key]}.`;
  const words = [humanName(icon.key).toLowerCase(), ...(icon.aliases ?? []), ...(icon.keywords ?? [])].slice(0, 6);
  return `The icon: "${icon.key}" (${words.join(', ')}), category ${icon.category}.`;
}

export interface StyleSpec {
  id: string;
  label: string;
  /** Where this style's files live inside the set. */
  dir: string;
  /** One line, for the manifest, the README and the set's index page. */
  material: string;
  /**
   * The ground this style needs. `dark` is a refusal a reader should honour:
   * emissive marks that emit neutral white are invisible on a white tile, so
   * a surface that cannot give them a dark ground should pick another style.
   */
  ground: 'light' | 'dark' | 'any';
  /** OpenEmoji masters used as style references; the agentic styles use none. */
  emojiRefs: readonly string[];
  /** The style paragraph, without the icon. */
  styleText: string;
  promptFor(icon: IconDef): string;
  /**
   * The prompt for a brand mark, or absent when this style does not restyle
   * marks at all. A brand is not drawn from a description the way a generic
   * icon is: the mark itself is the reference and the model's only job is to
   * re-render it in this style's material, in the owner's own colour. Every
   * rule that protects the drawn icons (keep the silhouette, add nothing, no
   * text) matters more here, not less.
   *
   * `hq` deliberately leaves this undefined: its brands stay the owner's flat
   * mark in the owner's colour, which is what the spec's rule 10 describes and
   * what a first-release reader already got. A style with no `promptForBrand`
   * falls back to that recolour, so adding one is the only switch needed to
   * bring another style's marks into the material.
   */
  promptForBrand?(brand: BrandSubject): string;
}

/** What a style needs to know about a brand to re-render its mark. */
export interface BrandSubject {
  key: string;
  title: string;
  /** The owner's published colour, when they publish one. */
  hex?: string;
}

export const HQ_STYLE = `Design one icon for a premium, original colour icon set that sits beside a glossy 3D emoji set as one family.
The FIRST reference image is this icon's line drawing: keep its exact silhouette, parts and meaning, and turn it into a solid, full-colour object. Where the line drawing outlines a shape (a triangle, a funnel, a square, a pin, a basket), fill that shape: a solid glass or enamel body, never a hollow tube tracing the outline. Only pure strokes (arrows, bars, plus and minus signs, chevrons) stay as rounded solid bars. Do not add or remove parts, do not change what it depicts, do not add text.
The OTHER reference images are the style to match exactly: soft-volume 3D with vector clarity, smooth rich gradients that model the form, one warm key light from the upper left with a crisp specular highlight, gentle ambient occlusion, a subtle darker rim on the lower-right edge, saturated harmonious colour. Do not copy their subjects.
Use the colour named below as the dominant colour, with small natural accents (white paper, steel, glass, gold) only where the object has them. Ignore the reference images' colours.
Composition: the single object, centred, filling about 84% of the square, front or slight three-quarter view, nothing cropped. Fully transparent background, no ground shadow, no badge, no frame, no backdrop.
It must stay instantly readable at 20 pixels. Every design is original: never resemble a logo, mascot or product from any brand, film or game.`;

/**
 * OpenEmoji masters the HQ icons take their look from: laptop, gem, light bulb.
 * Chosen for range: fire and rocket as references tinted every icon orange.
 */
export const STYLE_REFS = ['1f4bb.png', '1f48e.png', '1f4a1.png'] as const;

/** Shared by the agentic styles: everything except the material. */
export const AGENTIC_FRAME = `Design one icon for a premium, original icon set made for developer and agent tooling.
The reference image is this icon's line drawing: keep its exact silhouette, parts and meaning, and turn it into a solid object. Where the line drawing outlines a shape (a funnel, a square, a pin, a basket), fill that shape as a solid body, never a hollow tube tracing the outline. Only pure strokes (arrows, bars, plus and minus signs, chevrons) stay as rounded solid bars. Do not add or remove parts, do not change what it depicts, do not add text.
Composition: the single object, centred, filling about 84% of the square, straight-on front view, nothing cropped. Fully transparent background, no ground shadow, no badge, no frame, no backdrop.
It must stay instantly readable at 20 pixels. Every design is original: never resemble a logo, mascot or product from any brand, film or game.`;

/**
 * The frame for a brand mark. The drawn-icon frame ends by forbidding any
 * resemblance to a logo, which is exactly backwards here: the mark IS the
 * subject. What replaces that guard is a tighter one — reproduce this mark and
 * nothing else — because the only defensible way to restyle a trademark is to
 * change its material and never its geometry.
 */
export const BRAND_FRAME = `Re-render one existing logo mark as a solid object in a specific material.
The reference image is the mark itself. Reproduce its exact geometry: every shape, proportion, angle, counter and piece of negative space, in the same arrangement. This is the SAME mark in a new material, never a redesign: do not simplify it, do not stylise its shapes, do not add or remove parts, do not add text or lettering it does not have, do not place it on a badge, tile, rounded square or any container it does not already have.
Keep figure and ground exactly as the reference has them: where the mark is a solid shape with a cut-out counter inside it, the solid stays solid and the counter stays empty. Never invert them, never fill a counter, never hollow out a solid.
Keep the mark's colour. The material changes the surface, never the hue: a red mark stays red, a blue mark stays blue, a multi-coloured mark keeps each of its colours in the same places. Do not wash the mark to white, grey or a single neutral, and do not recolour it to match the material.
Composition: the mark alone, centred, filling about 84% of the square, straight-on front view, nothing cropped. Fully transparent background, no ground shadow, no frame, no backdrop.
It must stay instantly recognisable at 20 pixels.`;

/**
 * sRGB relative luminance, 0 (black) to 1 (white). Needed because a style that
 * works by emitting light has no answer for a mark whose own colour is black:
 * roughly fifteen of the set's marks are, and told to "glow in its own colour"
 * a model invents a hue instead (GitHub came back glowing blue).
 */
export function luminanceOf(hex: string): number {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** Below this a mark cannot carry a style that works by emitting light. */
export const DARK_MARK = 0.06;

/** Below this a colour has no hue left to lighten towards; white is honest. */
export const ACHROMATIC = 0.25;

/** HSV saturation, 0 (grey) to 1: how much hue a colour still has. */
export function saturationOf(hex: string): number {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255);
  const max = Math.max(...channels);
  return max === 0 ? 0 : (max - Math.min(...channels)) / max;
}

/**
 * What an emissive mark should give off. Of the set's 111 marks, 26 are too
 * dark to emit their own colour; 22 of those are achromatic (GitHub, Apple,
 * OpenAI — black, with no hue to raise) and 4 are simply dark but coloured
 * (Slack's aubergine, PayPal's navy), where a lightened tint of the brand's
 * own hue keeps the identity that plain white throws away.
 */
export type Emission = { kind: 'own'; hex: string } | { kind: 'tint'; hex: string } | { kind: 'neutral' };

export function emissionFor(hex: string | undefined): Emission {
  if (!hex) return { kind: 'neutral' };
  if (luminanceOf(hex) >= DARK_MARK) return { kind: 'own', hex };
  return saturationOf(hex) >= ACHROMATIC ? { kind: 'tint', hex } : { kind: 'neutral' };
}

/**
 * Each style's material, written for a mark rather than a drawn object, and
 * told the mark's colour outright. "Its own colour" is not enough: the agentic
 * family's register (engineered, graphite, dark) is strong enough on its own
 * that every one of six pilot marks came back black until the hex was named
 * here, in the material, rather than in a sentence beside it.
 */
const AGENTIC_BRAND_MATERIALS: Record<string, (colour: string | undefined, emission?: Emission) => string> = {
  matte: (hex) => `Style: matte flat-dimensional. ${
    hex
      ? `The mark's colour is ${hex}, and that colour fills the mark and dominates the whole image.`
      : `The mark is monochrome and stays monochrome.`
  } Build the mark from two or three FLAT tonal planes of that one colour — a lit face, a slightly darker shaded side where a form turns, a darker base — with hard, clean boundaries between them. The mark is a SOLID filled shape, never an outline. Do not render it graphite, charcoal, grey or black unless that is the colour named above. Absolutely no gloss: no specular highlight, no white hotspot, no shiny plastic, no glassy sheen, no bevel, no inflated 3D bubble, no soft blended gradient. Crisp geometric vector edges, one thin cooler edge-light along the top-left edge only. Restrained, modern, engineered.`,
  machined: (hex) => `Style: precision-machined hardware. The mark is milled from aluminium ${
    hex ? `anodized in ${hex}: that anodized colour covers the whole mark and dominates the image` : `left raw and unanodized, so it stays neutral metal`
  }. Very fine brushed texture along the faces, hairline chamfers where faces meet, soft even diffuse lighting from directly above. The mark is a SOLID milled shape, never an outline, and the surrounding background stays empty — the graphite of this style belongs to hardware bodies, not to a mark that has its own colour. No specular highlight, no glossy sheen, no shiny plastic, no glassy bubble, no soft blended gradient, no cartoon bevel. Tight tolerances, technical, industrial-grade.`,
  emissive: (hex, emission = emissionFor(hex)) => `Style: emissive dark instrument. The mark is a SOLID form that emits light: fill every solid area of the mark completely with the emitting material, and leave its cut-out counters empty. It is never a neon outline, never a hollow tube, never a thin glowing stroke tracing the edge of a shape that should be filled. ${
    emission.kind === 'own'
      ? `The mark emits ${emission.hex} — its own colour, and no other. It must not emit white, near-white or any hue the mark does not have.`
      : emission.kind === 'tint'
        ? `The mark's own colour, ${emission.hex}, is too dark to give off light, so it emits a brighter, lighter tint of that same hue — the same colour raised until it can carry light, never a different hue and never plain white.`
        : `The mark emits a clean neutral white light: its own colour is too dark and too close to grey to emit, so do not invent a hue for it.`
  } It sits on nothing: the background is fully transparent, and the glow falls away into that transparency. No gloss, no specular highlight, no shiny plastic, no glassy bubble, no soft blended gradient over the whole form; the only light in the image is the mark itself. Crisp vector edges. It reads like a lit panel in a dark rack.`,
};

const AGENTIC_MATERIALS: Record<string, { label: string; material: string; paragraph: string }> = {
  matte: {
    label: 'Agentic Matte',
    material: 'Flat tonal planes with hard boundaries and one cool edge-light: form without gloss.',
    paragraph: `Style: matte flat-dimensional. Build the form from two or three FLAT tonal planes of one hue (a lit face, a shaded side, a darker base) with hard, clean boundaries between them. Absolutely no gloss: no specular highlight, no white hotspot, no shiny plastic, no glassy sheen, no bevel, no inflated 3D bubble, no soft blended gradient. Crisp geometric vector edges, generous corner radii, one thin cooler edge-light along the top-left edge only. Restrained, modern, engineered.`,
  },
  machined: {
    label: 'Agentic Machined',
    material: 'Milled anodized aluminium: brushed texture, hairline chamfers, one anodized accent.',
    paragraph: `Style: precision-machined hardware. The object looks milled from matte anodized aluminium: very fine brushed texture, hairline chamfers where faces meet, a dark graphite body with one anodized accent colour on the working part. Lighting is soft, even and diffuse from directly above. No specular highlight, no glossy sheen, no shiny plastic, no glassy bubble, no soft blended gradient, no cartoon bevel. Tight tolerances, technical, industrial-grade.`,
  },
  emissive: {
    label: 'Agentic Emissive',
    material: 'Near-black body with the working part lit: made for dark terminals, not light pages.',
    paragraph: `Style: emissive dark instrument. A dark matte graphite body, almost black, with the working part of the icon rendered as a clean luminous emissive accent in the colour below: a lit line, edge or panel that glows softly into the surrounding body. No gloss, no specular highlight, no shiny plastic, no glassy bubble, no soft blended gradient over the whole form; the only light in the image is the emissive accent. Crisp vector edges. It reads like lit hardware in a dark rack.`,
  },
};

function agenticStyle(variant: keyof typeof AGENTIC_MATERIALS): StyleSpec {
  const { label, material, paragraph } = AGENTIC_MATERIALS[variant]!;
  const id = `agentic-${variant}`;
  return {
    id,
    label,
    dir: `styles/${id}`,
    material,
    ground: variant === 'emissive' ? 'dark' : 'any',
    emojiRefs: [],
    styleText: `${AGENTIC_FRAME}\n${paragraph}`,
    promptFor(icon) {
      return `${AGENTIC_FRAME}\n${paragraph}\nAccent colour: ${accentFor(icon)}. Use it as the dominant or accent colour as the style dictates.\n\n${subjectLine(icon)}`;
    },
    promptForBrand(brand) {
      // Matte and machined take the hex as it is. Emissive cannot: a mark has
      // to be bright enough to give off its own colour, so emissionFor decides
      // between the colour itself, a lightened tint of it, and neutral white.
      return `${BRAND_FRAME}\n${AGENTIC_BRAND_MATERIALS[variant]!(brand.hex)}\n\nThe mark: the ${brand.title} logo, exactly as shown in the reference image.`;
    },
  };
}

export const HQ: StyleSpec = {
  id: 'hq',
  label: 'HQ',
  dir: 'hq',
  material: 'Glass and enamel bodies under a warm key light, drawn beside the OpenEmoji masters.',
  ground: 'any',
  emojiRefs: STYLE_REFS,
  styleText: HQ_STYLE,
  promptFor(icon) {
    return `${HQ_STYLE}\n\n${subjectLine(icon)}\nColour: ${hqColorFor(icon)}.`;
  },
};

export const STYLES: Record<string, StyleSpec> = {
  hq: HQ,
  'agentic-matte': agenticStyle('matte'),
  'agentic-machined': agenticStyle('machined'),
  'agentic-emissive': agenticStyle('emissive'),
};

/** The agentic variant a bare `agentic` means: the one that holds up everywhere. */
export const AGENTIC_DEFAULT = 'agentic-matte';

export const AGENTIC_STYLES = ['agentic-matte', 'agentic-machined', 'agentic-emissive'] as const;

/** `agentic` is the family's default; everything else is an exact id. */
export function resolveStyle(name: string): StyleSpec {
  const id = name === 'agentic' ? AGENTIC_DEFAULT : name;
  const style = STYLES[id];
  if (!style) throw new Error(`unknown style: ${name} (styles: ${Object.keys(STYLES).join(', ')}, or agentic)`);
  return style;
}
