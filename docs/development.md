# Development guide

This guide covers local development, testing, and implementation conventions for zmk-battery-center. For user-facing installation and troubleshooting, see the [README](../README.md). For the battery snapshot file API, see [external integration](external_integration.md).

## Setup

### Prerequisites

- [Bun](https://bun.sh/) for the frontend and project scripts.
- [Rustup](https://rustup.rs/) with the stable Rust toolchain.
- Platform-specific dependencies for Tauri v2. Follow the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your operating system. On Ubuntu, the packages used in [CI](../.github/workflows/ci.yml) are `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`, and `patchelf`.

### First run

```sh
git clone https://github.com/kot149/zmk-battery-center.git
cd zmk-battery-center
bun install
bun run dev
```

`bun run dev` starts the Tauri application with the frontend development server. The equivalent direct command is `bun tauri dev`.

### Development data

Debug builds store settings, registered devices, battery history, and logs under `.dev-data/` at the project root. Logs are in `.dev-data/logs/`. Release builds use the operating system's application data and log directories instead.

For a debug build, `ZMK_BATTERY_CENTER_DATA_DIR` changes the data directory. A relative path is resolved from the project root:

```sh
# macOS / Linux shell
ZMK_BATTERY_CENTER_DATA_DIR=.dev-data-alt bun run dev
```

```powershell
# Windows PowerShell
$env:ZMK_BATTERY_CENTER_DATA_DIR = ".dev-data-alt"
bun run dev
Remove-Item Env:ZMK_BATTERY_CENTER_DATA_DIR
```

**Note:** The environment-variable override applies only to debug builds. Do not rely on it to isolate data when launching a release binary.

## Build and code checks

| Command                     | Purpose                                                             |
| --------------------------- | ------------------------------------------------------------------- |
| `bun run build:ui`          | Type-check and build the frontend                                   |
| `bun run build:app`         | Build the Tauri release binary without an installer (`--no-bundle`) |
| `bun run build`             | Build the application and platform bundles                          |
| `bun run lint`              | Lint the frontend and scripts                                       |
| `bun run lint:rust`         | Run Clippy on the Rust workspace                                    |
| `bun run format:check`      | Check frontend and script formatting                                |
| `bun run format:rust:check` | Check Rust formatting                                               |
| `bun run check-versions`    | Verify version consistency                                          |

Use `bun run format` and `bun run format:rust` to apply formatting. `vite.config.ts` holds the Vite+ configuration for frontend tooling.

To target a different architecture, pass a supported Rust target to Tauri (and install that target and any required toolchain first). For example, on macOS:

```sh
bun tauri build --target aarch64-apple-darwin
bun tauri build --target x86_64-apple-darwin
```

If an incremental Rust build appears stale, `cargo clean` removes Cargo's build artifacts and forces a rebuild.

## Project structure

| Path                 | Responsibility                                                       |
| -------------------- | -------------------------------------------------------------------- |
| `src/`               | React/TypeScript frontend                                            |
| `src/components/`    | UI components; `shadcn/` contains UI primitives                      |
| `src/providers/`     | React context providers                                              |
| `src/hooks/`         | React hooks                                                          |
| `src/utils/`         | Shared frontend utilities and Tauri command wrappers                 |
| `src-tauri/src/`     | Rust backend, BLE monitoring, storage, windows, and tray integration |
| `e2e/`               | Playwright UI-flow tests and mocked Tauri APIs                       |
| `scripts/`           | Build support, previews, smoke tests, and maintenance tools          |
| `.github/workflows/` | CI, security audit, build, and release workflows                     |

TypeScript and TSX filenames use **kebab-case**. Keep unit tests in the nearest `__tests__/` directory, with the same basename as the code being tested.

## Runtime architecture

### Background monitoring and state ownership

Rust owns device state, BLE polling and subscriptions, battery history, notifications, external snapshots, and tray actions. React renders the monitor state and sends user edits through narrow `monitor_*` commands; it does not independently write device snapshots or configuration files. Existing `config.json` and `devices.json` formats remain supported.

The process starts without a main WebView. Opening the tray window creates it on demand and injects the current monitor snapshot into its initialization script. The frontend subscribes to `monitor-state-changed` before requesting `get_monitor_state`; snapshot revisions prevent an older response from overwriting a newer event. The main window is shown after hydration and layout, or with an error message if hydration fails.

### Window lifetime

Hiding or closing the main window retains its WebView on all supported platforms, while Rust monitoring continues. On Windows, after one second hidden the application sets the WebView2 controller invisible and attempts `TrySuspend`; WebView2 may decline or fail the request. Reopening resumes the controller and restores visibility.

Background monitor and history events are not delivered to the hidden main window. The `main-window-shown` event triggers fresh monitor and battery-history reads. The About window is independent and remains alive until closed.

## Logging

`config.logLevel` supports `warn`, `info`, and `debug`. When unset, the default is **Warn** in release builds and **Debug** in development builds. `src-tauri/src/diagnostics.rs` manages the runtime level and publishes `get_log_level_state` / `log-level-changed` to the frontend. Dependencies stay at Warn; Trace is not captured.

Log lines contain a UTC timestamp, severity, target, `run_id`, and structured message:

```text
2026-11-03T02:40:02.468Z DEBUG zmk_battery_center_lib::ble: run_id=1a19f472344-26464 event=adapter_ready
```

`run_id` identifies one application launch. Backend messages should start with `event=<snake_case>` and use `key=value` fields rather than free-form prose so events remain searchable. Frontend logs use the `webview` target.

The file writer (`src-tauri/src/diagnostics/log_file.rs`) rotates files at **2 MiB**, retaining **four archives plus the current file**. Debug logs are in `logs/` under the development data directory; release logs are in Tauri's `app_log_dir`.

Known device IDs and names, MAC addresses, UUIDs, and the home directory are redacted when the line is written, but this is not a guarantee that every sensitive value is removed. Review logs before sharing. Avoid expensive string construction at disabled levels by using lazy logger arguments; preserve error context when logging errors.

## Testing

### Unit tests

| Command                 | Coverage                                                                   |
| ----------------------- | -------------------------------------------------------------------------- |
| `bun run test:frontend` | Frontend unit/component tests (`src/**/__tests__/`), using Vite+ and jsdom |
| `bun run test:rust`     | Rust unit tests (`cargo test`)                                             |
| `bun run test`          | Both suites                                                                |

Rust tests that compile Tauri context may require frontend output. If that output is missing, run `bun run build:ui` first, as done in CI.

Frontend unit tests run through `scripts/with_dev_data_dir.ts`, which selects an isolated test directory (default: `.dev-data-test/`). Set `ZMK_BATTERY_CENTER_DEV_TEST_DIR` to change that directory. Rust filesystem tests use their own temporary fixtures where applicable.

### Browser E2E tests

Playwright tests in `e2e/specs/` run against the Vite frontend using deterministic, mocked Tauri APIs. They validate UI flows, not native BLE, tray, or WebView2 behavior. The mock simulates persistence in browser storage; it does not use the native test data directory.

```sh
bun run e2e:install       # Install Chromium once
bun run test:e2e          # Run the suite
bun run test:e2e -g "first launch"  # Filter tests by title
```

### Built-app smoke test

```sh
bun run test:app
```

This builds a release binary without installers, launches it, checks that it remains alive for a short interval (default: 8 seconds), and then terminates the launched process. The test does not verify BLE functionality.

Optional variables:

- `ZMK_BATTERY_CENTER_SMOKE_BIN`: path of the binary to launch.
- `ZMK_BATTERY_CENTER_SMOKE_WAIT_MS`: startup observation interval in milliseconds.
- `ZMK_BATTERY_CENTER_DEV_TEST_DIR`: test data directory used by the wrapper.

**Data safety:** The data-directory override in the wrapper does not apply to release binaries. The release smoke test may therefore access the normal application data location. Take that into account when testing on a machine with an existing installation.

### Windows window-lifecycle test

This manual integration test uses a real debug Tauri app, system tray interaction, and WebView2 through the Windows tray driver and Playwright CDP:

```sh
bun tauri build --debug --no-bundle --config '{"identifier":"com.zmk-battery-center.lifecycle-test"}'
bun scripts/test_window_lifecycle.ts
```

Run these commands on Windows. The test uses a fresh fixture directory under `test-results/` and checks headless startup, tray-driven opening, WebView retention and suspension, reopening, continued background snapshots, UI reconciliation, and native close. It records screenshots, native suspension results, and process memory measurements. Its `webviews` metric counts descendant WebView2 processes, not retained controllers. BLE reads and operating-system notifications still require real hardware for validation.

The test opens a local WebView2 debugging port for its own process. `scripts/window_test_driver.ps1` sends the tray icon's Windows mouse callback; its message constant may need updating if the underlying tray-icon implementation changes.

## CI and automation

- [`ci.yml`](../.github/workflows/ci.yml) runs on push, pull requests, and manual dispatch. It checks frontend linting, formatting, and unit tests; Rust formatting, Clippy, and unit tests (Windows, macOS, Linux); and mocked browser E2E tests.
- [`audit.yml`](../.github/workflows/audit.yml) runs dependency audits on `bun.lock` / `Cargo.lock` changes and on manual dispatch. Both Bun and Rust audits are non-blocking.
- [`build.yml`](../.github/workflows/build.yml) builds Tauri artifacts for macOS, Windows, and Linux, including supported x64/ARM64 targets.
- [`release.yml`](../.github/workflows/release.yml) handles release automation.

The browser E2E suite does **not** replace platform-specific Tauri integration tests. The Windows lifecycle test above is run manually; broader cross-platform native window and tray automation is not part of the current CI suite.

## Additional workflows

### Update banner preview

```sh
bun run preview:update
```

Open `http://127.0.0.1:1421/`. The command builds the frontend and serves it with mocked keyboard and update data, without running Tauri or connecting a keyboard. Enable **Check for zmk-battery-center update** in Settings to display the sample banner. Restart the preview command after UI edits to rebuild it.

Dismissal persists across preview reloads. Open `http://127.0.0.1:1421/?reset=1` to reset it and enable the sample update again.

### Dependency licenses

These tools are only needed when maintaining dependency license information, not for routine development:

```sh
cargo install cargo-about --features cli
cargo install cargo-deny
bun run check-licenses
bun run generate-licenses
```

`check-licenses` verifies JavaScript licenses and, when `cargo-deny` is installed, Rust licenses. `generate-licenses` uses `cargo-about` to regenerate Rust license information. The generated files are kept under `licenses/`.
