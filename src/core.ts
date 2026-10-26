import { handlers as driverHandlers } from "../src/driver-exchange/incoming.ts";
import { handlers as interfaceHandlers } from "../src/interface-exchange/incoming.ts";
import {
    type CellCommand,
    type CellConfiguration,
    type CellKind,
    cellConfiguration,
    commandKind,
    isSpent,
} from "./cell.ts";
import type { CreationInfo } from "./driver-exchange/common.ts";
import type { IncomingDriverMessage } from "./driver-exchange/incoming.ts";
import type { OutgoingDriverMessage, SignalRequest } from "./driver-exchange/outgoing.ts";
import { Entry, PLACEHOLDER } from "./entry.ts";
import type { Interface } from "./interface.tsx";
import type { IncomingInterfaceMessage } from "./interface-exchange/incoming.ts";
import type { OutgoingInterfaceMessage, ProblemMessage } from "./interface-exchange/outgoing.ts";
import type { ProcessCommunicator } from "./process.ts";
import type { Address, Target, ZoneDescriptor } from "./types.ts";
import { awrap, BucheError, type BucheErrorMessage, mergeIterables } from "./utils.ts";

export type InM = IncomingDriverMessage | IncomingInterfaceMessage | BucheErrorMessage;
export type OutM = OutgoingDriverMessage | OutgoingInterfaceMessage;
export type HandlerT = Record<string, (buche: Buche, message: InM) => void>;

export interface BucheArguments {
    sendDriver: (message: OutgoingDriverMessage) => void;
    sendInterface: (message: OutgoingInterfaceMessage) => void;
}

/** Short names of the reserved zones. */
const ZONE_ALIASES: Record<string, string> = {
    l: "left",
    r: "right",
    u: "up",
    d: "down",
    sl: "sleft",
    sr: "sright",
    su: "sup",
    sd: "sdown",
    f: "float",
};

export class Buche {
    handlers: HandlerT = Object.assign(
        {} as HandlerT,
        baseHandlers,
        driverHandlers,
        interfaceHandlers,
    );
    hierarchy: Entry;
    sendDriver: (message: OutgoingDriverMessage) => void;
    sendInterface: (message: OutgoingInterfaceMessage) => void;

    /** Counter behind the `request_id` of outgoing parses (see user_input). */
    requestSeq = 0;

    /** Counter behind the addresses of the drivers started (see user_spawn). */
    driverSeq = 0;

    constructor(args: BucheArguments) {
        this.hierarchy = new Entry({});
        this.sendDriver = args.sendDriver;
        this.sendInterface = args.sendInterface;
    }

    handle(input: InM) {
        try {
            this.handlers[input.type](this, input);
        } catch (err: any) {
            let problem: ProblemMessage;
            if (err instanceof BucheError) {
                err.errorData.input = input;
                problem = Object.assign({}, err.errorData, {
                    type: "problem",
                }) as unknown as ProblemMessage;
            } else {
                /* node:coverage disable */
                problem = {
                    type: "problem",
                    code: "internal",
                    reason: err.toString(),
                    input: err,
                };
                /* node:coverage enable */
            }
            // Full reference for debugging; the toast the interface pops only
            // carries the short code/reason.
            console.error("[buche] problem while handling message:", input, err);
            this.sendInterface(problem);
        }
    }

    /**
     * Get the component container at `addr`. When `create` is false, throws
     * `missingcell` if there is none. When `create` is true, an empty container
     * is created and returned if one does not already exist.
     */
    get(addr: Address, create: boolean = false): Entry {
        const node = this.hierarchy.getAt(addr, create);
        const c = node;
        if (!c) {
            throw new BucheError({
                type: "buche_error",
                code: "missingcell",
                reason: `Cell at ${JSON.stringify(addr)} is missing`,
            });
        }
        return c;
    }

    /**
     * What `entry` is placed relative to: the closest ancestor that shows
     * something (or the entry showing it: its primary, unless that is `entry`
     * itself). Null at the top.
     */
    anchorOf(entry: Entry): Entry | null {
        for (let e = entry.parent; e; e = e.parent) {
            if (e.visual) {
                return e;
            }
            if (e.primary && e.primary !== entry) {
                return e.primary;
            }
        }
        return null;
    }

