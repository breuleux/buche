/**
 * A minimal unbounded async queue with a single consumer. Producers `push`
 * values and call `end` when no more values will arrive; the consumer drains it
 * with `for await`.
 *
 * Kept dependency-free (no node built-ins) so it can be bundled for the browser
 * as well as run on the server.
 */
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
