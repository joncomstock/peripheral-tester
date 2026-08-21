import React from "react";
import ReactDOM from "react-dom/client";

// Self-hosted, not a CDN link: a kiosk may have no route to the internet, and a webfont that fails
// there fails silently into a fallback that undoes the whole type treatment.
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";

import { App } from "./App.tsx";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
