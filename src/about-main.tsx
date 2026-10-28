import React from "react";
import ReactDOM from "react-dom/client";
import AboutApp from "./about-app";
import { AppErrorBoundary } from "@/components/app-error-boundary";
import { initializeLogging } from "@/utils/log";
import { initializeLogLevel } from "@/utils/diagnostics";

const disposeLogging = initializeLogging();
const disposeLevel = initializeLogLevel();
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    disposeLevel();
    disposeLogging();
  });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <AboutApp />
    </AppErrorBoundary>
  </React.StrictMode>,
);
