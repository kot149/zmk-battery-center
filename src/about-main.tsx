import React from "react";
import ReactDOM from "react-dom/client";
import AboutApp from "./about-app";
import { AppErrorBoundary } from "@/components/app-error-boundary";
import { initializeLogging } from "@/utils/log";

const disposeLogging = initializeLogging();
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    disposeLogging();
  });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <AboutApp />
    </AppErrorBoundary>
  </React.StrictMode>,
);
