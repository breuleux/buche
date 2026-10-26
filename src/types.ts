export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type Address = Array<string>;
export type To = Address;

export type ZoneDescriptor = string;

/**
 * Where to put a new cell or prompt, as the core resolves it (the interface's
 * layout engine does the actual placing). Reserved zones are relative to the
 * `anchor`:
 *  - "inline": in the scroll stream the anchor is in (a cell's default);
 *  - "tab": a new tab beside the anchor (a prompt's default);
 *  - "left" | "right" | "up" | "down": into the neighbour pane on that side,
 *    created if there is none.
 * Any other zone names a pane.
 */
export interface Target {
    zone: string;

    /** Address of the entry to place relative to; null: the default spot. */
    anchor: Address | null;

    /** For a prompt: link its tab with the prompt tab it lands next to, so
     *  that their streams merge. */
    link?: boolean;
}

export type Accent = string;

export interface Selection {
    /** Inclusive starting position of the selection */
    start: number;

    /** Exclusive ending position of the selection */
    end: number;
}

/** A syntax-highlight span over the prompt text */
export interface HighlightRange {
    /**
     * Inclusive start offset. `null` means the start of the text (offset 0); in
     * an editable prompt it is an *open* boundary that also absorbs text the user
     * inserts at the very beginning.
     */
    start: number | null;

    /**
     * Exclusive end offset. `null` means the end of the text; in an editable
     * prompt it is an *open* boundary that also absorbs text the user appends.
     */
    end: number | null;

    /** Style. */
    style: Accent;
}

export interface StyledText {
    /** Text to style. */
    text: string;

    /** Spans to colorize. */
    ranges: HighlightRange[];
}

/**
 * A cell/tab icon: an image, or a character drawn in a font, on an optional
 * coloured circle or square.
 */
export type Icon = ImageIcon | GlyphIcon;

/** An icon from image data. */
export interface ImageIcon {
    type: "image";

    /** The image's MIME type, e.g. "image/png" or "image/svg+xml". */
    mimetype: string;

    /** The image: base64 when `encoding` is "base64", else the text itself (SVG). */
    data: string;

    /** How `data` is encoded: "base64", or null/absent for text. */
    encoding?: "base64" | null;

    /**
     * If true, only the image's shape counts: it is painted in the current
     * text colour (like a glyph), e.g. for a monochrome SVG.
     */
    mask?: boolean;
}

/** An icon drawn as a character. */
export interface GlyphIcon {
    type: "glyph";

    /** The character (or a few) to draw. */
    text: string;

    /**
     * Font family: a CSS font-family list, or a keyword (mono, sans, serif,
     * cursive).
     */
    font?: string;

    /** Style of the character (an accent: colour, bold, italic...). */
    color?: Accent;

    /** Background colour of the shape behind the character (none if absent). */
    background?: Accent;

    /** Shape of the background. Default: "circle". */
    shape?: "circle" | "square";
}

export interface InteractiveStyledText extends StyledText {
    /**
     * Editability status of the text. Defaults to "editable" in a prompt,
     * "readonly" in an echo (only "readonly" is supported in echos for now).
     * "frozen" — set when a freezing binding fires — acts like "readonly",
     * but is styled differently to denote a temporary condition.
     */
    editability?: "readonly" | "editable" | "frozen";

    /** Selection range, if applicable. */
    selection?: Selection | null;

    /** Ghost text displayed next to the text as a completion suggestion. */
    filigrane?: string;
}

export interface SubmissionConfiguration {
    /** Content text of the submission */
    content?: InteractiveStyledText;

    /** Context of the submission (prompt text) */
    context?: StyledText;
}

export interface Submission {
    /** Content text of the submission */
    content: InteractiveStyledText;

    /** Context of the submission (prompt text) */
    context: StyledText;
}
