import { handlers as driverHandlers } from "../src/driver-exchange/incoming.ts";
import { handlers as interfaceHandlers } from "../src/interface-exchange/incoming.ts";
import type { Cell, Echo } from "./cell.ts";
import type { Address, CreationInfo } from "./driver-exchange/common.ts";
import type { IncomingDriverMessage } from "./driver-exchange/incoming.ts";
import type { OutgoingDriverMessage } from "./driver-exchange/outgoing.ts";
import type { IncomingInterfaceMessage } from "./interface-exchange/incoming.ts";
import type { OutgoingInterfaceMessage } from "./interface-exchange/outgoing.ts";
import { Machine } from "./machine.ts";
import { outgoingDriverMessageTypes } from "./message-directory.ts";
import type { ProcessCommunicator } from "./process.ts";
import type { Prompt } from "./prompt.ts";
import { BucheError, type ErrorMessage, mergeIterables } from "./utils.ts";
import { Zone } from "./zone.ts";

export type InM = IncomingDriverMessage | IncomingInterfaceMessage;
export type OutM = OutgoingDriverMessage | OutgoingInterfaceMessage | ErrorMessage;
export type HandlerT = Record<string, (buche: Buche, message: InM) => AsyncIterable<OutM>>;

export interface BucheArguments {
    handlers: HandlerT;
    initialZones: Record<string, Zone>;
}

export interface LocationResult {
    prompt: Prompt | null;
    zone: Zone;
}

export interface ComponentData {
    echo?: Echo;
    cell?: Cell;
    prompt?: Prompt;
    zones: Record<string, Zone> | null;
}

export class Hierarchy {
    component?: ComponentData;
    children: Record<string, Hierarchy>;

    constructor(component?: ComponentData) {
        this.component = component;
        this.children = {};
    }

    getAt(addr: Address, create: boolean = false): Hierarchy | null {
        let node: Hierarchy = this;
        for (const segment of addr) {
            let child = node.children[segment];
            if (!child) {
                if (!create) {
                    return null;
                }
                child = node.children[segment] = new Hierarchy();
            }
            node = child;
        }
        return node;
    }

    /** Yield every component in this subtree (this node first, then descendants). */
    *iterateComponents(): Generator<ComponentData> {
        if (this.component) {
            yield this.component;
        }
        for (const child of Object.values(this.children)) {
            yield* child.iterateComponents();
        }
    }
}

export class Buche extends Machine<InM, OutM> {
    handlers!: HandlerT;
    hierarchy: Hierarchy;

    constructor(args: BucheArguments) {
        super();
        this.handlers = args.handlers;
        this.hierarchy = new Hierarchy({ zones: args.initialZones });
    }

    async *process(input: InM): AsyncIterable<OutM> {
        try {
            yield* this.handlers[input.type](this, input);
        } catch (err: any) {
            if (err instanceof BucheError) {
                err.errorData.input = input;
                yield err.errorData;
            } else {
                /* node:coverage disable */
                yield {
                    type: "error",
                    code: "internal",
                    reason: err.toString(),
                    input: err,
                };
                /* node:coverage enable */
            }
        }
    }

    addressKey(a: Address) {
        return JSON.stringify(a);
    }

    get(addr: Address): ComponentData {
        const node = this.hierarchy.getAt(addr, false);
        if (!node?.component) {
            throw new BucheError({
                type: "error",
                code: "missingcell",
                reason: `Cell at ${this.addressKey(addr)} is missing`,
            });
        }
        return node.component;
    }

    fresh(addr: Address, allowEcho: boolean = true): ComponentData {
        const node = this.hierarchy.getAt(addr, true) as Hierarchy;
        let c = node.component;
        if (c) {
            if (c.cell || c.prompt || (!allowEcho && c.echo)) {
                throw new BucheError({
                    type: "error",
                    code: "exists",
                    reason: `An element already exists at address ${addr}`,
                });
            }
        } else {
            c = node.component = { zones: {} };
        }
        return c;
    }

    findPlace(info: CreationInfo): LocationResult {
        const zoneName = info.zone || "@";
        const arr = Array.from(info.from) as Address;
        let prompt: Prompt | null = null;
        let zone: Zone | null = null;

        let node: Hierarchy | undefined = this.hierarchy;
        for (let i = 0; node; node = node.children[arr[i++]]) {
            const data = node.component;
            if (data?.prompt) {
                prompt = data.prompt;
            }
            if (data?.zones && zoneName in data.zones) {
                zone = data.zones[zoneName];
            }
        }
        if (zone === null) {
            throw new BucheError({
                type: "error",
                code: "nozone",
                reason: `No zone named ${zoneName} could be found`,
                input: info,
            });
        }
        return { prompt, zone };
    }
}

async function* _awrap<T>(stream: AsyncGenerator<T>, fn?: (arg: T) => void) {
    if (fn) {
        for await (const x of stream) {
            fn(x);
            yield x;
        }
    } else {
        yield* stream;
    }
}

const baseHandlers = {
    async *error(buche: Buche, obj: ErrorMessage): AsyncGenerator<OutM> {
        console.log("TODO");
    },
};

interface BucheRunArguments {
    process: ProcessCommunicator;
    interface: AsyncGenerator<InM>;
    loggers: {
        driverIn?: (arg: InM) => void;
        interfaceIn?: (arg: InM) => void;
        driverOut?: (arg: OutM) => void;
        interfaceOut?: (arg: OutM) => void;
    };
    // inLogger?: (arg: InM) => void;
    // outLogger?: (arg: OutM) => void;
}

export async function* bucheRun(args: BucheRunArguments) {
    const buche = new Buche({
        handlers: Object.assign(
            baseHandlers as unknown as HandlerT,
            driverHandlers,
            interfaceHandlers,
        ),
        initialZones: { "@": new Zone() },
    });
    const instream = mergeIterables(
        _awrap(args.process.messages() as AsyncGenerator<InM>, args.loggers.driverIn),
        _awrap(args.interface, args.loggers.interfaceIn),
    );
    const stream = buche.stream(instream);
    for await (const message of stream) {
        if (message.type in outgoingDriverMessageTypes) {
            args.loggers.driverOut?.(message);
            args.process.send(message as OutgoingDriverMessage);
        } else {
            args.loggers.interfaceOut?.(message);
            yield message;
        }
    }
}

// export interface BucheConfig {
//     cellTypes: Record<string, new (config: CellConfiguration) => Cell>;
// }

// export class Buche extends Machine<InM, OutM> implements BucheConfig {
//     cellTypes!: Record<string, new (config: CellConfiguration) => Cell>;

//     cells: Record<string, Cell> = {};

//     constructor(config: BucheConfig) {
//         super();
//         Object.assign(this, config);
//     }
// }
