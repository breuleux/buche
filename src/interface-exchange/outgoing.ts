import { type ComponentData } from "../core.ts";
import { Zone } from "../zone.ts";

export interface InstallMessage {
    zone: Zone;
    component: ComponentData;
}

export interface InstallEchoMessage extends InstallMessage {
    type: "install_echo";
}

export interface InstallCellMessage extends InstallMessage {
    type: "install_cell";
}

export interface InstallPromptMessage extends InstallMessage {
    type: "install_prompt";
}

export interface CloseComponentMessage {
    type: "close_component";
    component: ComponentData;
}

export interface TextCommand {
    type: "text";
    stream: string;
    text: string;
}

export type CellCommand = TextCommand;

export interface CellSendMessage {
    type: "cell_send";

    command: CellCommand;
    component: ComponentData;
}

export interface PromptSubmitMessage {
    type: "prompt_submit";

    // TODO
}

/** Union of every message type. */
export type OutgoingInterfaceMessage =
    | InstallEchoMessage
    | InstallCellMessage
    | InstallPromptMessage
    | CloseComponentMessage
    | CellSendMessage
    | PromptSubmitMessage;