    /**
     * Where a new cell or prompt for `entry` goes, given the zone it asks for
     * (null or "": the default). Leading "@" are ignored, and l/r/u/d are
     * short for left/right/up/down (sl/sr/su/sd for sleft/sright/sup/sdown, f
     * for float). By default, a cell goes in a tab beside
     * the entry showing its parent (a process's later outputs: beside the
     * first one), else inline; a prompt goes in a new tab, linked to the
     * prompt it lands next to.
     */
    targetFor(entry: Entry, zone: ZoneDescriptor | null | undefined, kind: CellKind): Target {
        let name = (zone ?? "").replace(/^@/, "");
        name = ZONE_ALIASES[name] ?? name;
        const anchor = this.anchorOf(entry);
        const at = anchor?.address() ?? null;
        if (name !== "") {
            return { zone: name, anchor: at };
        }
        if (kind === "prompt") {
            return { zone: "tab", anchor: at, link: true };
        }
        const sibling = entry.parent?.primary;
        if (sibling && sibling !== entry && sibling.visual) {
            return { zone: "tab", anchor: sibling.address() };
        }
        return { zone: "inline", anchor: at };
    }

    /**
     * A new cell of `kind` at `addr` takes over its parent's placeholder, if
     * it is still unclaimed and can: the placeholder entry moves to `addr`
     * (so whatever shows it now shows the claimant), and keeps its place. Its
     * cell takes the claimant's kind — a prompt's is left for the claimant to
     * make (it is no cell of the placeholder's). A prompt can't go inline, so
     * it doesn't take an inline placeholder. Returns the claimant, or null if
     * there was nothing to claim.
     */
    claim(addr: Address, kind: CellKind): Entry | null {
        const parent = addr.length ? this.hierarchy.getAt(addr.slice(0, -1)) : null;
        const ph = parent?.primary;
        const field = addr[addr.length - 1];
        if (ph?.cell.kind !== "pending" || field === PLACEHOLDER) {
            return null;
        }
        if (kind === "prompt" && ph.target?.zone === "inline") {
            return null;
        }
        const existing = parent!.children[field];
        if (existing && (existing.visual || Object.keys(existing.children).length)) {
            return null;
        }
        ph.replaceCell(kind);
        // A claimant configured beforehand brings the look it was given (the
        // placeholder has its process's).
        if (existing) {
            const look = existing.cell;
            const before = JSON.stringify([ph.cell.label, ph.cell.color, ph.cell.icon]);
            ph.cell.configure({ label: look.label, color: look.color, icon: look.icon });
            if (JSON.stringify([ph.cell.label, ph.cell.color, ph.cell.icon]) !== before) {
                this.sendInterface({ type: "update_entry", entry: ph });
            }
        }
        ph.rename(field);
        return ph;
    }

    /**
     * Declare (the first time) the placeholder of a configured entry: an
     * empty cell standing in for whatever it shows first, placed where the
     * entry was configured to go. It can take input (and signals) before
     * anything else exists: its signals bubble up to the entry (see
     * user_signal), and typing into it makes it the entry's `$stdout`.
     */
    ensurePlaceholder(entry: Entry, zone: ZoneDescriptor | null | undefined): void {
        // (Nor for what shows itself already, nor for a placeholder's address:
        // a retune of one, maybe of one that doesn't exist.)
        if (
            entry.primary ||
            entry.visual ||
            entry.field === PLACEHOLDER ||
            entry === this.hierarchy
        ) {
            return;
        }
        const ph = entry.getAt([PLACEHOLDER], true)!;
        ph.replaceCell("pending");
        ph.cell.configure(cellConfiguration(entry.cell));
        ph.cell.status = { status: "running" };
        ph.target = this.targetFor(entry, zone, "pending");
        entry.primary = ph;
        this.sendInterface({ type: "update_cell", target: ph.target, entry: ph });
    }

    /**
     * Get (creating it if needed) the entry at `message.from` and apply a
     * cell configuration to it: the {@link CellConfiguration} fields merge
     * into its cell (and its views', see `views`).
     */
    ensure(message: CellConfiguration & CreationInfo) {
        const post = this.hierarchy.getAt(message.from, true)!;
        post.cell.configure(message);
        if (message.status !== undefined) {
            this.setLiveStatus(post, message.status);
        }
        // What a configured entry says about itself, its views show too.
        for (const child of this.views(post)) {
            child.cell.configure({ ...message, id: undefined });
        }
        return post;
    }

    /** An entry's views: the children of a group (a process's terminal,
     *  frame, placeholder...). What is under a cell (a prompt's commands, say)
     *  is no view of it. */
    private views(entry: Entry): Entry[] {
        return entry.visual ? [] : Object.values(entry.children);
    }

