# Development and testing

## Development

1. Install [Bun](https://bun.sh)
1. Install [Rustup](https://www.rust-lang.org/ja/tools/install)
1. Clone this repo
   ```sh
   git clone https://github.com/kot149/zmk-battery-center.git
   cd zmk-battery-center
   ```
1. Install frontend dependencies
   ```sh
   bun install
   ```
1. Install Cargo tools
   ```sh
   cargo install cargo-about cargo-deny
   ```
1. Run in development mode

   ```sh
   bun tauri dev
   ```

   In development mode, config and device list are saved to `.dev-data/` at the project root. Use the `ZMK_BATTERY_CENTER_DATA_DIR` environment variable to switch directories (e.g. for tests):

   ```sh
   bunx cross-env ZMK_BATTERY_CENTER_DATA_DIR=./.dev-data-test bun tauri dev
   ```

1. Build for production
   ```sh
   bun tauri build
   ```
   - If build fails, try cleaning the build cache
     ```sh
     cargo clean
     ```
   - Specify the target platform with `--target` option. If omitted, the app will be built for the current platform.
     ```sh
     # for macOS arm64
     bun tauri build --target aarch64-apple-darwin

     # for macOS x86_64
     bun tauri build --target x86_64-apple-darwin
     ```

## Background monitoring and window lifetime

Rust owns device state, polling, BLE subscriptions, battery history, notifications, external snapshots, and tray actions. The process starts without a main WebView. A tray action creates the window and injects the current monitor snapshot into its initialization script. The frontend subscribes to `monitor-state-changed` before requesting `get_monitor_state`; revisions prevent an older response from replacing a newer event.

UI edits use narrow `monitor_*` commands. They do not write device snapshots or config files independently. Existing `config.json` and `devices.json` formats are retained. The main window is revealed after hydration and layout, or with an error message if hydration fails. Hiding or closing it retains the WebView on all platforms, and monitoring continues. On Windows, after one hidden second the app sets the WebView2 controller invisible and calls `TrySuspend` on a best-effort basis; the runtime can decline or fail suspension. Reopening resumes the controller and makes it visible before showing the window. Background monitor and history events are not delivered to a hidden window; `main-window-shown` triggers a fresh monitor snapshot and battery-history read. About is a separate window and stays alive until closed.

## Frontend file conventions

- TypeScript and TSX filenames use kebab-case.
- React components live in `src/components/`, with shadcn primitives in `src/components/shadcn/`.
- Providers live in `src/providers/`, hooks in `src/hooks/`, and shared utilities in `src/utils/`.
- Unit tests live in the nearest `__tests__/` directory and use the same kebab-case basename as the files they test.

## Testing

Data directory for unit tests and E2E tests is isolated by default, so test-run data does not mix with local development data.
Default data directory is `<project>/.dev-data-test`. To override the directory, set `ZMK_BATTERY_CENTER_DEV_TEST_DIR`.

### Unit tests

1. Frontend unit test:
   ```sh
   bun run test:frontend
   ```
2. Rust unit test:
   ```sh
   bun run test:rust
   ```
3. Run both frontend and Rust unit tests
   ```sh
   bun run test
   ```

### E2E tests

This project includes Playwright-based E2E tests that run against the Vite frontend and use deterministic mocked Tauri APIs in the browser context (no real BLE or tray dependencies).

Layer 1 E2E does not launch a Tauri shell, so that directory is not read by the browser; persistence under test is driven by the in-page Tauri mock (localStorage-backed store simulation).

1. Install Playwright browser once
   ```sh
   bun run e2e:install
   ```
2. Run full E2E suite
   ```sh
   bun run test:e2e
   ```
3. Run specific tests only (example: smoke)
   ```sh
   bun run test:e2e -g "first launch"
   ```

### Windows window-lifecycle test

Build an isolated debug app, then exercise the real tray and WebView2:

```sh
bun tauri build --debug --no-bundle --config '{"identifier":"com.zmk-battery-center.lifecycle-test"}'
bun scripts/test_window_lifecycle.ts
```

This test uses a fresh fixture directory under `test-results/`, leaves an installed instance alone, and stops only the process it launches. It verifies headless startup, tray-driven opening, quick-reopen reuse, a retained WebView across suspension and reopening, continued background snapshot publication, UI state reconciliation, and the native close action. It records the native suspension result, screenshots, and whole-process-tree working-set/private-byte measurements. The `webviews` metric counts descendant WebView2 processes, not retained controllers, so the DOM marker and native result verify the lifecycle instead. Open timings include CDP connection and visibility checks, so they are not pure paint latency. An invalid fixture BLE ID exercises disconnected-device handling without requiring hardware; successful BLE reads and OS notifications still need a real keyboard.

The test opens a local WebView2 debugging port only for its own process. `window_test_driver.ps1` sends tray-icon's Windows mouse callback to that process; update its message constant if the tray-icon backend changes.

### Smoke test for built app launch

To verify that a locally built desktop app binary actually launches, run:

```sh
bun run test:app
```

This does the following:

1. Build app binary without installers (`bun tauri build --no-bundle`)
2. Launch the built binary
3. Wait for a short smoke window (default 8s) and fail if it exits early
4. Terminate the process

Useful environment variables:

- `ZMK_BATTERY_CENTER_SMOKE_BIN`: explicit binary path for smoke launch test
- `ZMK_BATTERY_CENTER_SMOKE_WAIT_MS`: startup wait time in milliseconds (default: `8000`)
- `ZMK_BATTERY_CENTER_DEV_TEST_DIR`: override isolated data directory root used during tests

You can also build using [GitHub Actions](../.github/workflows).

## Test Design

This section describes a practical test design for this project. It is intentionally split into fast unit tests (run on every PR) and slower desktop E2E tests (run as smoke tests on PR + fuller coverage on schedule).

### Goals

- Catch regressions in battery parsing, state transitions, and config persistence early.
- Keep most tests deterministic by avoiding real BLE devices in CI.
- Verify critical user flows end-to-end with Tauri window/tray behavior.

### Unit Test Design

#### Frontend (TypeScript/React)

Recommended stack:

- Test runner: `vitest`
- Component tests: `@testing-library/react`
- DOM environment: `jsdom`
- Mocking Tauri APIs: module mocks for `@tauri-apps/api/*` and Tauri plugins

Primary unit targets:

- `src/app.tsx`
  - Render the backend device snapshot and route user actions to narrow monitor commands.
  - Reveal the main window only after state hydration and layout.
- `src/utils/monitor.ts`
  - Send the expected command names and arguments for device/config mutations.
- `src/utils/battery-history.ts`
  - `appendBatteryHistory` sends expected payload to Tauri `invoke`.
  - `readBatteryHistory` returns typed records and passes IDs correctly.
- `src/providers/config-provider.tsx`
  - Subscribe before hydration and reject stale revisions.
  - Apply native config/device events and recover from failed writes.
- `src/components/*`
  - `RegisteredDevicesPanel`: renders multiple devices, remove callback wiring.
  - `DateRangePicker` / `BatteryHistoryChart`: range changes and empty data rendering.

Suggested assertions:

- Use fake timers for polling/timeout behavior.
- Verify listener cleanup (`unlisten`) on unmount.
- Verify persistence calls happen only after initial config/device load flags are true.

#### Backend (Rust)

Recommended stack:

- Built-in Rust tests (`cargo test`)
- `tempfile` crate for isolated filesystem tests

Primary unit targets:

- `src-tauri/src/monitor.rs`
  - Normalize legacy config/devices and preserve previous battery values after failed reads.
  - Detect threshold edges by array index and honor notification settings.
  - Ignore stale I/O results after mode or device changes; keep IPC responsive during BLE reads.
- `src-tauri/src/window.rs`
  - Suspend only the current ready hidden window, never a reopened one.
- `src-tauri/src/history.rs`
  - `safe_filename`: sanitizes special characters and preserves allowed characters.
  - append/read round-trip for CSV records.
  - malformed CSV lines are skipped safely.
  - non-existing history file returns empty list.
- `src-tauri/src/storage.rs`
  - `get_dev_store_path` honors `ZMK_BATTERY_CENTER_DATA_DIR` (absolute and relative).
  - fallback to `.dev-data` in debug builds.

Recommended Rust refactor for easier testing:

- Extract pure helpers from Tauri command functions (path resolution, CSV parse/format), then test helpers directly without requiring a full `AppHandle`.

### E2E Test Design

Use two E2E layers to balance reliability and realism.

#### Layer 1: UI-flow E2E with mocked backend (PR required)

Purpose: validate user-visible behavior deterministically, without OS BLE/tray dependencies.

Recommended stack:

- `playwright`
- Test fixture that mocks Tauri `invoke`, event `listen`, and plugin APIs in the renderer

Core scenarios:

1. First launch
   - shows "No devices registered"
   - Add Device modal opens and lists available devices from mocked backend
2. Add/remove device
   - adding device renders it in list with battery info
   - removing device updates UI and persistence payload
3. Polling mode
   - settings update the backend interval
   - backend snapshots refresh battery levels without a frontend timer
4. Notification monitor mode (`fetchInterval = auto`)
   - settings select backend BLE subscriptions
   - native state events update matching device rows and connection status
   - the frontend does not duplicate backend notifications
5. Persistence and reload
   - saved devices/config are loaded on next app start
   - legacy device payload shape is normalized correctly
6. Battery history + chart
   - history update event triggers chart refresh
   - date range/custom range/smoothing options change plotted output (smoke-level assertion)

#### Layer 2: Desktop integration E2E on real Tauri shell (scheduled or manual)

The Windows lifecycle test above drives a real Tauri shell and WebView2 through the native tray callback and Playwright CDP. It covers process lifetime, on-demand creation, WebView retention, background suspension, and state recovery. Broader tray menu coverage and macOS/Linux desktop automation remain manual.

Purpose: cover integration points that browser-only tests cannot validate.

Core scenarios:

1. App boot + single-instance behavior
2. Tray menu opens and toggles manual window positioning
3. Window positioning behavior around tray icon (platform-specific smoke checks)
4. App exit flow stops monitors cleanly (no crashes/hangs)

### BLE Test Data Strategy

- Use deterministic fake devices:
  - split keyboard: central + peripheral battery entries
  - single-side keyboard
  - unstable device alternating connected/disconnected
- Use scripted event timelines for monitor mode:
  - reconnect bursts
  - `battery_level = null` updates to verify previous value retention
  - threshold crossings around 20% for low-battery notifications

### CI Execution Plan

Implemented in `.github/workflows/ci.yml` (currently manual `workflow_dispatch` only; PR/push triggers will be enabled once the pipeline is validated):

- `frontend` job: `bun run lint`, `bun run format:check`, typecheck via `bun run build:ui`, frontend unit tests
- `rust` job: `bun run build:ui` (required by `tauri::generate_context!`), then `cargo test`
- `e2e` job: Layer 1 mocked Playwright E2E (`bun run e2e`)
- `audit` job: `cargo audit` (non-blocking, `continue-on-error`)

Planned, not implemented:

- Nightly (or manual dispatch): Layer 2 desktop integration E2E on Windows/macOS matrix

### Initial Minimal Suite (recommended starting point)

If you want to introduce tests incrementally, start with these high-value cases:

- Unit: `upsertBatteryInfo`, `mergeBatteryInfos`, `normalizeLoadedDevices`.
- Unit: `history.rs` CSV round-trip + malformed-line handling.
- E2E: first launch, add device, notification event update, persistence reload.
