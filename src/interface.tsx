import type { IncomingInterfaceMessage } from "./interface-exchange/incoming";
import type { OutgoingInterfaceMessage } from "./interface-exchange/outgoing";
import type { AsyncQueue } from "./process";
import type { BucheErrorMessage } from "./utils";

export interface Interface {
    interactions: AsyncQueue<IncomingInterfaceMessage | BucheErrorMessage>;
    processMessage: (message: OutgoingInterfaceMessage) => void;
}
