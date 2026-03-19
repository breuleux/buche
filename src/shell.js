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

class Shell {
    constructor() {
        this._processes = new Map();
    }

    run(inputStream) {
        const self = this;
        async function* handlers() {
            for await (const obj of inputStream) {
                const handler = self[`handle$${obj.command}`];
                if (!handler) continue;
                const result = handler.call(self, obj);
                if (result[Symbol.asyncIterator]) {
                    yield result;
                } else {
                    await result;
                }
            }
        }
        return merge(handlers());
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

        const [cmd, ...args] = [obj.function, ...(obj.args || [])];
        const child = spawn(cmd, args);
        this._processes.set(id, child);

        yield { type: "process_start", id };

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
            push({ type: "process_end", id, return_code });
            done = true;
            if (resolve) { const r = resolve; resolve = null; r(); }
        });
        child.on("error", (err) => {
            this._processes.delete(id);
            push({ type: "stderr", id, data: err.message });
            push({ type: "process_end", id, return_code: 1 });
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
