# zmk-battery-center

A system tray app to monitor the battery level of ZMK-based keyboards, built with [Tauri v2](https://v2.tauri.app/).

<p>
    <img width="491" height="481" alt="zmk-battery-center screenshot: main screen" src="https://github.com/user-attachments/assets/1fe0b6de-c8cd-428b-975f-8c5d89850aba" />
    <img width="491" height="423" alt="zmk-battery-center screenshot: battery history graph" src="https://github.com/user-attachments/assets/3ee172be-353a-4b33-91cd-9bc4433d0037" />
</p>

## ✨ Features

- Display battery level for:
  - Both central and peripheral sides of split keyboards
  - Multiple keyboards simultaneously
- Record battery level history and display in a graph
- Multi-platform: Windows, macOS, Linux (limited, see [here](#limitations-on-linux) for details)
- (Options)
  - Push notifications when
    - Keyboard battery level is low
    - Keyboard is connected/disconnected
  - Auto start at login
  - Switch between light and dark themes

## Installation

### Install with command

#### Windows

```sh
powershell -ExecutionPolicy Bypass -Command "iex (irm 'https://raw.githubusercontent.com/kot149/zmk-battery-center/main/scripts/install_win.ps1')"
```
[View install script](scripts/install_win.ps1)

This requires admin privileges. If you don't have admin privileges, manually install with `*-setup.exe` in [Releases](https://github.com/kot149/zmk-battery-center/releases).

#### macOS

```sh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/kot149/zmk-battery-center/main/scripts/install_mac.sh)"
```
[View install script](scripts/install_mac.sh)

#### Linux

Coming soon, please install manually for now.

### Install manually
Download the binary/installer and install manually from [Releases](https://github.com/kot149/zmk-battery-center/releases).

If you worry about security, you can build the app yourself from source code. See [Development](#development) section for more details.

## Limitations on Linux

While this app is also released for Linux, it is not much tested, as the author does not regularly use Linux desktop environment.
Feel free to report any issues you find on Linux, but I cannot guarantee that I can fix them.

Also there are some limitations specifically on Linux:
- The app may not appear around the system tray icon, and manual window positioning may not work properly
- Left-click on the system tray icon cannot be captured by the app, and treated as right-click instead
- The app never disconnects the devices internally because call of `disconnect_device()` API on Linux causes OS-level disconnection. Unused connections might remain after the app exits.

## Troubleshooting

### Cannot open the app on macOS

On macOS, the app is blocked from opening as it is not signed. Allow the app to open by either:
- Open System Settings > Privacy & Security > Security and click `Open Anyway`.
- Or, run the following command in the terminal to remove the app from quarantine:
  ```sh
  sudo xattr -d com.apple.quarantine /Applications/zmk-battery-center.app
  ```
  Typically it's located at `/Applications/zmk-battery-center.app`, but change it to the actual path if it's not there.

### My keyboard does not show up / Peripheral side battery level is not displayed

- Ensure your keyboard is connected to your computer via Bluetooth.
- Confirm your keyboard firmware includes the following ZMK configuration options:
  ```kconfig
  CONFIG_BT_BAS=y
  CONFIG_ZMK_BATTERY_REPORTING=y

  # For split keyboards:
  CONFIG_ZMK_SPLIT_BLE_CENTRAL_BATTERY_LEVEL_FETCHING=y
  CONFIG_ZMK_SPLIT_BLE_CENTRAL_BATTERY_LEVEL_PROXY=y
  ```
  See the ZMK Documentation [about Bluetooth](https://zmk.dev/docs/config/system#bluetooth) and [about battery](https://zmk.dev/docs/config/battery) for more details.
- On macOS, make sure Bluetooth permission is granted to the app.

### Window position is misaligned

Window position may be misaligned if the OS has problems handling multiple monitors or you are using vertical taskbar on Windows.

You can manually move the window to the correct position to address this issue.

1. Right click the tray icon
2. Click `Control` > `Manual window positioning` in the menu
3. Now you can grab the top of the window to move it to any position you like

## Development

1. Install [Bun](https://bun.sh)
1. Install [Rustup](https://www.rust-lang.org/ja/tools/install)
2. Clone this repo
   ```sh
   git clone https://github.com/kot149/zmk-battery-center.git
   cd zmk-battery-center
   ```
1. Install frontend dependencies
     ```sh
     bun install
     ```
2. Install Cargo tools
     ```sh
     cargo install cargo-about cargo-deny
     ```
2. Run in development mode
     ```sh
     bun tauri dev
     ```
   In development mode, config and device list are saved to `.dev-data/` at the project root. Use the `ZMK_BATTERY_CENTER_DATA_DIR` environment variable to switch directories (e.g. for tests):

   ```sh
   bunx cross-env ZMK_BATTERY_CENTER_DATA_DIR=./.dev-data-test bun tauri dev
   ```

3. Build for production
     ```sh
     bun tauri build
     ```
   - If build fails, try cleaning the build cache
     ```sh
     cd src-tauri
     cargo clean
     cd ..
     ```
   - Specify the target platform with `--target` option. If omitted, the app will be built for the current platform.
     ```sh
     # for macOS arm64
     bun tauri build --target aarch64-apple-darwin

      # for macOS x86_64
      bun tauri build --target x86_64-apple-darwin
      ```

### Run E2E tests

This project includes Playwright-based E2E tests that run against the Vite frontend and use deterministic mocked Tauri APIs in the browser context (no real BLE or tray dependencies).

1. Install Playwright browser once
   ```sh
   bun run e2e:install
   ```
2. Run full E2E suite
   ```sh
   bun run e2e
   ```
3. Run a smoke test only
   ```sh
   bun run e2e:smoke
   ```

You can also build using [GitHub Actions](.github/workflows).

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
- `src/App.tsx`
  - `upsertBatteryInfo`: insert vs update by `user_description`, keep previous value when new `battery_level` is `null`.
  - `mergeBatteryInfos`: preserve previous `battery_level` only when incoming value is `null`.
  - `normalizeLoadedDevices`: legacy key compatibility (`user_descriptor`), `DeviceId("...")` normalization, invalid shapes fallback.
- `src/utils/config.ts`
  - `loadSavedConfig`: defaults are merged correctly.
  - `setConfig`: autostart enable/disable logic, notification permission request behavior.
- `src/utils/batteryHistory.ts`
  - `appendBatteryHistory` sends expected payload to Tauri `invoke`.
  - `readBatteryHistory` returns typed records and passes IDs correctly.
- `src/context/ConfigContext.tsx`
  - initial load updates context + emits `config-changed`.
  - `update-config` listener merges partial updates and avoids event loop.
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
   - settings set fixed interval
   - periodic refresh updates battery level
   - low battery transition triggers notification call once per transition
4. Notification monitor mode (`fetchInterval = auto`)
   - monitor starts when device is registered
   - `battery-info-notification` event updates matching device row
   - disconnected/connected status events update state and notification behavior
5. Persistence and reload
   - saved devices/config are loaded on next app start
   - legacy device payload shape is normalized correctly
6. Battery history + chart
   - history update event triggers chart refresh
   - date range/custom range/smoothing options change plotted output (smoke-level assertion)

#### Layer 2: Desktop integration E2E on real Tauri shell (scheduled or manual)

Purpose: cover integration points that browser-only tests cannot validate.

Recommended stack:
- Tauri WebDriver-based flow (for example, `tauri-driver`) on Windows/macOS runners

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

- On every PR
  - `bun lint`
  - frontend unit tests
  - `cargo test` for Rust unit tests
  - Layer 1 mocked E2E smoke tests
- Nightly (or manual dispatch)
  - Layer 2 desktop integration E2E on Windows/macOS matrix

### Initial Minimal Suite (recommended starting point)

If you want to introduce tests incrementally, start with these high-value cases:
- Unit: `upsertBatteryInfo`, `mergeBatteryInfos`, `normalizeLoadedDevices`.
- Unit: `history.rs` CSV round-trip + malformed-line handling.
- E2E: first launch, add device, notification event update, persistence reload.

## References

Implementation and discussion for split battery reporting over BLE GATT:
- ZMK PR [#1243](https://github.com/zmkfirmware/zmk/pull/1243)
- ZMK PR [#2045](https://github.com/zmkfirmware/zmk/pull/2045)

## Related Works

- [zmk-ble](https://github.com/Katona/zmk-ble): Proof-of-concept system tray app for macOS (not compatible with latest macOS)
- [Mighty-Mitts](https://github.com/codyd51/Mighty-Mitts): System tray app for macOS
- [zmk-split-battery](https://github.com/Maksim-Isakau/zmk-split-battery): System tray app for Windows
- [zmkBATx](https://github.com/mh4x0f/zmkBATx): System tray app for Linux
- [ZmkBatteryClient](https://github.com/JanValiska/ZmkBatteryClient): [Waybar](https://github.com/Alexays/Waybar) custom module
