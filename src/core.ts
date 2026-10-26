import { handlers as driverHandlers } from "../src/driver-exchange/incoming.ts";
import { handlers as interfaceHandlers } from "../src/interface-exchange/incoming.ts";
import { Cell } from "./cell.ts";
import type { CreationInfo } from "./driver-exchange/common.ts";
import type { IncomingDriverMessage } from "./driver-exchange/incoming.ts";
import type { OutgoingDriverMessage, SignalRequest } from "./driver-exchange/outgoing.ts";
import { type EchoConfiguration, echoConfiguration } from "./echo.ts";
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
const ZONE_ALIASES: Record<string, string> = { l: "left", r: "right", u: "up", d: "down" };

/** What is being placed: cells default inline, prompts in a new tab. */
export type Kind = "cell" | "prompt";

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
     * short for left/right/up/down. By default, a cell goes in a tab beside
     * the entry showing its parent (a process's later outputs: beside the
     * first one), else inline; a prompt goes in a new tab, linked to the
     * prompt it lands next to.
     */
    targetFor(entry: Entry, zone: ZoneDescriptor | null | undefined, kind: Kind): Target {
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
     * A new cell or prompt at `addr` takes over its parent's placeholder, if
     * it is still unclaimed and can: the placeholder entry moves to `addr`
     * (so whatever shows it now shows the claimant), and keeps its place. A
     * prompt can't go inline, so it doesn't take an inline placeholder.
     * Returns the claimant, or null if there was nothing to claim.
     */
    claim(addr: Address, kind: Kind): Entry | null {
        const parent = addr.length ? this.hierarchy.getAt(addr.slice(0, -1)) : null;
        const ph = parent?.primary;
        const field = addr[addr.length - 1];
        if (!ph?.placeholder || field === PLACEHOLDER) {
            return null;
        }
        if (kind === "prompt" && ph.target?.zone === "inline") {
            return null;
        }
        const existing = parent!.children[field];
        if (existing && (existing.visual || Object.keys(existing.children).length)) {
            return null;
        }
        ph.placeholder = false;
        // A view (`$stdout`, `$gui`...) claiming it brings its own look: the
        // one it was configured with, else its parent's.
        if (field.startsWith("$")) {
            const look = (existing ?? parent!).echo;
            const before = JSON.stringify([ph.echo.label, ph.echo.color, ph.echo.icon]);
            ph.echo.configure({ label: look.label, color: look.color, icon: look.icon });
            if (JSON.stringify([ph.echo.label, ph.echo.color, ph.echo.icon]) !== before) {
                this.sendInterface({ type: "update_entry", entry: ph });
            }
        }
        ph.rename(field);
        return ph;
    }

    /**
     * Declare (the first time) the placeholder of a configured entry: an
     * empty cell standing in for whatever it shows first, placed where the
     * entry was configured to go. It represents the entry, so it can take
     * input (and signals) before anything else exists.
     */
    ensurePlaceholder(entry: Entry, zone: ZoneDescriptor | null | undefined): void {
        // (Nor for what shows itself already, nor for a placeholder's address:
        // a retune of one, maybe of one that doesn't exist. Nor for a view,
        // `$stdout` say, configured ahead of its output: it claims its
        // parent's placeholder, or gets a cell, when its output comes.)
        if (
            entry.primary ||
            entry.visual ||
            entry.field === PLACEHOLDER ||
            (entry.field?.startsWith("$") && entry.parent !== this.hierarchy) ||
            entry === this.hierarchy
        ) {
            return;
        }
        const ph = entry.getAt([PLACEHOLDER], true)!;
        ph.placeholder = true;
        ph.represents = entry.address();
        ph.echo.configure(echoConfiguration(entry.echo));
        ph.setCell(new Cell({}));
        ph.echo.status = { status: "running" };
        ph.target = this.targetFor(entry, zone, "cell");
        entry.primary = ph;
        this.sendInterface({ type: "update_cell", target: ph.target, entry: ph });
    }

    /**
     * Give `entry` a cell if it shows nothing yet (output arriving with no
     * `cell_configure`), placed by default. The top entry (the driver's own
     * output) shows nothing.
     */
    ensureCell(entry: Entry): void {
        if (entry.visual || entry === this.hierarchy) {
            return;
        }
        entry.setCell(new Cell({}));
        entry.target ??= this.targetFor(entry, null, "cell");
        if (entry.echo.status.status === "absent") {
            entry.echo.status = { status: "running" };
        }
        this.sendInterface({ type: "update_cell", target: entry.target, entry });
    }

    /**
     * Get (creating it if needed) the entry at `message.from` and apply an
     * echo configuration to it: the shared {@link EchoConfiguration} fields
     * merge into its echo, and a provided `represents` onto the entry itself.
     */
    ensure(message: EchoConfiguration & CreationInfo) {
        const fresh = this.hierarchy.getAt(message.from, false) === null;
        const post = this.hierarchy.getAt(message.from, true)!;
        // A `$` entry (`$stdout`, `$gui`...) is a view of its parent: it
        // stands for it unless told otherwise. It shows the parent's echo too.
        if (fresh && post.field?.startsWith("$") && post.parent !== this.hierarchy) {
            post.represents = post.parent!.address();
            post.echo.configure({ ...echoConfiguration(post.parent!.echo), id: undefined });
        }
        post.echo.configure(message);
        if (message.represents !== undefined) {
            post.represents = message.represents;
        }
        if (message.status !== undefined) {
            this.setLiveStatus(post.representative() ?? post, message.status);
        }
        // What a configured entry says about itself, its views show too.
        for (const child of this.views(post)) {
            child.echo.configure({ ...message, id: undefined, represents: undefined });
        }
        return post;
    }

    /** An entry's views: its `$` children, and what shows it (its primary). */
    private views(entry: Entry): Entry[] {
        return Object.values(entry.children).filter(
            (child) => child.field?.startsWith("$") || child === entry.primary,
        );
    }

    /**
     * After a reconfiguration that changes how `entry` looks (label, colour,
     * icon, submission): bring what already shows it, or its views, up to
     * date (nothing is installed).
     */
    relook(entry: Entry, message: EchoConfiguration): void {
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
     * The entry that output sent from `message.from` goes to: it claims its
     * parent's placeholder, or gets a cell of its own, if it shows nothing yet.
     */
    output(message: CreationInfo): Entry {
        this.claim(message.from, "cell");
        const entry = this.ensure(message);
        this.ensureCell(entry);
        return entry;
    }

    /** Switch a live entry between running and standby (a spent one stays). */
    private setLiveStatus(entry: Entry, status: "running" | "standby"): void {
        const current = entry.echo.status.status;
        if (current === "done" || current === "error" || current === status) {
            return;
        }
        entry.echo.status = { status };
        this.sendInterface({ type: "update_entry", entry });
    }
}

/** The configuration fields that change how an entry looks. */
const LOOK = ["label", "color", "icon", "submission"] as const;

const baseHandlers = {
    buche_error(buche: Buche, obj: BucheErrorMessage): void {
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
