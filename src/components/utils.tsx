import { defaultTheme, styleToCss, type Theme } from "../color.ts";
import type { Icon, StyledText } from "../types.ts";

/**
 * Build a simple DOM node rendering a {@link StyledText}: its `text` split into
 * plain segments and colorized `<span>`s, one per highlight range. Each range's
 * accent is resolved through {@link calculateStyle} against `anchors` and applied
 * as an inline style.
 *
 * Ranges are clamped to the text, sorted by start, and rendered non-overlapping
 * (a range overlapping already-emitted text is trimmed to what remains). A range
 * whose accent cannot be parsed still renders its text, just unstyled. The
 * `selection` field is a cursor concept and is ignored here.
 *
 *   buildStyledText(
 *     { text: "git commit", ranges: [{ start: 0, end: 3, style: "green bold" }] },
 *     { bg: 0.18, fg: 0.9 },
 *   )
 *   // → <span class="styled-text"><span style="…">git</span> commit</span>
 */
export function buildStyledText(styled: StyledText, theme: Theme = defaultTheme): HTMLElement {
    const { text } = styled;

    // Resolve open boundaries (null → 0 / end of text), clamp to the text, drop
    // empty/inverted ones, and order them.
    const ranges = (styled.ranges ?? [])
        .map((r) => ({
            start: Math.max(0, Math.min(text.length, r.start ?? 0)),
            end: Math.max(0, Math.min(text.length, r.end ?? text.length)),
            style: r.style,
        }))
        .filter((r) => r.start < r.end)
        .sort((a, b) => a.start - b.start || a.end - b.end);

    const parts: (string | Node)[] = [];
    let cursor = 0;
    for (const range of ranges) {
        // Trim ranges that overlap text already emitted.
        const start = Math.max(range.start, cursor);
        if (start >= range.end) {
            continue;
        }
        if (cursor < start) {
            parts.push(text.slice(cursor, start));
        }

        // Unparseable accent → render the text without styling.
        let css: string | undefined;
        try {
            css = styleToCss(theme.calculateStyle(range.style)) || undefined;
        } catch {
            css = undefined;
        }
        parts.push(<span style={css}>{text.slice(start, range.end)}</span>);
        cursor = range.end;
    }
    if (cursor < text.length) {
        parts.push(text.slice(cursor));
    }

    return (<span className="styled-text">{parts}</span>) as HTMLElement;
}

/** The data URI of an image icon, or null if its data can't be trusted. */
function iconUri(icon: Extract<Icon, { type: "image" }>): string | null {
    if (!/^image\/[\w.+-]+$/.test(icon.mimetype ?? "")) {
        return null;
    }
    if (icon.encoding === "base64") {
        return /^[A-Za-z0-9+/=\s]*$/.test(icon.data)
            ? `data:${icon.mimetype};base64,${icon.data}`
            : null;
    }
    return `data:${icon.mimetype};charset=utf-8,${encodeURIComponent(icon.data)}`;
}

/**
 * Build the element showing an {@link Icon} (styled in layout.css): an image
 * (an `<img>`, or, for a `mask` image, its shape in the current colour), or a
 * character in a font, on an optional coloured circle or square.
 *
 *   buildIcon({ type: "glyph", text: "G", font: "cursive", color: "orange" })
 *   buildIcon({ type: "image", mimetype: "image/svg+xml", data: "<svg…>", mask: true })
 */
export function buildIcon(icon: Icon, theme: Theme = defaultTheme): HTMLElement {
    const el = document.createElement("span");
    el.className = "buche-icon";
    if (icon.type === "image") {
        el.classList.add("buche-icon-image");
        const uri = iconUri(icon);
        if (uri && icon.mask) {
            el.classList.add("buche-icon-mask");
            el.style.setProperty("mask-image", `url("${uri}")`);
            el.style.setProperty("-webkit-mask-image", `url("${uri}")`);
        } else if (uri) {
            const img = document.createElement("img");
            img.src = uri;
            img.alt = "";
            el.append(img);
        }
        return el;
    }
    el.classList.add("buche-icon-glyph");
    el.textContent = icon.text ?? "";
    if (icon.font) {
        el.style.fontFamily = theme.fontFamilies[icon.font.toLowerCase()] ?? icon.font;
    }
    if (icon.color) {
        try {
            const { color, fontWeight, fontStyle } = theme.calculateStyle(icon.color);
            Object.assign(el.style, {
                color: color ?? "",
                fontWeight: fontWeight ?? "",
                fontStyle: fontStyle ?? "",
            });
        } catch {
            // An unparseable style: the current colour.
        }
    }
    if (icon.background) {
        el.classList.add(
            "buche-icon-shaped",
            `buche-icon-${icon.shape === "square" ? "square" : "circle"}`,
        );
        try {
            el.style.backgroundColor = theme.calculateColor(icon.background);
        } catch {
            // An unparseable colour: no background.
        }
    }
    return el;
}

// Cycle lengths of the status-dot animations; keep in sync with echo-box.css
// and tab-pane.css.
const THROB_MS = 2400;
const BLINK_MS = 800;

/**
 * Put the status-dot animations (`throb`, `blink`) of `el` in phase with every
 * other dot in the interface. The negative `animation-delay` starts each
 * animation part-way into its cycle — wherever the common cycle has got to by
 * now, since the offset is taken from the clock rather than the moment the
 * status appeared — so dots that started at different times pulse together.
 * Called wherever `data-status` changes; the stylesheets read the offsets
 * through `--status-throb-phase` / `--status-blink-phase`.
 */
export function syncStatusPhases(el: HTMLElement): void {
    const now = Date.now();
    el.style.setProperty("--status-throb-phase", `-${now % THROB_MS}ms`);
    el.style.setProperty("--status-blink-phase", `-${now % BLINK_MS}ms`);
}
