import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Roster } from "./components/Roster.js";

// The vanilla cockpit still owns everything that has not been ported. It runs
// first so its state and actions exist before an island asks for them.
import "./app.js";

/**
 * Islands, not a rewrite in one go. Each screen moves into React on its own,
 * the vanilla renderer keeps the rest working, and the last island to land
 * collapses these roots into a single tree.
 */
function mount(id: string, node: ReactNode): void {
  const host = document.getElementById(id);
  if (host) createRoot(host).render(node);
}

mount("roster-list", <Roster />);
