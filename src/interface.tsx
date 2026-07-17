import type { BasicTerm } from "./components/basic-term";
import type { EchoBox } from "./components/echo-box";
import type { PromptCollection } from "./components/prompt-collection";
import type { Buche } from "./core";
import type { IncomingInterfaceMessage } from "./interface-exchange/incoming";
import type {
    CellCommandMessage,
    OutgoingInterfaceMessage,
    ProblemMessage,
    UpdateComponentMessage,
} from "./interface-exchange/outgoing";
import type { Post } from "./post.ts";
import type { BucheErrorMessage } from "./utils";
import { AsyncQueue } from "./utils.ts";
import { extractZones, type Zone } from "./zone";

export interface Interface {
    interactions: AsyncIterable<IncomingInterfaceMessage | BucheErrorMessage>;
    processMessage: (buche: Buche, message: OutgoingInterfaceMessage) => void;
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

    processMessage(buche: Buche, message: OutgoingInterfaceMessage) {}
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
    processMessage(buche: Buche, message: OutgoingInterfaceMessage) {
        type HT = (buche: Buche, m: OutgoingInterfaceMessage) => void;
        const handler = this[`handle$${message.type}`];
        (handler as HT)(buche, message);
    }
    handle$update_component(buche: Buche, message: UpdateComponentMessage) {}
    handle$cell_command(buche: Buche, message: CellCommandMessage) {}
    handle$problem(buche: Buche, message: ProblemMessage) {}
}
