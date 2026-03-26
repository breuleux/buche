const pty = require("node-pty");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");
const fs = require("fs");

async function* merge(iterables) {
	const queue = [];
	let notify = null;
	let active = 0;
	let outerDone = false;

	function push(value) {
		queue.push(value);
		if (notify) {
			const r = notify;
			notify = null;
			r();
		}
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
		await new Promise((r) => {
			notify = r;
		});
	}
}

function makeError(err, cell_id = null) {
	return {
		type: "error",
		error_type: err.code ?? err.constructor.name,
		message: err.message,
		traceback: err.stack
			? err.stack
					.split("\n")
					.slice(1)
					.map((s) => s.trim())
			: [],
		cell_id,
	};
}

async function* withErrorCatch(iter, cell_id) {
	try {
		yield* iter;
	} catch (err) {
		yield makeError(err, cell_id);
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
					if (result && result[Symbol.asyncIterator]) {
						// Prime the generator so its synchronous setup (e.g. process
						// registration) completes before we process the next command.
						const gen = result;
						const first = await gen.next();
						yield withErrorCatch((async function* () {
							if (!first.done) yield first.value;
							yield* gen;
						})(), obj.cell_id ?? null);
					} else {
						await result;
					}
				} catch (err) {
					yield (async function* singleError() {
						yield makeError(err, obj.cell_id ?? null);
					})();
				}
			}
		}
		return merge(handlers());
	}

	async *handle$parse(obj) {
		const [command, ...args] = obj.text.trim().split(/\s+/);
		yield* this.handle$run({
			command,
			args,
			cell_id: obj.cell_id,
			echo: obj.echo ?? true,
		});
	}

	async handle$wait(obj) {
		await new Promise((r) => setTimeout(r, obj.seconds * 1000));
	}

	async handle$input(obj) {
		const proc = this._processes.get(obj.cell_id);
		if (!proc) return;
		await proc.spawned;
		proc.child.stdin.write(obj.text);
		// Echo input back as stdout so the terminal display shows what was typed.
		proc.pushEcho(obj.text);
	}

	async handle$close_stdin(obj) {
		const proc = this._processes.get(obj.cell_id);
		if (!proc) return;
		await proc.spawned;
		proc.child.stdin.end();
	}

	async *handle$run(obj) {
		const cell_id = obj.cell_id ?? randomUUID();
		if (this._processes.has(cell_id))
			throw new Error(`Process ${cell_id} already exists`);

		const [cmd, ...args] = [obj.command, ...(obj.args || [])];

		// stdout and stderr are PTYs so isatty() returns true and programs emit
		// colour codes.  stdin is a plain pipe: PTY canonical-mode buffering on
		// macOS causes kqueue to miss subsequent 'data' events after the first
		// canonical line, so rapid-fire input would be lost.
		const stdoutPty = pty.open({ cols: 220, rows: 50 });
		const stderrPty = pty.open({ cols: 220, rows: 50 });
		const { O_RDWR, O_NOCTTY } = fs.constants;
		const stdoutSlave = fs.openSync(stdoutPty.ptsName, O_RDWR | O_NOCTTY);
		const stderrSlave = fs.openSync(stderrPty.ptsName, O_RDWR | O_NOCTTY);

		stdoutPty._socket.on("data", (d) => push({ type: "send", cell_id, data: { stream: "stdout", text: d.toString() } }));
		stderrPty._socket.on("data", (d) => push({ type: "send", cell_id, data: { stream: "stderr", text: d.toString() } }));

		// EIO means the slave side closed (process exited) — not a real error.
		stdoutPty._socket.on("error", (e) => { if (e.code !== "EIO") push(makeError(e, cell_id)); });
		stderrPty._socket.on("error", (e) => { if (e.code !== "EIO") push(makeError(e, cell_id)); });

		const child = spawn(cmd, args, {
			stdio: ["pipe", stdoutSlave, stderrSlave],
			env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
		});

		// When the child exits, close stdin immediately but let stdout/stderr
		// drain naturally via EIO so we don't lose buffered output.  We push
		// the "close" event only after both conditions are met:
		//   1. capturedReturnCode is set (child "close" event fired)
		//   2. pendingOutputSockets == 0 (both stdout/stderr sockets drained and closed)
		// Either condition may happen first, so we check in both places.
		let capturedReturnCode = null;
		let pendingOutputSockets = 2;
		let closeFired = false;
		const tryFireClose = () => {
			if (closeFired) return;
			if (pendingOutputSockets <= 0 && capturedReturnCode !== null) {
				closeFired = true;
				this._processes.delete(cell_id);
				push({ type: "close", cell_id, return_code: capturedReturnCode });
				done = true;
				if (resolve) { const r = resolve; resolve = null; r(); }
			}
		};
		stdoutPty._socket.on("close", () => { pendingOutputSockets--; tryFireClose(); });
		stderrPty._socket.on("close", () => { pendingOutputSockets--; tryFireClose(); });

		child.on("close", (return_code) => {
			capturedReturnCode = return_code ?? 0;
			this._processes.delete(cell_id);
			// Destroy stdout/stderr sockets in setImmediate so any pending I/O
			// callbacks (buffered output data) run first, then the "close" events
			// fire and tryFireClose can push the close message.
			setImmediate(() => {
				stdoutPty._socket.destroy();
				stderrPty._socket.destroy();
				tryFireClose();
			});
		});
		child.on("error", (err) => {
			stdoutPty._socket.destroy();
			stderrPty._socket.destroy();
			this._processes.delete(cell_id);
			push(makeError(err, cell_id));
			push({ type: "close", cell_id, return_code: 1 });
			done = true;
			if (resolve) { const r = resolve; resolve = null; r(); }
		});

		// Parent no longer needs the slave fds — child inherited them.
		fs.closeSync(stdoutSlave);
		fs.closeSync(stderrSlave);

		// Resolves once the child process has actually exec'd and opened its fds.
		const spawned = new Promise((res, rej) => {
			child.once("spawn", res);
			child.once("error", rej);
		}).catch(() => {});

		const pushEcho = (text) => push({ type: "send", cell_id, data: { stream: "stdout", text } });

		this._processes.set(cell_id, { child, spawned, pushEcho });

		const events = [];
		let resolve = null;
		let done = false;

		function push(value) {
			events.push(value);
			if (resolve) { const r = resolve; resolve = null; r(); }
		}

		// Wire up all listeners before yielding so no output is lost
		// while the generator is suspended.

		yield { type: "new", cell_id, mode: "text", echo: obj.echo, process_id: child.pid };

		while (true) {
			while (events.length > 0) yield events.shift();
			if (done) break;
			await new Promise((r) => {
				resolve = r;
			});
		}
	}
}

module.exports = { Shell };
