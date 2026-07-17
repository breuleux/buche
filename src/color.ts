/**
 * Translate a compact string description into a CSS `oklch(...)` color.
 *
 * A description is a whitespace-separated list of tokens:
 *
 *   - **Named colors** (`red`, `blue`, `orange`, ...) carry a hue and
 *     saturation but *no* luminosity. Several may be combined and an optional
 *     numeric weight suffix biases the mix, e.g. `orange4 red` weighs orange
 *     four times as much as red. Hues are averaged around the circle, so the
 *     mix of `red` (~29°) and `pink` (~350°) lands near 360/0 rather than the
 *     naive arithmetic mean.
 *
 *   - **Channel tokens** set a coordinate absolutely: `H<num>`, `S<num>`,
 *     `L<num>` for hue, saturation and luminosity.
 *
 *   - **Relative channel tokens** nudge a coordinate away from its current
 *     value: `H+30`, `S-10`, `L+5`.
 *
 * Saturation and luminosity are given as integers on a 0–100 scale. Luminosity
 * is measured as *contrast against the background*: `L0` matches the background
 * anchor and higher values move toward the opposite end (the foreground). The
 * caller supplies the background/foreground OKLCH lightness pair, so the same
 * description reads sensibly against any surface.
 */

export interface ColorCoords {
    /** OKLCH hue in degrees, 0–360. */
    h: number;
    /** Saturation on a 0–100 scale (mapped to OKLCH chroma). */
    s: number;
    /** Luminosity on a 0–100 scale, as contrast against the background. */
    l: number;
}

/**
 * The OKLCH lightness anchors a color is measured against. `bg` is the
 * background (where `L0` lands) and `fg` is the foreground (`L100`); both are
 * OKLCH lightness values in the 0–1 range.
 */
export interface Anchors {
    bg: number;
    fg: number;
}

/** Sensible defaults when a coordinate is left unspecified. */
export const DEFAULTS: ColorCoords = {
    h: 0,
    s: 60,
    l: 60,
};

/** Maximum OKLCH chroma that S=100 maps to. */
const MAX_CHROMA = 0.35;

/**
 * Named colors, expressed as a hue (degrees) and saturation (0–100). They
 * deliberately carry no luminosity — that comes from defaults or channel
 * tokens — so a name works on any background.
 */
export const NAMED_COLORS: Record<string, { h: number; s: number }> = {
    red: { h: 29, s: 95 },
    orange: { h: 60, s: 90 },
    amber: { h: 75, s: 90 },
    yellow: { h: 100, s: 88 },
    lime: { h: 125, s: 85 },
    green: { h: 145, s: 80 },
    teal: { h: 178, s: 70 },
    cyan: { h: 195, s: 72 },
    sky: { h: 225, s: 80 },
    blue: { h: 255, s: 88 },
    indigo: { h: 275, s: 88 },
    violet: { h: 292, s: 85 },
    purple: { h: 310, s: 82 },
    magenta: { h: 328, s: 88 },
    pink: { h: 350, s: 78 },
    brown: { h: 50, s: 45 },
    gray: { h: 0, s: 0 },
    grey: { h: 0, s: 0 },
};

const CHANNEL_RE = /^([HSL])([+-]?)(\d+(?:\.\d+)?)$/i;
const NAME_RE = /^([a-zA-Z]+)(\d+(?:\.\d+)?)?$/;

const mod360 = (x: number) => ((x % 360) + 360) % 360;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * Parse the coordinates described by a color string, without converting to CSS.
 * Useful for inspecting or further manipulating a color.
 */
export function parseColor(color: string): ColorCoords {
    const tokens = color.trim().split(/\s+/).filter(Boolean);

    // Accumulators for the weighted circular mean of named colors. Hue
    // directions are weighted by `weight * saturation` so that achromatic
    // colors (gray) never skew the resulting hue.
    let hueX = 0;
    let hueY = 0;
    let sSum = 0;
    let sWeight = 0;
    let hasName = false;

    interface Channel {
        key: "h" | "s" | "l";
        relative: boolean;
        value: number;
    }
    const channels: Channel[] = [];

    for (const token of tokens) {
        const channel = CHANNEL_RE.exec(token);
        if (channel) {
            const [, letter, sign, num] = channel;
            const value = sign === "-" ? -Number(num) : Number(num);
            channels.push({
                key: letter.toLowerCase() as "h" | "s" | "l",
                relative: sign !== "",
                value,
            });
            continue;
        }

        const named = NAME_RE.exec(token);
        if (named) {
            const [, name, weightStr] = named;
            const def = NAMED_COLORS[name.toLowerCase()];
            if (!def) {
                throw new Error(`Unknown color name: "${name}"`);
            }
            const weight = weightStr === undefined ? 1 : Number(weightStr);
            hasName = true;
            const rad = (def.h * Math.PI) / 180;
            const dirWeight = weight * def.s;
            hueX += Math.cos(rad) * dirWeight;
            hueY += Math.sin(rad) * dirWeight;
            sSum += def.s * weight;
            sWeight += weight;
            continue;
        }

        throw new Error(`Cannot parse color token: "${token}"`);
    }

    const coords: ColorCoords = { ...DEFAULTS };

    if (hasName) {
        coords.s = sWeight > 0 ? sSum / sWeight : DEFAULTS.s;
        // Only trust the averaged hue if there was some chromatic direction.
        if (hueX !== 0 || hueY !== 0) {
            coords.h = mod360((Math.atan2(hueY, hueX) * 180) / Math.PI);
        }
    }

    for (const { key, relative, value } of channels) {
        coords[key] = relative ? coords[key] + value : value;
    }

    coords.h = mod360(coords.h);
    coords.s = clamp(coords.s, 0, 100);
    coords.l = clamp(coords.l, 0, 100);
    return coords;
}

