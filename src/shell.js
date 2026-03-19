const { spawn } = require("child_process");
const { randomUUID } = require("crypto");

async function* merge(iterables) {
    const queue = [];
    let resolve = null;
    let active = 0;

    function push(value) {
        queue.push(value);
        if (resolve) { const r = resolve; resolve = null; r(); }
    }

    function pump(iter) {
        active++;
        async function drain() {
            for await (const value of iter) push({ value });
            if (--active === 0) push({ done: true });
            else push({ noop: true });
        }
        drain();
    }

    for await (const iter of iterables) {
        pump(iter);
        while (queue.length > 0) {
            const item = queue.shift();
            if (item.done) return;
            if (!item.noop) yield item.value;
        }
    }

    while (active > 0) {
        while (queue.length > 0) {
            const item = queue.shift();
            if (item.done) return;
            if (!item.noop) yield item.value;
        }
        await new Promise((r) => { resolve = r; });
    }
}

class Shell {
    run(inputStream) {
        const self = this;
        async function* handlers() {
            for await (const obj of inputStream) {
                const handler = self[`handle$${obj.command}`];
                if (handler) yield handler.call(self, obj);
            }
        }
        return merge(handlers());
    }

    async *handle$run(obj) {
        const id = obj.id ?? randomUUID();
        yield { type: "process_start", id };

        const [cmd, ...args] = [obj.function, ...(obj.args || [])];
        const child = spawn(cmd, args);

        const events = [];
        let resolve = null;
        let done = false;

        function push(value) {
            events.push(value);
            if (resolve) { const r = resolve; resolve = null; r(); }
        }

        child.stdout.on("data", (data) => push({ type: "stdout", id, data: data.toString() }));
        child.stderr.on("data", (data) => push({ type: "stderr", id, data: data.toString() }));
        child.on("close", (return_code) => {
            push({ type: "process_end", id, return_code });
            done = true;
            if (resolve) { const r = resolve; resolve = null; r(); }
        });
        child.on("error", (err) => {
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
