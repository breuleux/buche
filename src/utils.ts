import type { Address, Submission, SubmissionConfiguration } from "./types.ts";

/** A submission with nothing in it: empty content and empty context. */
export function emptySubmission(): Submission {
    return { content: { text: "", ranges: [] }, context: { text: "", ranges: [] } };
}

/**
 * Merge a partial {@link SubmissionConfiguration} into a {@link Submission}:
 * a subfield the configuration leaves out keeps its current value (so a
 * configuration can update the content without restating the context, or the
 * other way around). A provided content without a cursor position inherits
 * the current one, so a reconfiguration doesn't teleport the cursor.
 */
export function applySubmission(
    submission: Submission,
    configuration: SubmissionConfiguration | undefined,
): void {
    if (!configuration) {
        return;
    }
    if (configuration.content !== undefined) {
        const { position, ...rest } = configuration.content;
        const current = submission.content.position;
        const merged = position ?? current;
        submission.content = merged === undefined ? rest : { ...rest, position: merged };
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
