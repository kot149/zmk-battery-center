import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "@/context/theme-provider"
import { ConfigProvider } from "@/context/ConfigContext";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ConfigProvider>
      <ThemeProvider defaultTheme="dark">
        <App />
      </ThemeProvider>
    </ConfigProvider>
  </React.StrictMode>,
);
