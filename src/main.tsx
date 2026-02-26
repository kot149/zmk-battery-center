import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "@/context/theme-provider"
import { ConfigProvider } from "@/context/ConfigContext";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider defaultTheme="dark">
      <ConfigProvider>
        <App />
      </ConfigProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
