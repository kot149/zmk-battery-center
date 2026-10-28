import React from "react";
import ReactDOM from "react-dom/client";
import App from "./app";
import { ThemeProvider } from "@/providers/theme-provider";
import { ConfigProvider } from "@/providers/config-provider";
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
      <ThemeProvider defaultTheme="dark">
        <ConfigProvider>
          <App />
        </ConfigProvider>
      </ThemeProvider>
    </AppErrorBoundary>
  </React.StrictMode>,
);
