import { type Anchors, calculateStyle, styleToCss } from "../color.ts";
import type { StyledText } from "../types.ts";

/**
 * Build a simple DOM node rendering a {@link StyledText}: its `text` split into
 * plain segments and colorized `<span>`s, one per highlight range. Each range's
 * accent is resolved through {@link calculateStyle} against `anchors` and applied
 * as an inline style.
 *
 * Ranges are clamped to the text, sorted by start, and rendered non-overlapping
 * (a range overlapping already-emitted text is trimmed to what remains). A range
 * whose accent cannot be parsed still renders its text, just unstyled. The
 * `position` field is a cursor concept and is ignored here.
 *
 *   buildStyledText(
 *     { text: "git commit", ranges: [{ start: 0, end: 3, style: "green bold" }] },
 *     { bg: 0.18, fg: 0.9 },
 *   )
 *   // → <span class="styled-text"><span style="…">git</span> commit</span>
 */
export function buildStyledText(
    styled: StyledText,
    anchors: Anchors = { bg: 0.18, fg: 0.9 },
): HTMLElement {
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
            css = styleToCss(calculateStyle(range.style, anchors)) || undefined;
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
