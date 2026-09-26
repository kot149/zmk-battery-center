import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

const root = resolve(import.meta.dir, "..");
const dist = resolve(root, "dist");
const release = {
  version: "0.13.0",
  releaseUrl: "https://github.com/kot149/zmk-battery-center/releases/tag/v0.13.0",
};
const seed = {
  platform: "windows",
  registeredDevices: [
    {
      id: "kbd-1",
      name: "Keyboard",
      batteryInfos: [{ battery_level: 82, user_description: "Central" }],
      isDisconnected: false,
      isCollapsed: false,
    },
  ],
  availableDevices: [{ id: "kbd-1", name: "Keyboard" }],
  batteryById: { "kbd-1": [{ battery_level: 82, user_description: "Central" }] },
};

function inlineScript(source: string): string {
  return `<script>${source.replaceAll("</script", "<\\/script")}</script>`;
}

const resetDismissal = `
  if (new URLSearchParams(location.search).has("reset")) {
    window.__UPDATE_PREVIEW_RESET__ = true;
    const key = "__e2e_tauri_store__:config.json";
    try {
      const data = JSON.parse(localStorage.getItem(key) || "{}");
      delete data.dismissedVersions;
      localStorage.setItem(key, JSON.stringify(data));
    } catch {
      localStorage.removeItem(key);
    }
    history.replaceState(null, "", "/");
  }
`;
const mockEnvironment = readFileSync(
  resolve(root, "e2e/support/tauri-mock/01-env-and-state.js"),
  "utf8",
);
const mockInvoke = readFileSync(
  resolve(root, "e2e/support/tauri-mock/02-internals-and-invoke.js"),
  "utf8",
);
const updateInvoke = `
  const previewRelease = ${JSON.stringify(release)};
  const invoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = (command, args = {}) => {
    if (command === "check_for_update") {
      return invoke(command, args).then(() => previewRelease);
    }
    if (command === "plugin:opener|open_url") {
      window.open(args.url, "_blank", "noopener,noreferrer");
    }
    return invoke(command, args);
  };
`;

const index = readFileSync(resolve(dist, "index.html"), "utf8");
const scripts = [
  resetDismissal,
  `window.__E2E_TAURI_SEED__ = ${JSON.stringify(seed)};`,
  mockEnvironment,
  `
    if (window.__UPDATE_PREVIEW_RESET__) {
      const mock = window.__E2E_TAURI_MOCK_BUILD__;
      mock.state.config.updateCheckEnabled = true;
      mock.writeSnapshotToStorage();
    }
  `,
  mockInvoke,
  updateInvoke,
]
  .map(inlineScript)
  .join("\n");
const html = index.replace('<script type="module"', `${scripts}\n<script type="module"`);
if (html === index) throw new Error("Could not insert preview scripts into dist/index.html");

const port = Number(process.env.ZMK_UPDATE_PREVIEW_PORT ?? 1421);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    let path: string;
    try {
      path = resolve(dist, `.${decodeURIComponent(url.pathname)}`);
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    if (!path.startsWith(`${dist}${sep}`)) return new Response("Not found", { status: 404 });
    const file = Bun.file(path);
    return (await file.exists()) ? new Response(file) : new Response("Not found", { status: 404 });
  },
});

console.log(`Update preview: http://127.0.0.1:${server.port}/`);
