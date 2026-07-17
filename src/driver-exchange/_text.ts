import type { Buche, OutM } from "../core.ts";
import type { BaseMessage } from "./common.ts";

export interface TextMessage extends BaseMessage {
    type: "text";

    /** Stream on which the message was sent. */
    stream: "stdout" | "stderr";

    /** Text that was sent. */
    text: string;
}

export async function* handle$text(buche: Buche, obj: TextMessage): AsyncIterable<OutM> {
    const component = yield* buche.ensure("cell", obj);
    yield {
        type: "cell_command",
        command: {
            type: "text",
            stream: obj.stream,
            text: obj.text,
        },
        component: component,
    };
}
