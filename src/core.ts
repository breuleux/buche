import { handlers as driverHandlers } from "../src/driver-exchange/incoming.ts";
import { handlers as interfaceHandlers } from "../src/interface-exchange/incoming.ts";
import type { CreationInfo } from "./driver-exchange/common.ts";
import type { IncomingDriverMessage } from "./driver-exchange/incoming.ts";
import type { OutgoingDriverMessage, SignalRequest } from "./driver-exchange/outgoing.ts";
import type { EchoConfiguration } from "./echo.ts";
import { Entry } from "./entry.ts";
import type { Interface } from "./interface.tsx";
import type { IncomingInterfaceMessage } from "./interface-exchange/incoming.ts";
import type { OutgoingInterfaceMessage, ProblemMessage } from "./interface-exchange/outgoing.ts";
import type { ProcessCommunicator } from "./process.ts";
import type { Prompt } from "./prompt.ts";
import type { Address } from "./types.ts";
import { awrap, BucheError, type BucheErrorMessage, mergeIterables } from "./utils.ts";
import { type Zone, zoneMap } from "./zone.ts";

export type InM = IncomingDriverMessage | IncomingInterfaceMessage | BucheErrorMessage;
export type OutM = OutgoingDriverMessage | OutgoingInterfaceMessage;
export type HandlerT = Record<string, (buche: Buche, message: InM) => void>;

export interface BucheArguments {
    initialZones: Record<string, Zone>;
    sendDriver: (message: OutgoingDriverMessage) => void;
    sendInterface: (message: OutgoingInterfaceMessage) => void;
}

export interface LocationResult {
    prompt: Prompt | null;
    zone: Zone;
}

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

    constructor(args: BucheArguments) {
        this.hierarchy = new Entry({ zones: args.initialZones });
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
     * The zone named by `info.zone` for `entry`, looked up by bubbling up its
     * ancestors: at each one, the zones it defines (a configured entry answers
     * here both by name and — for a nameless request — through `""`, its
     * placement). A nameless request (null, absent or "") tries "@" first at
     * each ancestor, then that ancestor's `""`. The root defines every zone of
     * the layout, as a last resort.
     */
    findPlace(entry: Entry, info: CreationInfo): Zone {
        const zoneName = info.zone === "" ? null : (info.zone ?? null);
        let e: Entry | undefined = entry.parent;
        while (e) {
            if (zoneName !== null) {
                if (zoneName in e.zones) {
                    return e.zones[zoneName];
                }
            } else {
                if ("@" in e.zones) {
                    return e.zones["@"];
                }
                if ("" in e.zones) {
                    return e.zones[""];
                }
            }
            e = e.parent;
        }
        throw new BucheError({
            type: "buche_error",
            code: "nozone",
            reason: `No zone named ${zoneName ?? "@"} could be found`,
            input: info,
        });
    }

    /**
     * Get (creating it if needed) the entry at `message.from` and apply an
     * echo configuration to it: the shared {@link EchoConfiguration} fields
     * merge into its echo, and a provided `represents` onto the entry itself.
     */
    ensure(message: EchoConfiguration & CreationInfo) {
        const post = this.hierarchy.getAt(message.from, true)!;
        post.echo.configure(message);
        if (message.represents !== undefined) {
            post.represents = message.represents;
        }
        return post;
    }
}

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
        initialZones: zoneMap(args.interface.zones),
        sendDriver(outMessage: OutgoingDriverMessage) {
            args.loggers.driverOut?.(outMessage);
            if (
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
