/**
 * Browser bundle for `scripts/view.ts`.
 *
 * The Buche core and the interface run entirely client-side here:
 *
 *   - Importing each component module runs its `customElements.define(...)`
 *     calls, so the layout already in the page (`<grid-columns>`, `<tabbed-zone>`,
 *     …) upgrades and renders.
 *   - A `BucheInterface` is built from that live layout, which yields the initial
 *     zones.
 *   - A `Buche` instance is wired so `sendDriver` serialises outgoing driver
 *     messages onto the WebSocket (the server relays them to the process), and
 *     `sendInterface` hands messages to the interface to render.
 *   - Driver messages arriving over the WebSocket (the process's output) are fed
 *     straight into `buche.handle`, as are the interface's own interactions.
 */
import "../src/components/grid.tsx";
import "../src/components/zone.tsx";
import "../src/components/scroll-fader.tsx";
import "../src/components/echo-box.tsx";

import { Buche, type InM } from "../src/core.ts";
import { BucheInterface } from "../src/interface.tsx";
import { zoneMap } from "../src/zone.ts";

const container = document.getElementById("buche");
if (!container?.firstElementChild) {
    throw new Error("view: #buche container (or its layout) is missing");
}

// The layout is already in the page; the interface reads its zones from the
// live DOM so what the core targets is what the user sees.
const iface = new BucheInterface({ container, template: container.firstElementChild });

const socket = new WebSocket(`ws://${location.host}/ws`);

// Outgoing driver messages are buffered until the socket is open, then flushed
// in order — the server relays each one to the process.
const outbound: string[] = [];
function sendToServer(message: unknown): void {
    const json = JSON.stringify(message);
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(json);
    } else {
        outbound.push(json);
    }
}

const buche = new Buche({
    initialZones: zoneMap(iface.zones),
    sendDriver(message) {
        console.debug("[buche] driverOut", message);
        sendToServer(message);
    },
    sendInterface(message) {
        iface.processMessage(buche, message);
    },
});

socket.addEventListener("open", () => {
    console.log("[buche] connected");
    for (const json of outbound.splice(0)) {
        socket.send(json);
    }
});
socket.addEventListener("close", () => console.log("[buche] disconnected"));

// Driver messages from the server (the process's output) drive the core.
socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data) as InM;
    console.debug("[buche] driverIn", message);
    buche.handle(message);
});

// User interactions from the interface are handled the same way.
void (async () => {
    for await (const interaction of iface.interactions) {
        buche.handle(interaction as InM);
    }
})();