/** Convert parsed coordinates to a CSS `oklch(...)` string against the anchors. */
export function coordsToCss(coords: ColorCoords, anchors: Anchors): string {
    const { bg, fg } = anchors;
    const lightness = clamp(bg + (fg - bg) * (coords.l / 100), 0, 1);
    const chroma = (coords.s / 100) * MAX_CHROMA;
    const round = (x: number, p: number) => Number(x.toFixed(p));
    return `oklch(${round(lightness, 4)} ${round(chroma, 4)} ${round(coords.h, 2)})`;
}

/**
 * Translate a string color description into a CSS `oklch(...)` color, measured
 * against the given background/foreground lightness anchors.
 *
 * @example
 *   const light = { bg: 0.98, fg: 0.2 };
 *   calculateColor("red", light)             // a red that reads on white
 *   calculateColor("orange4 red L80", light)
 *   calculateColor("blue S-20 L+10", { bg: 0.16, fg: 0.97 })
 */
export function calculateColor(color: string, anchors: Anchors): string {
    return coordsToCss(parseColor(color), anchors);
}

/** A resolved set of CSS text properties. Any field may be omitted. */
export interface Style {
    color?: string;
    fontWeight?: string;
    fontStyle?: string;
    textDecorationLine?: string;
    fontFamily?: string;
    opacity?: string;
}

/** Font-family shorthands → CSS generic family. */
const FONT_FAMILIES: Record<string, string> = {
    mono: "monospace",
    monospace: "monospace",
    sans: "sans-serif",
    serif: "serif",
};

/**
 * Style keywords that toggle a boolean-ish property. `decoration` values
 * accumulate (so `underline strike` yields `underline line-through`); the rest
 * set a single property.
 */
const STYLE_KEYWORDS: Record<string, Partial<Style> & { decoration?: string }> = {
    bold: { fontWeight: "bold" },
    b: { fontWeight: "bold" },
    thin: { fontWeight: "300" },
    italic: { fontStyle: "italic" },
    i: { fontStyle: "italic" },
    underline: { decoration: "underline" },
    u: { decoration: "underline" },
    strike: { decoration: "line-through" },
    strikethrough: { decoration: "line-through" },
    s: { decoration: "line-through" },
    overline: { decoration: "overline" },
    o: { decoration: "overline" },
    dim: { opacity: "0.6" },
    faint: { opacity: "0.6" },
};

/**
 * Resolve a description into a set of CSS text properties. On top of the color
 * grammar understood by {@link calculateColor}, these standalone words are
 * recognized (case-insensitive):
 *
 *   - weight: `bold`/`b`, `thin`
 *   - slant: `italic`/`i`
 *   - decoration (combinable): `underline`/`u`, `strike`/`strikethrough`/`s`,
 *     `overline`/`o`
 *   - opacity: `dim`/`faint`
 *   - family: `mono`/`monospace`, `sans`/`sans-serif`, `serif`
 *
 * Any remaining tokens are treated as a color description; `color` is only set
 * when at least one such token is present (so `"bold"` alone leaves color to be
 * inherited).
 */
export function calculateStyle(desc: string, anchors: Anchors): Style {
    const style: Style = {};
    const decorations: string[] = [];
    const colorTokens: string[] = [];

    for (const token of desc.trim().split(/\s+/).filter(Boolean)) {
        const key = token.toLowerCase();

        const family = FONT_FAMILIES[key];
        if (family) {
            style.fontFamily = family;
            continue;
        }

        const kw = STYLE_KEYWORDS[key];
        if (kw) {
            const { decoration, ...rest } = kw;
            if (decoration && !decorations.includes(decoration)) {
                decorations.push(decoration);
            }
            Object.assign(style, rest);
            continue;
        }

        colorTokens.push(token);
    }

    if (colorTokens.length > 0) {
        style.color = calculateColor(colorTokens.join(" "), anchors);
    }
    if (decorations.length > 0) {
        style.textDecorationLine = decorations.join(" ");
    }
    return style;
}

const CSS_PROP: Record<keyof Style, string> = {
    color: "color",
    fontWeight: "font-weight",
    fontStyle: "font-style",
    textDecorationLine: "text-decoration-line",
    fontFamily: "font-family",
    opacity: "opacity",
};

/** Render a {@link Style} as an inline CSS declaration string. */
export function styleToCss(style: Style): string {
    return (Object.keys(style) as (keyof Style)[])
        .map((key) => `${CSS_PROP[key]}: ${style[key]}`)
        .join("; ");
}
