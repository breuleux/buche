import { type OutM, type Buche } from "../core.ts";
import { type BaseMessage } from "./common.ts";

export interface TextMessage extends BaseMessage {
    type: "text";

    /** Stream on which the message was sent. */
    stream: "stdout" | "stderr";

    /** Text that was sent. */
    text: string;
}

export async function* handle$text(buche: Buche, obj: TextMessage): AsyncIterable<OutM> {
    const component = buche.get(obj.from);
    yield {
        type: "cell_send",
        command: {
            type: "text",
            stream: obj.stream,
            text: obj.text,
        },
        component: component,
    };
}
