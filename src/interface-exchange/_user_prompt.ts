import { type OutM, type Buche } from "../core.ts";

export interface UserPromptMessage {
    type: "user_prompt";
}

export async function* handle$user_prompt(
    buche: Buche,
    obj: UserPromptMessage,
): AsyncIterable<OutM> {
    // TODO
}
