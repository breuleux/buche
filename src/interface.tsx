import type { IncomingInterfaceMessage } from "./interface-exchange/incoming";
import type {
    CellCommandMessage,
    OutgoingInterfaceMessage,
    ProblemMessage,
    UpdateComponentMessage,
} from "./interface-exchange/outgoing";
import { AsyncQueue } from "./process";
import type { BucheErrorMessage } from "./utils";
import { extractZones, type Zone } from "./zone";

export interface Interface {
    interactions: AsyncIterable<IncomingInterfaceMessage | BucheErrorMessage>;
    processMessage: (message: OutgoingInterfaceMessage) => void;
    zones: Array<Zone>;
}

export interface BucheInterfaceArguments {
    container: Element;
    template: Element | string;
}

export class InertInterface implements Interface {
    interactions: AsyncIterable<IncomingInterfaceMessage | BucheErrorMessage>;
    zones: Array<Zone>;

    constructor(
        interactions: AsyncIterable<IncomingInterfaceMessage | BucheErrorMessage>,
        zones: Array<Zone>,
    ) {
        this.interactions = interactions;
        this.zones = zones;
    }

    processMessage(message: OutgoingInterfaceMessage) {}
}

function reifyTemplate(template: Element | string): Element {
    if (typeof template !== "string") {
        return template;
    }
    const tpl = document.createElement("template");
    tpl.innerHTML = template;
    const element = tpl.content.firstElementChild;
    if (element === null) {
        throw new Error("Interface template did not produce an element");
    }
    return element;
}

export class BucheInterface implements Interface {
    container: Element;
    area: Element;
    interactions: AsyncIterable<IncomingInterfaceMessage | BucheErrorMessage>;
    zones: Array<Zone>;

    constructor(args: BucheInterfaceArguments) {
        this.container = args.container;
        this.area = reifyTemplate(args.template);
        this.zones = extractZones(this.area as HTMLElement);
        this.interactions = new AsyncQueue();
    }
    processMessage(message: OutgoingInterfaceMessage) {
        const handler = this[`handle$${message.type}`];
        (handler as (m: OutgoingInterfaceMessage) => void)(message);
    }
    handle$update_component(message: UpdateComponentMessage) {}
    handle$cell_command(message: CellCommandMessage) {}
    handle$problem(message: ProblemMessage) {}
}
