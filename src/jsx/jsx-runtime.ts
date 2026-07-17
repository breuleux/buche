// Automatic-runtime JSX factory that produces real DOM nodes.

export const Fragment = Symbol.for("myjsx.fragment");

export type Child = Node | string | number | boolean | null | undefined | Child[];

type Props = Record<string, unknown> & { children?: Child };

type Component = (props: Props) => Node;

export function jsx(type: string | Component | typeof Fragment, props: Props): Node {
    const { children, ...attrs } = props ?? {};

    if (typeof type === "function") {
        return type(props);
    }

    const node: Node =
        type === Fragment ? document.createDocumentFragment() : document.createElement(type);

    if (node instanceof Element) {
        for (const [key, value] of Object.entries(attrs)) {
            applyProp(node, key, value);
        }
    }

    append(node, children);
    return node;
}

// esbuild/tsc call `jsxs` when the children are a static array; the DOM
// factory treats one child and many children identically, so it is an alias.
export const jsxs = jsx;

function append(parent: Node, children: Child): void {
    if (children == null || children === true || children === false) {
        return;
    }
    if (Array.isArray(children)) {
        for (const child of children) {
            append(parent, child);
        }
        return;
    }
    parent.appendChild(
        children instanceof Node ? children : document.createTextNode(String(children)),
    );
}

function applyProp(el: Element, key: string, value: unknown): void {
    if (value == null || value === false) {
        return;
    }
    if (key === "ref" && typeof value === "function") {
        (value as (el: Element) => void)(el);
        return;
    }
    if (key.startsWith("on") && typeof value === "function") {
        el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
        return;
    }
    if (key === "style" && typeof value === "object") {
        Object.assign((el as HTMLElement).style, value);
        return;
    }
    // JSX ergonomics: accept the React-style aliases too.
    const name = key === "className" ? "class" : key === "htmlFor" ? "for" : key;
    el.setAttribute(name, value === true ? "" : String(value));
}

// The set of valid tag names, derived from the standard DOM lib: every HTML
// tag, plus the SVG-only tags (HTML wins on the few names both maps define,
// e.g. `a`, `script`, `style`, `title`).
type TagMap = HTMLElementTagNameMap & {
    [K in Exclude<
        keyof SVGElementTagNameMap,
        keyof HTMLElementTagNameMap
    >]: SVGElementTagNameMap[K];
};

// Props accepted by an intrinsic tag: the element's own DOM properties (id,
// className, onclick, tabIndex, ...) as optional, plus JSX children, a
// convenient `style` (string or partial style object), and the standard
// open-ended `data-*` / `aria-*` attributes.
type DomProps<E> = Omit<Partial<E>, "children" | "style"> & {
    children?: Child;
    style?: string | Partial<CSSStyleDeclaration>;
} & {
    [attr: `data-${string}`]: string | number | boolean;
    [attr: `aria-${string}`]: string | number | boolean;
};

// Types the compiler looks for on `<foo>` when jsxImportSource = "myjsx".
export namespace JSX {
    // Result of evaluating a JSX expression.
    export type Element = Node;
    // One entry per standard tag, keyed by name; unknown tags are rejected.
    export type IntrinsicElements = {
        [K in keyof TagMap]: DomProps<TagMap[K]>;
    };
    // Tells the checker which prop carries children.
    export interface ElementChildrenAttribute {
        children: unknown;
    }
}
