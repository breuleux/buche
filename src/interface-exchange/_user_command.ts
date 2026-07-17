import type { Buche, OutM } from "../core.ts";
import type { Prompt } from "../prompt.ts";

export interface UserCommandMessage {
    type: "user_command";

    prompt: Prompt;

    text: string;
    position: number;
    command: string;
}

export async function* handle$user_command(
    buche: Buche,
    obj: UserCommandMessage,
): AsyncIterable<OutM> {
    yield {
        type: "command",
        from: ["$term"],
        to: obj.prompt.address,
        text: obj.text,
        position: obj.position,
        command: obj.command,
    };
}
