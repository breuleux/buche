const { spawn } = require("child_process");
const { randomUUID } = require("crypto");

async function* merge(iterables) {
    const queue = [];
    let notify = null;
    let active = 0;
    let outerDone = false;

    function push(value) {
        queue.push(value);
        if (notify) { const r = notify; notify = null; r(); }
    }

    async function pumpOuter() {
        for await (const iter of iterables) {
            active++;
            async function drain() {
                for await (const value of iter) push({ value });
                active--;
                push({ noop: true });
            }
            drain();
        }
        outerDone = true;
        push({ noop: true });
    }

    pumpOuter();

    while (true) {
        while (queue.length > 0) {
            const item = queue.shift();
            if (!item.noop) yield item.value;
        }
        if (outerDone && active === 0) break;
        await new Promise((r) => { notify = r; });
    }
}

function makeError(err, id = null) {
    return {
        type: "error",
        error_type: err.code ?? err.constructor.name,
        message: err.message,
        traceback: err.stack ? err.stack.split("\n").slice(1).map((s) => s.trim()) : [],
        id,
    };
}

async function* withErrorCatch(iter, id) {
    try {
        yield* iter;
    } catch (err) {
        yield makeError(err, id);
    }
}

class Shell {
    constructor() {
        this._processes = new Map();
    }

    run(inputStream) {
        const self = this;
        async function* handlers() {
            for await (const obj of inputStream) {
                const handler = self[`handle$${obj.type}`];
                if (!handler) continue;
                try {
                    const result = handler.call(self, obj);
                    if (result[Symbol.asyncIterator]) {
                        yield withErrorCatch(result, obj.id ?? null);
                    } else {
                        await result;
                    }
                } catch (err) {
                    yield (async function* singleError() { yield makeError(err, obj.id ?? null); })();
                }
            }
        }
        return merge(handlers());
    }

    async *handle$parse(obj) {
        const [command, ...args] = obj.text.trim().split(/\s+/);
        yield* this.handle$run({ command, args, id: obj.id });
    }

    async handle$wait(obj) {
        await new Promise((r) => setTimeout(r, obj.seconds * 1000));
    }

    async handle$input(obj) {
        const child = this._processes.get(obj.id);
        if (child) child.stdin.write(obj.text);
    }

    async handle$close_stdin(obj) {
        const child = this._processes.get(obj.id);
        if (child) child.stdin.end();
    }

    async *handle$run(obj) {
        const id = obj.id ?? randomUUID();
        if (this._processes.has(id)) throw new Error(`Process ${id} already exists`);

        const [cmd, ...args] = [obj.command, ...(obj.args || [])];
        const child = spawn(cmd, args);
        this._processes.set(id, child);

        const startEvent = { type: "new", id, process_id: child.pid };
        if (obj.echo) startEvent.echo = obj.echo;
        yield startEvent;

        const events = [];
        let resolve = null;
        let done = false;

        function push(value) {
            events.push(value);
            if (resolve) { const r = resolve; resolve = null; r(); }
        }

        child.stdout.on("data", (data) => push({ type: "std", stream: "stdout", id, data: data.toString() }));
        child.stderr.on("data", (data) => push({ type: "std", stream: "stderr", id, data: data.toString() }));
        child.on("close", (return_code) => {
            this._processes.delete(id);
            push({ type: "close", id, return_code });
            done = true;
            if (resolve) { const r = resolve; resolve = null; r(); }
        });
        child.on("error", (err) => {
            this._processes.delete(id);
            push(makeError(err, id));
            push({ type: "close", id, return_code: 1 });
            done = true;
            if (resolve) { const r = resolve; resolve = null; r(); }
        });

        while (true) {
            while (events.length > 0) yield events.shift();
            if (done) break;
            await new Promise((r) => { resolve = r; });
        }
    }
}

module.exports = { Shell };
