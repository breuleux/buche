import type { Buche } from "../core.ts";
import type { EchoConfiguration } from "../echo.ts";
import type { Entry } from "../entry.ts";
import { Prompt, type PromptConfiguration } from "../prompt.ts";
import type { Zone } from "../zone.ts";
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
        sendRefresh(buche, entry, entry.prompt.zones.main);
        return;
    }
    const entry = buche.ensure(obj);
    if (entry.prompt) {
        // Reconfiguring a live prompt (submit reset, cd, config reload): the
        // prompt keeps its place and its status; only its configuration is
        // updated. Any parse still awaiting its answer is now void.
        entry.prompt.request_id = null;
        entry.prompt.configure(obj);
        sendRefresh(buche, entry, buche.findPlace(entry, obj));
        return;
    }
    // A fresh prompt: install it. Record the zone it sits in, by name, so
    // descendants' named lookups (e.g. "@tab") resolve to *this* zone instead
    // of bubbling to a same-named zone elsewhere: every TabbedZone answers to
    // "tab", and the root registry keeps only one. The prompt's own "@" (its
    // log) and "pop" are defined by the Prompt and win over the zone's names.
    const zone = buche.findPlace(entry, obj);
    for (const name of zone.names) {
        entry.zones[name] ??= zone;
    }
    entry.setPrompt(new Prompt(obj));
    entry.echo.status = { status: "running" };
    sendRefresh(buche, entry, zone);
}

function sendRefresh(buche: Buche, entry: Entry, zone: Zone): void {
    buche.sendInterface({
        type: "update_prompt",
        zone: zone,
        entry: entry,
    });
}
