import { createRoot } from "react-dom/client";
import { App } from "./components/App.js";
import { token } from "./api.js";
import { installManifest, registerWorker } from "./pwa.js";

/**
 * One tree. The port ran as islands beside the vanilla renderer while it was
 * half done; the last screen to land collapsed them into this.
 */
const host = document.getElementById("root");
if (host) createRoot(host).render(<App />);

// After the render, not before it: neither of these puts a pixel on screen,
// and the cockpit should draw first.
installManifest(document, token());
void registerWorker();
