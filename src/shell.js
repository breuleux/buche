const { spawn } = require("child_process");
const { randomUUID } = require("crypto");

class Shell {
    async *run(inputStream) {
        for await (const obj of inputStream) {
            const handler = this[`handle$${obj.command}`];
            if (handler) {
                yield* handler.call(this, obj);
            }
        }
    }

    async *handle$run(obj) {
        const id = randomUUID();
        yield { type: "process_start", id };

        const [cmd, ...args] = [obj.function, ...(obj.args || [])];
        const child = spawn(cmd, args);

        const events = [];
        let resolve = null;
        let done = false;

        function push(value) {
            events.push(value);
            if (resolve) {
                const r = resolve;
                resolve = null;
                r();
            }
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
