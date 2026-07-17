/**
 * Renderer bundle for the Electron app (electron/main.ts).
 *
 * The Electron counterpart of scripts/view-client.ts: the Buche core and the
 * interface run here, and the driver process lives in the main process. The
 * preload (electron/preload.ts) carries messages both ways — incoming ones
 * arrive as window messages, outgoing ones go through `window.buche.driver`.
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
    throw new Error("electron: #buche container (or its layout) is missing");
}

interface DriverBridge {
    driver?: { send(message: unknown): void };
}
const bridge = (window as unknown as { buche?: DriverBridge }).buche;
if (!bridge?.driver) {
    throw new Error("electron: the driver bridge is missing (preload not loaded?)");
}

const iface = new BucheInterface({ container, template: container.firstElementChild });

const buche = new Buche({
    initialZones: zoneMap(iface.zones),
    sendDriver(message) {
        console.debug("[buche] driverOut", message);
        bridge.driver?.send(message);
    },
    sendInterface(message) {
        iface.processMessage(buche, message);
    },
});

// Driver messages from the main process (the shell's output) drive the core.
window.addEventListener("message", (event) => {
    const data = event.data as { __buche?: string; message?: InM } | null;
    if (data?.__buche !== "driver:message" || !data.message) {
        return;
    }
    console.debug("[buche] driverIn", data.message);
    buche.handle(data.message);
});

// User interactions from the interface are handled the same way.
void (async () => {
    for await (const interaction of iface.interactions) {
        buche.handle(interaction as InM);
    }
})();
