import { handlers as driverHandlers } from "../src/driver-exchange/incoming.ts";
import { handlers as interfaceHandlers } from "../src/interface-exchange/incoming.ts";
import { Cell, type CellConfiguration } from "./cell.ts";
import type { BaseMessage, CreationInfo } from "./driver-exchange/common.ts";
import type { IncomingDriverMessage } from "./driver-exchange/incoming.ts";
import type { OutgoingDriverMessage, SignalRequest } from "./driver-exchange/outgoing.ts";
import { ComponentData } from "./exchange.ts";
import type { Interface } from "./interface.tsx";
import type { IncomingInterfaceMessage } from "./interface-exchange/incoming.ts";
import type { OutgoingInterfaceMessage, ProblemMessage } from "./interface-exchange/outgoing.ts";
import type { ProcessCommunicator } from "./process.ts";
import { Prompt, type PromptConfiguration } from "./prompt.ts";
import type { Address } from "./types.ts";
import { awrap, BucheError, type BucheErrorMessage, Hierarchy, mergeIterables } from "./utils.ts";
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
    hierarchy: Hierarchy<ComponentData>;
    sendDriver: (message: OutgoingDriverMessage) => void;
    sendInterface: (message: OutgoingInterfaceMessage) => void;

    constructor(args: BucheArguments) {
        this.hierarchy = new Hierarchy(new ComponentData(args.initialZones));
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
        let c = node?.entry;
        if (!c) {
            if (!create) {
                throw new BucheError({
                    type: "buche_error",
                    code: "missingcell",
                    reason: `Cell at ${JSON.stringify(addr)} is missing`,
                });
            }
            c = (node as Hierarchy<ComponentData>).entry = new ComponentData();
        }
        return c;
    }

    findPlace(info: CreationInfo): LocationResult {
        const zoneName = info.zone || "@";
        const arr = Array.from(info.from) as Address;
        let prompt: Prompt | null = null;
        let zone: Zone | null = null;

        let node: Hierarchy<ComponentData> | undefined = this.hierarchy;
        for (let i = 0; node; node = node.children[arr[i++]]) {
            const data = node.entry;
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
        obj: (CellConfiguration | PromptConfiguration) & CreationInfo & BaseMessage,
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
            const cconf: CellConfiguration = obj as CellConfiguration;
            if (component.cell) {
                component.cell.configure(cconf);
            } else {
                const cell = new Cell(cconf, { address: obj.from });
                component.setCell(cell);
            }
        } else {
            const pconf: PromptConfiguration = obj as PromptConfiguration;
            if (component.prompt) {
                component.prompt.configure(pconf);
            } else {
                const prompt = new Prompt(pconf, { address: obj.from });
                component.setPrompt(prompt);
            }
        }
        this.sendInterface({
            type: "update_component",
            zone: zone,
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
            return this.configure(type, obj as PromptConfiguration & BaseMessage);
        }
        return c;
    }
}

const baseHandlers = {
    buche_error(buche: Buche, obj: BucheErrorMessage): void {
        let component: ComponentData | undefined;
        if (Array.isArray(obj.input?.from)) {
            // If the original input had an address, find the closest
            // non-null component in the hierarchy.
            let node: Hierarchy<ComponentData> = buche.hierarchy;
            for (const segment of obj.input.from) {
                const child = node.children[segment];
                if (!child) {
                    break;
                }
                node = child;
            }
            component = node.entry;
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
