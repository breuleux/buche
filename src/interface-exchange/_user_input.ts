import type { Buche } from "../core.ts";
import type { Prompt } from "../prompt.ts";

export interface UserInputMessage {
    type: "user_input";

    prompt: Prompt;

    text: string;
    position: number;
}

export function handle$user_input(buche: Buche, obj: UserInputMessage): void {
    buche.sendDriver({
        type: "parse",
        from: ["$term"],
        to: obj.prompt.address,
        text: obj.text,
        position: obj.position,
    });
}
