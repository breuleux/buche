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
import type { ProcessCommunicator } from "./process.ts";
import { Prompt, type PromptConfiguration } from "./prompt.ts";
import { BucheError, type BucheErrorMessage, mergeIterables } from "./utils.ts";
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

export class Buche {
    handlers: HandlerT = Object.assign(
        {} as HandlerT,
        baseHandlers,
        driverHandlers,
        interfaceHandlers,
    );
    hierarchy: Hierarchy;
    sendDriver: (message: OutgoingDriverMessage) => void;
    sendInterface: (message: OutgoingInterfaceMessage) => void;

    constructor(args: BucheArguments) {
        this.hierarchy = new Hierarchy({ zones: args.initialZones });
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
            this.sendInterface(problem);
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
    configure(type: "cell", obj: CellConfiguration & BaseMessage): ComponentData;
    configure(type: "prompt", obj: PromptConfiguration & BaseMessage): ComponentData;
    configure(
        type: "cell" | "prompt",
        obj: (CellConfiguration | PromptConfiguration) & BaseMessage,
    ): ComponentData {
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
        this.sendInterface({
            type: "update_component",
            component: component,
        });
        return component;
    }

    ensure(type: "cell", obj: CellConfiguration & BaseMessage): ComponentData;
    ensure(type: "prompt", obj: PromptConfiguration & BaseMessage): ComponentData;
    ensure(
        type: "cell" | "prompt",
        obj: (CellConfiguration | PromptConfiguration) & BaseMessage,
    ): ComponentData {
        const c = this.get(obj.from, true);
        if (type === "cell" && !c.cell) {
            return this.configure(type, obj);
        } else if (type === "prompt" && !c.prompt) {
            return this.configure(type, obj);
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
    buche_error(buche: Buche, obj: BucheErrorMessage): void {
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
        buche.sendInterface(
            Object.assign({}, obj, {
                type: "problem",
                component: component,
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
            args.interface.processMessage(outMessage);
        },
    });
    const instream = mergeIterables(
        _awrap(args.process.messages() as AsyncGenerator<InM>, args.loggers.driverIn),
        _awrap(args.interface.interactions as AsyncGenerator<InM>, args.loggers.interfaceIn),
    );
    for await (const inMessage of instream) {
        buche.handle(inMessage);
    }
}
