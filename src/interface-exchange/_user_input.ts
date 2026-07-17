import type { Buche, OutM } from "../core.ts";
import type { Prompt } from "../prompt.ts";

export interface UserInputMessage {
    type: "user_input";

    prompt: Prompt;

    text: string;
    position: number;
}

export async function* handle$user_input(
    buche: Buche,
    obj: UserInputMessage,
): AsyncIterable<OutM> {
    yield {
        type: "parse",
        from: ["$terminal"],
        to: obj.prompt.address,
        text: obj.text,
        position: obj.position,
    };
}
