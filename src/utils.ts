import type {
    Address,
    Part,
    StructuredText,
    Submission,
    SubmissionConfiguration,
    TextPart,
} from "./types.ts";

/** Structured text with a single unstyled part (or no part, for ""). */
export function plainStructuredText(text: string): StructuredText {
    return { parts: text ? [{ text }] : [] };
}

/** Two styles (accents) combined: `inner`'s tokens come after `outer`'s, so
 *  they win where both set the same thing. */
export function combineStyles(
    outer: string | null | undefined,
    inner: string | null | undefined,
): string | null {
    return [outer, inner].filter(Boolean).join(" ") || null;
}

/**
 * Structured text's parts with its groups dissolved: their parts in their
 * place, styled with the group's style under their own. The groups' actions
 * are dropped (the parts' own are kept).
 */
export function flattenParts(parts: readonly Part[], style: string | null = null): Part[] {
    const out: Part[] = [];
    for (const part of parts) {
        if ("group" in part) {
            out.push(...flattenParts(part.group, combineStyles(style, part.style)));
        } else if ("text" in part && style) {
            out.push({ ...part, style: combineStyles(style, part.style) });
        } else {
            out.push(part);
        }
    }
    return out;
}

/** The text parts of structured text (its groups dissolved, see flattenParts;
 *  its spacers left out). */
export function textParts(parts: readonly Part[]): TextPart[] {
    return flattenParts(parts).filter((part): part is TextPart => "text" in part);
}

/** The text of structured text: its text parts' text, joined. */
export function plainText(structured: StructuredText | undefined | null): string {
    return textParts(structured?.parts ?? [])
        .map((part) => part.text)
        .join("");
}

/**
 * The parts of structured text, edited to read `text`: the span that changed
 * (between the longest common prefix and suffix) is replaced, in the text part
 * it starts in. Text inserted at the very beginning goes to the first text
 * part; at a boundary between parts, to the part before; at the end, to the
 * last text part. Text parts emptied by a deletion are dropped; spacers stay.
 * Groups are dissolved (see flattenParts).
 *
 *   spliceText([{ text: "ls", style: "a" }, { text: " x" }], "ls -l x")
 *   // → [{ text: "ls -l", style: "a" }, { text: " x" }]
 */
export function spliceText(original: Part[], text: string): Part[] {
    // (Groups are dissolved first: an edited text is a flat run of parts.)
    const parts = original.some((part) => "group" in part) ? flattenParts(original) : original;
    const texts = textParts(parts);
    const old = texts.map((part) => part.text).join("");
    if (old === text) {
        return original;
    }
    if (texts.length === 0) {
        return text ? [...parts, { text }] : parts;
    }
    let prefix = 0;
    const max = Math.min(old.length, text.length);
    while (prefix < max && old[prefix] === text[prefix]) {
        prefix++;
    }
    let suffix = 0;
    while (
        suffix < max - prefix &&
        old[old.length - 1 - suffix] === text[text.length - 1 - suffix]
    ) {
        suffix++;
    }
    const from = prefix;
    const to = old.length - suffix;
    const insert = text.slice(prefix, text.length - suffix);

    // The text part that takes the insertion: the one `from` falls in (at a
    // boundary, the one before it, but the first at 0); the last one, failing that.
    let owner = texts[texts.length - 1];
    let offset = 0;
    for (const part of texts) {
        const end = offset + part.text.length;
        if (from < end || (from === end && end > offset) || from === 0) {
            owner = part;
            break;
        }
        offset = end;
    }

    const result: Part[] = [];
    offset = 0;
    for (const part of parts) {
        if (!("text" in part)) {
            result.push(part);
            continue;
        }
        const start = offset;
        const end = offset + part.text.length;
        offset = end;
        // Keep what lies outside [from, to), and the insertion in the owner.
        let kept = part.text.slice(0, Math.max(0, Math.min(end, from) - start));
        if (part === owner) {
            kept += insert;
        }
        kept += part.text.slice(Math.max(0, Math.min(part.text.length, to - start)));
        if (kept) {
            result.push({ ...part, text: kept });
        }
    }
    return result;
}

/** A submission with nothing in it: empty content and empty context. */
export function emptySubmission(): Submission {
    return { content: { parts: [] }, context: { parts: [] } };
}

/**
 * Merge a partial {@link SubmissionConfiguration} into a {@link Submission}:
 * a subfield the configuration leaves out keeps its current value (so a
 * configuration can update the content without restating the context, or the
 * other way around). A provided content without a selection inherits the
 * current one, so a reconfiguration doesn't move the cursor.
 */
export function applySubmission(
    submission: Submission,
    configuration: SubmissionConfiguration | undefined,
): void {
    if (!configuration) {
        return;
    }
    if (configuration.content !== undefined) {
        const { selection, ...rest } = configuration.content;
        const current = submission.content.selection;
        const merged = selection ?? current;
        submission.content = merged === undefined ? rest : { ...rest, selection: merged };
    }
    if (configuration.context !== undefined) {
        submission.context = configuration.context;
    }
}

