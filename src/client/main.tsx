import { createRoot } from "react-dom/client";
import { App } from "./components/App.js";

/**
 * One tree. The port ran as islands beside the vanilla renderer while it was
 * half done; the last screen to land collapsed them into this.
 */
const host = document.getElementById("root");
if (host) createRoot(host).render(<App />);
