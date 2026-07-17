import { handlers as driverHandlers } from "../src/driver-exchange/incoming.ts";
import { handlers as interfaceHandlers } from "../src/interface-exchange/incoming.ts";
import { Cell, type CellConfiguration } from "./cell.ts";
import type { Address, BaseMessage, CreationInfo } from "./driver-exchange/common.ts";
import type { IncomingDriverMessage } from "./driver-exchange/incoming.ts";
import type { OutgoingDriverMessage, SignalRequest } from "./driver-exchange/outgoing.ts";
import type { Echo } from "./echo.ts";
import type { Interface } from "./interface.tsx";
import type { IncomingInterfaceMessage } from "./interface-exchange/incoming.ts";
import type { OutgoingInterfaceMessage, ProblemMessage } from "./interface-exchange/outgoing.ts";
import { Machine } from "./machine.ts";
import { outgoingDriverMessageTypes } from "./message-directory.ts";
import type { ProcessCommunicator } from "./process.ts";
import { Prompt, type PromptConfiguration } from "./prompt.ts";
import { BucheError, type BucheErrorMessage, mergeIterables } from "./utils.ts";
import { Zone, zoneMap } from "./zone.ts";

export type InM = IncomingDriverMessage | IncomingInterfaceMessage | BucheErrorMessage;
export type OutM = OutgoingDriverMessage | OutgoingInterfaceMessage;
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
                yield Object.assign({}, err.errorData, {
                    type: "problem",
                }) as unknown as ProblemMessage;
            } else {
                /* node:coverage disable */
                yield {
                    type: "problem",
                    code: "internal",
                    reason: err.toString(),
                    input: err,
                };
                /* node:coverage enable */
            }
        }
    }

    /**
     * Get the component container at `addr`. When `create` is false, throws
     * `missingcell` if there is none. When `create` is true, an empty container
     * is created and returned if one does not already exist.
     */
    get(addr: Address, create: boolean = false): ComponentData {
        const node = this.hierarchy.getAt(addr, create);
        let c = node?.component;
        if (!c) {
            if (!create) {
                throw new BucheError({
                    type: "buche_error",
                    code: "missingcell",
                    reason: `Cell at ${JSON.stringify(addr)} is missing`,
                });
            }
            c = (node as Hierarchy).component = { zones: {} };
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
                type: "buche_error",
                code: "nozone",
                reason: `No zone named ${zoneName} could be found`,
                input: info,
            });
        }
        return { prompt, zone };
    }

    /**
     * Create the cell/prompt at `obj.from`, or reconfigure it if one of the
     * same kind already lives there. Throws `exists` only when the other kind
     * occupies the address (a cell where a prompt lives, or vice versa).
     */
    configure(type: "cell", obj: CellConfiguration & BaseMessage): AsyncGenerator<OutM>;
    configure(type: "prompt", obj: PromptConfiguration & BaseMessage): AsyncGenerator<OutM>;
    async *configure(
        type: "cell" | "prompt",
        obj: (CellConfiguration | PromptConfiguration) & BaseMessage,
    ): AsyncGenerator<OutM> {
        const component = this.get(obj.from, true);
        const other = type === "cell" ? "prompt" : "cell";
        if (component[other]) {
            throw new BucheError({
                type: "buche_error",
                code: "exists",
                reason: `A ${other} already exists at address ${obj.from}, cannot configure a ${type}`,
            });
        }
        const { prompt: parentPrompt, zone } = this.findPlace(obj);
        if (type === "cell") {
            if (component.cell) {
                component.cell.configure(obj);
            } else {
                const cell = new Cell(obj, { zone, address: obj.from });
                cell.prompt = parentPrompt;
                Object.assign(component, { cell, zones: zoneMap(cell.makeZones(zone)) });
            }
        } else {
            if (component.prompt) {
                component.prompt.configure(obj);
            } else {
                const prompt = new Prompt(obj, { zone, address: obj.from });
                Object.assign(component, { prompt, zones: zoneMap(prompt.makeZones(zone)) });
            }
        }
        yield {
            type: "update_component",
            component: component,
        };
        return component;
    }

    ensure(type: "cell", obj: CellConfiguration & BaseMessage): AsyncGenerator<OutM>;
    ensure(type: "prompt", obj: PromptConfiguration & BaseMessage): AsyncGenerator<OutM>;
    async *ensure(
        type: "cell" | "prompt",
        obj: (CellConfiguration | PromptConfiguration) & BaseMessage,
    ): AsyncGenerator<OutM> {
        const c = this.get(obj.from, true);
        if (type === "cell" && !c.cell) {
            return yield* this.configure(type, obj);
        } else if (type === "prompt" && !c.prompt) {
            return yield* this.configure(type, obj);
        }
        return c;
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
    async *buche_error(buche: Buche, obj: BucheErrorMessage): AsyncGenerator<OutM> {
        let component: ComponentData | undefined;
        if (Array.isArray(obj.input?.from)) {
            // If the original input had an address, find the closest
            // non-null component in the hierarchy.
            let node: Hierarchy = buche.hierarchy;
            for (const segment of obj.input.from) {
                const child = node.children[segment];
                if (!child) {
                    break;
                }
                node = child;
            }
            component = node.component;
        }
        yield Object.assign({}, obj, {
            type: "problem",
            component: component,
        }) as unknown as ProblemMessage;
    },
};

export interface BucheFunctionArguments {
    process: ProcessCommunicator;
    loggers: {
        driverIn?: (arg: InM) => void;
        interfaceIn?: (arg: InM) => void;
        driverOut?: (arg: OutM) => void;
        interfaceOut?: (arg: OutM) => void;
    };
}

export interface BucheStreamArguments extends BucheFunctionArguments {
    interactionStream: AsyncGenerator<IncomingInterfaceMessage | BucheErrorMessage>;
}

export async function* bucheStream(args: BucheStreamArguments) {
    const buche = new Buche({
        handlers: Object.assign(
            baseHandlers as unknown as HandlerT,
            driverHandlers,
            interfaceHandlers,
        ),
        initialZones: zoneMap([new Zone("@")]),
    });
    const instream = mergeIterables(
        _awrap(args.process.messages() as AsyncGenerator<InM>, args.loggers.driverIn),
        _awrap(args.interactionStream, args.loggers.interfaceIn),
    );
    const stream = buche.stream(instream);
    for await (const message of stream) {
        if (
            message.type === "signal" &&
            (message as SignalRequest).to.length === 1 &&
            (message as SignalRequest).to[0] === "$proc"
        ) {
            const signal = message as SignalRequest;
            args.loggers.driverOut?.(signal);
            args.process.kill(signal.code);
            continue;
        }
        if (outgoingDriverMessageTypes.has(message.type)) {
            args.loggers.driverOut?.(message);
            args.process.send(message as OutgoingDriverMessage);
        } else {
            args.loggers.interfaceOut?.(message);
            yield message as OutgoingInterfaceMessage;
        }
    }
}

export interface BucheRunArguments extends BucheFunctionArguments {
    interface: Interface;
}

export async function bucheRun(args: BucheRunArguments) {
    const sargs: BucheStreamArguments = Object.assign(args, {
        interactionStream: args.interface.interactions[Symbol.asyncIterator](),
    });
    for await (const message of bucheStream(sargs as BucheStreamArguments)) {
        args.interface.processMessage(message);
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
