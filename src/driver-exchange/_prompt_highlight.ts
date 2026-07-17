import type { Buche } from "../core.ts";
import type { HighlightRange } from "../types.ts";
import type { BaseMessage } from "./common.ts";

export interface PromptHighlightMessage extends BaseMessage {
    type: "prompt_highlight";

    /** The prompt text the highlight was computed for. */
    text: string;

    /** Syntax-highlight spans over `text`. */
    ranges: HighlightRange[];

    /**
     * Ghost text: the most recent history entry extending `text`, offered as a
     * completion suffix; null when there is nothing to suggest.
     */
    filigrane: string | null;
}

export function handle$prompt_highlight(buche: Buche, obj: PromptHighlightMessage): void {
    const entry = buche.get(obj.from, true);
    const zone = buche.findPlace(entry, obj);
    if (entry.prompt && entry.prompt.submission.content.text === obj.text) {
        entry.prompt.submission.content.ranges = obj.ranges;
        entry.prompt.filigrane = obj.filigrane;
    }
    buche.sendInterface({
        type: "update_prompt",
        zone: zone,
        entry: entry,
    });
}
