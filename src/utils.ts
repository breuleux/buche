var _CURRENT_ID = 0;

export function resetId(n: number = 0) {
    _CURRENT_ID = n;
}

export class IdClass {
    _id: number;

    constructor() {
        this._id = _CURRENT_ID++;
    }

    toJSON() {
        return `#${this._id}`;
    }
}

export interface BucheErrorMessage {
    type: "buche_error";
    code: string;
    subcode?: string;
    reason: string;
    input?: any;
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
