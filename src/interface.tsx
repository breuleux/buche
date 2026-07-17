import type { EchoBox } from "./components/echo-box.tsx";
import { extractZones } from "./components/zone.tsx";
import type { Buche } from "./core";
import type { Entry } from "./entry.ts";
import type { IncomingInterfaceMessage } from "./interface-exchange/incoming";
import type {
    CellCommandMessage,
    InstallEchoMessage,
    OutgoingInterfaceMessage,
    ProblemMessage,
    UpdateCellMessage,
    UpdateEntryMessage,
    UpdatePromptMessage,
} from "./interface-exchange/outgoing";
import type { BucheErrorMessage } from "./utils";
import { AsyncQueue } from "./utils.ts";
import type { Zone } from "./zone";

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

interface Reification {
    zone: Zone;
    element: HTMLElement;
}

export class BucheInterface implements Interface {
    container: Element;
    area: Element;
    interactions: AsyncQueue<IncomingInterfaceMessage | BucheErrorMessage>;
    zones: Array<Zone>;
    map: Map<Entry, Reification> = new Map();

    constructor(args: BucheInterfaceArguments) {
        this.container = args.container;
        this.area = reifyTemplate(args.template);
        this.zones = extractZones(this.area as HTMLElement);
        this.interactions = new AsyncQueue();
    }

    processMessage(buche: Buche, message: OutgoingInterfaceMessage) {
        console.log(message);
        type HT = (buche: Buche, m: OutgoingInterfaceMessage) => void;
        const handler = this[`handle$${message.type}`];
        (handler as HT).call(this, buche, message);
    }

    handle$install_echo(buche: Buche, message: InstallEchoMessage) {
        message.zone!.installEcho(this, message.entry);
    }

    handle$update_cell(buche: Buche, message: UpdateCellMessage) {
        const existing = this.map.get(message.entry);
        if (existing) {
            message.entry.fire();
        } else {
            const element = message.zone!.installCell(this, message.entry);
            this.map.set(message.entry, { zone: message.zone!, element });
        }
    }

    handle$update_prompt(buche: Buche, message: UpdatePromptMessage) {
        const existing = this.map.get(message.entry);
        if (existing) {
            message.entry.fire();
        } else {
            console.log("~~!", message.entry.echo.label);
            const element = message.zone!.installPrompt(this, message.entry);
            this.map.set(message.entry, { zone: message.zone!, element });
        }
    }

    handle$update_entry(buche: Buche, message: UpdateEntryMessage) {
        message.entry.fire();
    }

    handle$cell_command(buche: Buche, message: CellCommandMessage) {
        const existing = this.map.get(message.entry)!;
        message.entry.cell!.handle(message.command, message.entry, existing.element as EchoBox);
    }

    handle$problem(buche: Buche, message: ProblemMessage) {}
}
