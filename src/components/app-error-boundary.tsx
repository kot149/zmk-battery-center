import { Component, createRef, type ErrorInfo, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { logger } from "@/utils/log";

export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  private fallbackRef = createRef<HTMLElement>();
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    void logger.error("Rendering failed", error, info.componentStack);
    const content = this.fallbackRef.current;
    if (content) {
      void invoke("window_ready", {
        width: content.clientWidth,
        height: content.clientHeight,
      }).catch((error: unknown) => {
        void logger.error("Failed to reveal recovery screen", error);
      });
    }
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main ref={this.fallbackRef} role="alert" className="p-4">
        <h1>Something went wrong</h1>
        <p>Reload this window to try again. If the problem continues, restart the app.</p>
        <button onClick={() => window.location.reload()}>Reload window</button>
      </main>
    );
  }
}