    /**
     * After a reconfiguration that changes how `entry` looks (label, colour,
     * icon, submission): bring what already shows it, or its views, up to
     * date (nothing is installed).
     */
    relook(entry: Entry, message: CellConfiguration): void {
        if (!LOOK.some((k) => message[k] !== undefined)) {
            return;
        }
        for (const e of [entry, ...this.views(entry)]) {
            if (e.visual) {
                this.sendInterface({ type: "update_entry", entry: e });
            }
        }
    }

    /**
     * The entry that `command`, sent from `from`, goes to: one declared (by a
     * `configure` with a kind) as a cell of the kind the command is for.
     * Anything else is an error: cells are never made by what is sent to
     * them.
     */
    output(from: Address, command: CellCommand): Entry {
        const entry = this.hierarchy.getAt(from, false);
        if (!entry?.visual) {
            throw new BucheError({
                type: "buche_error",
                code: "undeclared",
                reason: `Nothing at ${JSON.stringify(from)} to send ${command.type} to (declare it with a configure first)`,
            });
        }
        this.checkKind(entry, commandKind(command));
        return entry;
    }

    /** Throw unless `entry` shows nothing yet or a cell of `kind`: an entry
     *  does not change kind. */
    checkKind(entry: Entry, kind: CellKind): void {
        const current = entry.cell.kind;
        if (current !== "group" && current !== kind) {
            throw new BucheError({
                type: "buche_error",
                code: "kindmismatch",
                reason: `The ${current} at ${JSON.stringify(entry.address())} is no ${kind}`,
            });
        }
    }

    /** Switch a live entry, and what is live under it, between running and
     *  standby (what is spent stays). */
    private setLiveStatus(entry: Entry, status: "running" | "standby"): void {
        for (const e of entry.walk()) {
            const current = e.cell.status.status;
            if (isSpent(current) || current === status || current === "absent") {
                continue;
            }
            e.cell.status = { status };
            this.sendInterface({ type: "update_entry", entry: e });
        }
    }
}

/** The configuration fields that change how an entry looks. */
const LOOK = ["label", "color", "icon", "submission"] as const;

const baseHandlers = {
    buche_error(buche: Buche, obj: BucheErrorMessage): void {
        // UNUSED: the interface reads only a problem's code and reason, so the
        // entry found here goes nowhere for now (and is passed as `component`
        // where ProblemMessage expects `entry`).
        let entry: Entry | undefined;
        if (Array.isArray(obj.input?.from)) {
            // If the original input had an address, find the closest
            // non-null component in the hierarchy.
            let node: Entry = buche.hierarchy;
            for (const segment of obj.input.from) {
                const child = node.children[segment];
                if (!child) {
                    break;
                }
                node = child;
            }
            entry = node;
        }
        console.error("[buche] error reported as problem:", obj, obj.input);
        buche.sendInterface(
            Object.assign({}, obj, {
                type: "problem",
                component: entry,
            }) as unknown as ProblemMessage,
        );
    },
};

export interface BucheRunArguments {
    process: ProcessCommunicator;
    interface: Interface;
    loggers: {
        driverIn?: (arg: InM) => void;
        interfaceIn?: (arg: InM) => void;
        driverOut?: (arg: OutM) => void;
        interfaceOut?: (arg: OutM) => void;
    };
}

export async function bucheRun(args: BucheRunArguments) {
    const buche = new Buche({
        sendDriver(outMessage: OutgoingDriverMessage) {
            args.loggers.driverOut?.(outMessage);
            if (outMessage.type === "spawn") {
                // (One driver only, here: see src/drivers.ts for hosts of more.)
                console.warn("[buche] spawn: not supported here", outMessage);
            } else if (
                outMessage.type === "signal" &&
                (outMessage as SignalRequest).to.length === 1 &&
                (outMessage as SignalRequest).to[0] === "$proc"
            ) {
                const signal = outMessage as SignalRequest;
                args.process.kill(signal.code);
            } else {
                args.process.send(outMessage);
            }
        },
        sendInterface(outMessage: OutgoingInterfaceMessage) {
            args.loggers.interfaceOut?.(outMessage);
            args.interface.processMessage(buche, outMessage);
        },
    });
    const instream = mergeIterables(
        awrap(args.process.messages() as AsyncGenerator<InM>, args.loggers.driverIn),
        awrap(args.interface.interactions as AsyncGenerator<InM>, args.loggers.interfaceIn),
    );
    for await (const inMessage of instream) {
        buche.handle(inMessage);
    }
}
