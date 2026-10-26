import { defaultTheme, styleToCss, type Theme } from "../color.ts";
import type { Action, Icon, Part, StructuredText } from "../types.ts";
import { combineStyles } from "../utils.ts";

/**
 * Build a simple DOM node rendering a {@link StructuredText}: its parts, one
 * after the other, a styled text part as a `<span>` with its accent resolved
 * through the theme and applied as an inline style, an unstyled one as a bare
 * text node. A part whose accent cannot be parsed still renders its text (in a
 * `<span>`), just unstyled. The `selection` field is a cursor concept and is
 * ignored here.
 *
 * With spacers, the node is a full-width flex row (`.styled-text-spaced`, see
 * styled-text.css): the text parts between spacers are grouped into segments
 * (`.styled-text-segment`), and each "grow" spacer (`.styled-text-spacer`)
 * takes a share of the space left over.
 *
 * Given `onAction`, a part with an `action` is clickable (`.styled-text-action`):
 * a click calls `onAction` with it. Without, actions are ignored (the part is
 * shown as if it had none).
 *
 *   buildStructuredText(
 *     { parts: [{ text: "git", style: "green bold" }, { text: " commit" }] },
 *   )
 *   // → <span class="styled-text"><span style="…">git</span> commit</span>
 */
export function buildStructuredText(
    structured: StructuredText,
    theme: Theme = defaultTheme,
    onAction?: ActionHandler,
): HTMLElement {
    const parts = structured.parts ?? [];
    if (!parts.some((part) => "spacer" in part)) {
        return (
            <span className="styled-text">{renderText(parts, theme, onAction)}</span>
        ) as HTMLElement;
    }
    const children: Node[] = [];
    let segment: Part[] = [];
    const flush = () => {
        if (segment.length) {
            children.push(
                <span className="styled-text-segment">
                    {renderText(segment, theme, onAction)}
                </span>,
            );
            segment = [];
        }
    };
    for (const part of parts) {
        if ("spacer" in part) {
            flush();
            children.push(actionable(<span className="styled-text-spacer" />, part, onAction));
        } else {
            segment.push(part);
        }
    }
    flush();
    return (<span className="styled-text styled-text-spaced">{children}</span>) as HTMLElement;
}

/** What a click on a part with an action calls. */
export type ActionHandler = (action: Action, event: MouseEvent) => void;

/** Make `el` fire `part`'s action when clicked, if it has one and there is
 *  an `onAction` to fire it. */
function actionable(el: Node, part: Part, onAction: ActionHandler | undefined): Node {
    const { action } = part;
    if (action === undefined || !onAction || !(el instanceof HTMLElement)) {
        return el;
    }
    el.classList.add("styled-text-action");
    // No focus change (it stays in the prompt's editor) and no text selection.
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onAction(action, e);
    });
    return el;
}

/** The text parts of `parts`, rendered (spacers are left out): each in the
 *  style `outer` (a group's) combined with its own. A group's parts are
 *  wrapped together when the group is clickable. */
function renderText(
    parts: Part[],
    theme: Theme,
    onAction?: ActionHandler,
    outer: string | null = null,
): (string | Node)[] {
    const out: (string | Node)[] = [];
    for (const part of parts) {
        if ("group" in part) {
            const inner = renderText(
                part.group,
                theme,
                onAction,
                combineStyles(outer, part.style),
            );
            if (part.action !== undefined && onAction !== undefined) {
                out.push(
                    actionable(<span className="styled-text-group">{inner}</span>, part, onAction),
                );
            } else {
                out.push(...inner);
            }
            continue;
        }
        if (!("text" in part) || !part.text) {
            continue;
        }
        const style = combineStyles(outer, part.style);
        let css: string | undefined;
        if (style) {
            try {
                css = styleToCss(theme.calculateStyle(style)) || undefined;
            } catch {
                css = undefined;
            }
        }
        const clickable = part.action !== undefined && onAction !== undefined;
        out.push(
            style || clickable
                ? actionable(<span style={css}>{part.text}</span>, part, onAction)
                : part.text,
        );
    }
    return out;
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