var _CURRENT_ID = 0;

export function resetId(n: number = 0) {
    _CURRENT_ID = n;
}

type Constructor<T = object> = new (...args: any[]) => T;

/**
 * Mixin giving a class a `serialId` — drawn from a shared counter at
 * construction — and a `toJSON` that renders it as a `#<n>` reference. Use
 * {@link resetId} to make a run's ids deterministic.
 */
export function WithId<TBase extends Constructor = Constructor>(Base: TBase = class {} as TBase) {
    return class extends Base {
        serialId = _CURRENT_ID++;

        toJSON() {
            return `#${this.serialId}`;
        }
    };
}

export interface BucheErrorFields {
    code: string;
    subcode?: string;
    reason: string;
    input?: any;
}

export interface BucheErrorMessage extends BucheErrorFields {
    type: "buche_error";
}

export class BucheError extends Error {
    errorData: BucheErrorMessage;

    constructor(errorData: BucheErrorMessage) {
        super(errorData.reason);
        this.errorData = errorData;
    }
}

export async function* mergeIterables<T, U>(
    iteratorT: AsyncIterator<T>,
    iteratorU: AsyncIterator<U>,
): AsyncGenerator<T | U> {
    type TaggedResult =
        | { source: "T"; result: IteratorResult<T> }
        | { source: "U"; result: IteratorResult<U> };

    // Fetch initial promises for both streams
    let promiseT: Promise<TaggedResult> | null = iteratorT
        .next()
        .then((result) => ({ source: "T" as const, result }));

    let promiseU: Promise<TaggedResult> | null = iteratorU
        .next()
        .then((result) => ({ source: "U" as const, result }));

    try {
        while (promiseT !== null || promiseU !== null) {
            const activePromises: Promise<TaggedResult>[] = [];
            if (promiseT) {
                activePromises.push(promiseT);
            }
            if (promiseU) {
                activePromises.push(promiseU);
            }

            // Race to see which iterable produces a value first
            const winner = await Promise.race(activePromises);

            if (winner.source === "T") {
                if (winner.result.done) {
                    promiseT = null; // Stream T is completed
                } else {
                    yield winner.result.value;
                    // Request the next value from T
                    promiseT = iteratorT
                        .next()
                        .then((result) => ({ source: "T" as const, result }));
                }
            } else {
                if (winner.result.done) {
                    promiseU = null; // Stream U is completed
                } else {
                    yield winner.result.value;
                    // Request the next value from U
                    promiseU = iteratorU
                        .next()
                        .then((result) => ({ source: "U" as const, result }));
                }
            }
        }
    } finally {
        // Ensure active iterators are closed if the consumer aborts early (e.g. break)
        await Promise.allSettled([iteratorT.return?.(null), iteratorU.return?.(null)]);
    }
}

export interface HierarchyArgs {
    parent?: Hierarchy;
    field?: string;
}

export class Hierarchy {
    parent?: this;
    field?: string;
    children: Record<string, this>;

    constructor(args: { parent?: Hierarchy; field?: string }) {
        this.parent = args.parent as this;
        this.field = args.field;
        this.children = {};
    }

    address(): Address {
        if (!this.parent) {
            return [];
        } else {
            return [...this.parent.address(), this.field!];
        }
    }

    getAt(addr: Address, create: boolean = false): this | null {
        let node: this = this;
        for (const segment of addr) {
            let child = node.children[segment];
            if (!child) {
                if (!create) {
                    return null;
                }
                child = node.children[segment] = new (
                    this.constructor as new (
                        _: HierarchyArgs,
                    ) => this
                )({ parent: node, field: segment });
            }
            node = child;
        }
        return node;
    }

    *walk(): Generator<this> {
        yield this;
        for (const child of Object.values(this.children)) {
            yield* child.walk();
        }
    }
}

export class AsyncQueue<T> {
    private items: T[] = [];
    private waiting: ((result: IteratorResult<T>) => void)[] = [];
    private ended = false;

    push(item: T): void {
        if (this.ended) {
            return;
        }
        const resolve = this.waiting.shift();
        if (resolve) {
            resolve({ value: item, done: false });
        } else {
            this.items.push(item);
        }
    }

    end(): void {
        if (this.ended) {
            return;
        }
        this.ended = true;
        for (const resolve of this.waiting) {
            resolve({ value: undefined as never, done: true });
        }
        this.waiting = [];
    }

    *purge() {
        while (this.items.length > 0) {
            yield this.items.shift() as T;
        }
    }

    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
        while (true) {
            if (this.items.length > 0) {
                yield this.items.shift() as T;
            } else if (this.ended) {
                return;
            } else {
                const result = await new Promise<IteratorResult<T>>((resolve) => {
                    this.waiting.push(resolve);
                });
                if (result.done) {
                    return;
                }
                yield result.value;
            }
        }
    }
}

export async function* awrap<T>(stream: AsyncGenerator<T>, fn?: (arg: T) => void) {
    if (fn) {
        for await (const x of stream) {
            fn(x);
            yield x;
        }
    } else {
        yield* stream;
    }
}
