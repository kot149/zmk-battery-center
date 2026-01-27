import React from "react";
import ReactDOM from "react-dom/client";
import LicensesApp from "./LicensesApp";
import { getCurrentWindow } from "@tauri-apps/api/window";

// Prevent window from being destroyed when closed - hide it instead
const currentWindow = getCurrentWindow();
currentWindow.onCloseRequested(async (event) => {
  event.preventDefault();
  await currentWindow.hide();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <LicensesApp />
  </React.StrictMode>,
);
