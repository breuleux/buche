import type { Buche } from "../core.ts";
import type { BaseMessage } from "./common.ts";

export interface TextMessage extends BaseMessage {
    type: "text";

    /** Stream on which the message was sent. */
    stream: "stdout" | "stderr";

    /** Text that was sent. */
    text: string;
}

export function handle$text(buche: Buche, obj: TextMessage): void {
    const component = buche.ensure("cell", obj);
    buche.sendInterface({
        type: "cell_command",
        command: {
            type: "text",
            stream: obj.stream,
            text: obj.text,
        },
        component: component,
    });
}
