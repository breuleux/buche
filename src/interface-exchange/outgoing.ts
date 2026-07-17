
export interface PromptSubmitMessage {
    type: "prompt_submit";
}


/** Union of every message type. */
export type OutgoingInterfaceMessage = PromptSubmitMessage;
