import type { Buche } from "../core.ts";
import type { Prompt } from "../prompt.ts";

export interface UserCommandMessage {
    type: "user_command";

    prompt: Prompt;

    text: string;
    position: number;
    command: string;
}

export function handle$user_command(buche: Buche, obj: UserCommandMessage): void {
    buche.sendDriver({
        type: "command",
        from: ["$term"],
        to: obj.prompt.address,
        text: obj.text,
        position: obj.position,
        command: obj.command,
    });
}
