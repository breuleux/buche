import type { ComponentStatus } from "./cell.ts";
import type { HighlightRange } from "./driver-exchange/common.ts";
import type { Prompt } from "./prompt.ts";
import { IdClass } from "./utils.ts";
import type { Zone } from "./zone.ts";

export interface EchoConfiguration {
    /** Text of the command. */
    text: string | null;

    /** Spans to colorize. */
    ranges: HighlightRange[];
}

export class Echo extends IdClass {
    prompt: Prompt | null = null;
    zone: Zone;

    /** Text of the command. */
    text: string | null;

    /** Spans to colorize. */
    ranges: HighlightRange[];

    status: ComponentStatus;

    constructor(config: EchoConfiguration, location: { zone: Zone; prompt: Prompt | null }) {
        super();
        this.prompt = location.prompt;
        this.zone = location.zone;
        this.text = config.text;
        this.ranges = config.ranges;
        this.status = { status: "running" };
    }
}
