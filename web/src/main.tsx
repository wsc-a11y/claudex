// error-reporter MUST be the first import — installing window.error /
// unhandledrejection / console.error hooks before React mounts is the
// whole point. Any earlier code that throws is caught too.
import "./lib/error-reporter";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { RootErrorBoundary } from "./components/RootErrorBoundary";
import "./styles/globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </RootErrorBoundary>
  </StrictMode>,
);
