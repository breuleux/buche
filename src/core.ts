import { type IncomingDriverMessage } from "./driver-exchange/incoming.ts";
import { type OutgoingDriverMessage } from "./driver-exchange/outgoing.ts";
import { type IncomingInterfaceMessage } from "./interface-exchange/incoming.ts";
import { type OutgoingInterfaceMessage } from "./interface-exchange/outgoing.ts";
import { type CreationInfo, type Address } from "./driver-exchange/common.ts";
import { Machine } from "./machine.ts";
import { Prompt } from "./prompt.ts";
import { Cell, Echo } from "./cell.ts";
import { Zone } from "./zone.ts";
import { BucheError, type ErrorMessage } from "./utils.ts";

export type InM = IncomingDriverMessage | IncomingInterfaceMessage
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

export class Buche extends Machine<InM, OutM> {
    handlers!: HandlerT;
    hierarchy: Record<string, ComponentData>;

    constructor(args: BucheArguments) {
        super();
        this.handlers = args.handlers;
        this.hierarchy = {"[]": {zones: args.initialZones}};
    }

    async* process(input: InM): AsyncIterable<OutM> {
        try {
            yield* this.handlers[input.type](this, input);
        }
        catch (err: any) {
            if (err instanceof BucheError) {
                err.errorData.input = input;
                yield err.errorData;
            }
            else {
                yield {
                    type: "error",
                    code: "internal",
                    reason: err.toString(),
                    input: err,
                }
            }
        }
    }

    addressKey(a: Address) {
        return JSON.stringify(a);
    }

    get(addr: Address): ComponentData {
        const key = this.addressKey(addr);
        if (!(key in this.hierarchy)) {
            throw new BucheError({
                type: "error",
                code: "missingcell",
                reason: `Cell at ${key} is missing`,
            });
        }
        return this.hierarchy[key];
    }

    fresh(addr: Address, allowEcho: boolean = true): ComponentData {
        const key = this.addressKey(addr);
        let c = this.hierarchy[key];
        if (c) {
            if (c.cell || c.prompt || (!allowEcho && c.echo)) {
                throw new BucheError({
                    type: "error",
                    code: "exists",
                    reason: `An element already exists at address ${addr}`,
                });
            }
        }
        else {
            c = this.hierarchy[key] = {zones: {}};
        }
        return c;
    }

    findPlace(info: CreationInfo): LocationResult {
        const zoneName = info.zone || "@";
        const arr = Array.from(info.from) as Address;
        let prompt: Prompt | null = null;
        let zone: Zone | null = null;
        while (true) {
            const key = this.addressKey(arr);
            const data = this.hierarchy[key];
            if (prompt === null && data?.prompt) {
                prompt = data?.prompt;
            }
            if (zone === null && data && data.zones && zoneName in data.zones) {
                zone = data.zones[zoneName];
            }
            if (arr.length === 0) {
                break;
            }
            arr.pop();
        }
        if (zone === null) {
            throw new BucheError({
                type: "error",
                code: "nozone",
                reason: `No zone named ${zoneName} could be found`,
                input: info,
            })
        }
        return { prompt, zone };
    }
}
