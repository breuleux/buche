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
					if (result[Symbol.asyncIterator]) {
						yield withErrorCatch(result, obj.cell_id ?? null);
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
			echo: obj.echo ?? obj.text,
		});
	}

	async handle$wait(obj) {
		await new Promise((r) => setTimeout(r, obj.seconds * 1000));
	}

	async handle$input(obj) {
		const child = this._processes.get(obj.cell_id);
		if (child) child.stdin.write(obj.text);
	}

	async handle$close_stdin(obj) {
		const child = this._processes.get(obj.cell_id);
		if (child) child.stdin.end();
	}

	async *handle$run(obj) {
		const cell_id = obj.cell_id ?? randomUUID();
		if (this._processes.has(cell_id))
			throw new Error(`Process ${cell_id} already exists`);

		const [cmd, ...args] = [obj.command, ...(obj.args || [])];

		// Open a PTY pair for each stream so the child's isatty() returns true,
		// while we still read stdout and stderr separately from the master sides.
		const stdoutPty = pty.open({ cols: 220, rows: 50 });
		const stderrPty = pty.open({ cols: 220, rows: 50 });
		const { O_RDWR, O_NOCTTY } = fs.constants;
		const stdoutSlave = fs.openSync(stdoutPty.ptsName, O_RDWR | O_NOCTTY);
		const stderrSlave = fs.openSync(stderrPty.ptsName, O_RDWR | O_NOCTTY);

		const child = spawn(cmd, args, {
			stdio: ["pipe", stdoutSlave, stderrSlave],
			env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
		});

		// Parent no longer needs the slave fds — child inherited them.
		fs.closeSync(stdoutSlave);
		fs.closeSync(stderrSlave);

		this._processes.set(cell_id, child);

		const startEvent = {
			type: "new",
			cell_id,
			mode: "text",
			process_id: child.pid,
		};
		if (obj.echo) {
			startEvent.data = { text: `> ${obj.echo}` };
		}
		yield startEvent;

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

		stdoutPty._socket.on("data", (d) => console.log(d));
		stdoutPty._socket.on("data", (d) =>
			push({
				type: "send",
				cell_id,
				data: { stream: "stdout", text: d.toString() },
			}),
		);
		stderrPty._socket.on("data", (d) =>
			push({
				type: "send",
				cell_id,
				data: { stream: "stderr", text: d.toString() },
			}),
		);
		// EIO means the slave side closed (process exited) — not a real error.
		stdoutPty._socket.on("error", (e) => {
			if (e.code !== "EIO") push(makeError(e, cell_id));
		});
		stderrPty._socket.on("error", (e) => {
			if (e.code !== "EIO") push(makeError(e, cell_id));
		});

		child.on("close", (return_code) => {
			stdoutPty._socket.destroy();
			stderrPty._socket.destroy();
			this._processes.delete(cell_id);
			push({ type: "close", cell_id, return_code: return_code ?? 0 });
			done = true;
			if (resolve) {
				const r = resolve;
				resolve = null;
				r();
			}
		});
		child.on("error", (err) => {
			stdoutPty._socket.destroy();
			stderrPty._socket.destroy();
			this._processes.delete(cell_id);
			push(makeError(err, cell_id));
			push({ type: "close", cell_id, return_code: 1 });
			done = true;
			if (resolve) {
				const r = resolve;
				resolve = null;
				r();
			}
		});

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
