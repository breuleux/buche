import type { Buche } from "../core.ts";
import type { EchoConfiguration } from "../echo.ts";
import type { Entry } from "../entry.ts";
import { Prompt, type PromptConfiguration } from "../prompt.ts";
import type { Target } from "../types.ts";
import type { BaseMessage, CreationInfo } from "./common.ts";

export interface PromptConfigureMessage
    extends BaseMessage,
        CreationInfo,
        EchoConfiguration,
        PromptConfiguration {
    type: "prompt_configure";

    /**
     * Set when this message is the *echo* answering a parse (the highlight a
     * keystroke triggered): it repeats that parse's `request_id`, and is only
     * applied while that parse is still the latest for this prompt — a stale
     * echo (the user typed on in the meantime) is dropped. Absent (the norm)
     * for authoritative configurations: the fresh prompt, the submit reset,
     * history navigation.
     */
    request_id?: string;
}

export function handle$prompt_configure(buche: Buche, obj: PromptConfigureMessage): void {
    if (obj.request_id !== undefined) {
        // A keystroke echo: pure content refresh — no installation, no zone
        // and no status changes. Valid only while it answers the latest parse
        // of this prompt; anything older is dropped (it would clobber text
        // typed since, with ranges computed for text that is gone).
        const entry = buche.hierarchy.getAt(obj.from, false);
        if (!entry?.prompt || entry.prompt.request_id !== obj.request_id) {
            return;
        }
        entry.prompt.configure(obj);
        sendRefresh(buche, entry);
        return;
    }
    const claimed = buche.claim(obj.from, "prompt");
    const entry = buche.ensure(obj);
    if (entry.prompt) {
        // Reconfiguring a live prompt (submit reset, cd, config reload): the
        // prompt keeps its place and its status; only its configuration is
        // updated. Any parse still awaiting its answer is now void.
        entry.prompt.request_id = null;
        entry.prompt.configure(obj);
        sendRefresh(buche, entry);
        return;
    }
    // A fresh prompt: it goes where it asks (by default, in a tab beside the
    // prompt it was started from, linked to it), or takes the place of the
    // placeholder it claimed (which was a cell: it is one no more).
    if (claimed) {
        entry.cell = null;
    } else {
        entry.target = buche.targetFor(entry, obj.zone, "prompt");
    }
    entry.setPrompt(new Prompt(obj));
    entry.echo.status = { status: "running" };
    sendRefresh(buche, entry, entry.target);
}

function sendRefresh(buche: Buche, entry: Entry, target: Target | null = null): void {
    buche.sendInterface({
        type: "update_prompt",
        target,
        entry: entry,
    });
}
