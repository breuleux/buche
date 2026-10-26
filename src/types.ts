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
 *    created if there is none;
 *  - "sleft" | "sright" | "sup" | "sdown": a new pane on that side of the
 *    anchor's pane (a split), whatever is already there;
 *  - "float": a new floating window over the anchor's pane;
 *  - "pop": a floating window over the anchor's prompt, closed (its process
 *    terminated) when the focus leaves it.
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

/** A command line for the driver to run (as if submitted, but leaving the
 *  prompt and its history alone). */
export interface CommandAction {
    /** The command line. */
    command: string;

    /** If true, the prompt's content is frozen as the action fires. */
    freeze?: boolean;
}

/** One of the driver's built-in actions (e.g. coquille's submit, next...). */
export interface BuiltinAction {
    /** The built-in action's name. */
    builtin: string;

    /** If true, the prompt's content is frozen as the action fires. */
    freeze?: boolean;
}

/**
 * What a key binding, or a clicked part, does. The terminal only reads
 * `freeze`, and sends the action to the driver (see CommandRequest), which
 * carries it out. A string is a command line: short for `{command: <it>}`.
 */
export type Action = string | CommandAction | BuiltinAction;

/** What every part of structured text can have. */
export interface BasePart {
    /**
     * Fired when the part is clicked, as a key binding would be (the driver
     * gets the same command request). Only in a prompt's context; elsewhere
     * the part is shown as if it had none.
     */
    action?: Action;
}

/** A run of text in a single style. */
export interface TextPart extends BasePart {
    /** The text. */
    text: string;

    /** Style (an accent: colour, bold, italic, font...). Absent or null: unstyled. */
    style?: Accent | null;
}

/**
 * Blank space between parts. A "grow" spacer takes all the space left over
 * on the line, shared with the other grow spacers: e.g. one spacer pushes
 * what follows it to the right edge. Ignored in an editable prompt.
 */
export interface SpacerPart extends BasePart {
    /** How the spacer is sized: "grow" takes the remaining space. */
    spacer: "grow";
}

/**
 * Parts taken together: the group's style applies to each of them (under
 * their own styles: e.g. a group in "bold" with a part in "red" shows it in
 * bold red), and its action covers them all (one click target over the whole
 * run). Spacers only take effect at the top level: in a group, they are
 * ignored.
 */
export interface GroupPart extends BasePart {
    /** The parts in the group. */
    group: Part[];

    /** Style applied to every part in the group (an accent). Absent or null: none. */
    style?: Accent | null;
}

/** A part of structured text. */
export type Part = TextPart | SpacerPart | GroupPart;

/**
 * Text made of parts, shown one after the other. In an editable prompt, the
 * first part absorbs text the user inserts at the very beginning, and the last
 * part text the user appends (so a single part styles everything typed).
 */
export interface StructuredText {
    /** The parts, in order. */
    parts: Part[];
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

export interface InteractiveStructuredText extends StructuredText {
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
    content?: InteractiveStructuredText;

    /** Context of the submission (prompt text) */
    context?: StructuredText;
}

export interface Submission {
    /** Content text of the submission */
    content: InteractiveStructuredText;

    /** Context of the submission (prompt text) */
    context: StructuredText;
}
