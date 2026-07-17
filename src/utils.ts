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
    ts: AsyncGenerator<T>,
    us: AsyncGenerator<U>,
): AsyncGenerator<T | U> {
    const iteratorT = ts[Symbol.asyncIterator]();
    const iteratorU = us[Symbol.asyncIterator]();

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
