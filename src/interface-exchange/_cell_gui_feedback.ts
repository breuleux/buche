import type { Buche } from "../core.ts";
import type { Entry } from "../entry.ts";
import type { Json } from "../types.ts";

export interface CellGuiFeedbackMessage {
    type: "cell_gui_feedback";

    /** The cell whose GUI produced the message. */
    entry: Entry;

    /** Arbitrary payload relayed by the GUI (`buche(data)`, `buche.request`,
     *  `proc://` requests, exec results). */
    data: Json;
}

export function handle$cell_gui_feedback(buche: Buche, obj: CellGuiFeedbackMessage): void {
    // The GUI was brought up by the process owning this entry's cell, so the
    // message goes back to that address, as an fd5 control message.
    buche.sendDriver({
        type: "data",
        from: ["$term"],
        to: obj.entry.echo.address,
        data: obj.data,
    });
}
