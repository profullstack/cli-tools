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
  /** OpenEmoji masters used as style references; the agentic styles use none. */
  emojiRefs: readonly string[];
  /** The style paragraph, without the icon. */
  styleText: string;
  promptFor(icon: IconDef): string;
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
    emojiRefs: [],
    styleText: `${AGENTIC_FRAME}\n${paragraph}`,
    promptFor(icon) {
      return `${AGENTIC_FRAME}\n${paragraph}\nAccent colour: ${accentFor(icon)}. Use it as the dominant or accent colour as the style dictates.\n\n${subjectLine(icon)}`;
    },
  };
}

export const HQ: StyleSpec = {
  id: 'hq',
  label: 'HQ',
  dir: 'hq',
  material: 'Glass and enamel bodies under a warm key light, drawn beside the OpenEmoji masters.',
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
