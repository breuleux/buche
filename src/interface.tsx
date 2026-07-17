import type { IncomingInterfaceMessage } from "./interface-exchange/incoming";
import type {
    CellCommandMessage,
    OutgoingInterfaceMessage,
    ProblemMessage,
    UpdateComponentMessage,
} from "./interface-exchange/outgoing";
import type { AsyncQueue } from "./process";
import type { BucheErrorMessage } from "./utils";
import { extractZones, type Zone } from "./zone";

export interface Interface {
    interactions: AsyncQueue<IncomingInterfaceMessage | BucheErrorMessage>;
    processMessage: (message: OutgoingInterfaceMessage) => void;
    zones: Array<Zone>;
}

export interface BucheInterfaceArguments {
    container: Element;
    template: Element | string;
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

export class BucheInterface {
    container: Element;
    area: Element;
    zones: Array<Zone>;
    constructor(args: BucheInterfaceArguments) {
        this.container = args.container;
        this.area = reifyTemplate(args.template);
        this.zones = extractZones(this.area as HTMLElement);
    }
    processMessage(message: OutgoingInterfaceMessage) {
        const handler = this[`handle$${message.type}`];
        (handler as (m: OutgoingInterfaceMessage) => void)(message);
    }
    handle$update_component(message: UpdateComponentMessage) {}
    handle$cell_command(message: CellCommandMessage) {}
    handle$problem(message: ProblemMessage) {}
}
