import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource-variable/source-serif-4/opsz.css";
import "@fontsource-variable/source-serif-4/opsz-italic.css";
import "@fontsource-variable/inter/opsz.css";
import "./styles/tokens.css";
import "./styles/app.css";
import { App } from "./App";
import { AppDataProvider } from "./lib/context";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <AppDataProvider>
        <App />
      </AppDataProvider>
    </HashRouter>
  </StrictMode>,
);
