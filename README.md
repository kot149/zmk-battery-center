# zmk-battery-center

A system tray app to monitor the battery level of ZMK-based keyboards, built with [Tauri v2](https://v2.tauri.app/).

![image](https://github.com/user-attachments/assets/1fe0b6de-c8cd-428b-975f-8c5d89850aba)

## ✨ Features

- Display battery level for:
  - Both central and peripheral sides of split keyboards
  - Multiple keyboards simultaneously
- Supports macOS and Windows
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

### Install manually
Download the binary/installer and install manually from [Releases](https://github.com/kot149/zmk-battery-center/releases).

If you worry about security, you can build the app yourself from source code. See [Development](#development) section for more details.

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
   # Use a different directory (Unix/macOS)
   ZMK_BATTERY_CENTER_DATA_DIR=./.dev-data-test bun tauri dev

   # Windows (PowerShell)
   $env:ZMK_BATTERY_CENTER_DATA_DIR=".\.dev-data-test"; bun tauri dev
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

You can also build using [GitHub Actions](.github/workflows).

## References

- ZMK PR [#1243](https://github.com/zmkfirmware/zmk/pull/1243), [#2045](https://github.com/zmkfirmware/zmk/pull/2045) — Implementation and discussion for split battery reporting over BLE GATT
- [zmk-ble](https://github.com/Katona/zmk-ble): Proof-of-concept system tray app for macOS (not compatible with latest macOS)
- [Mighty-Mitts](https://github.com/codyd51/Mighty-Mitts): System tray app for macOS
- [zmk-split-battery](https://github.com/Maksim-Isakau/zmk-split-battery): System tray app for Windows
- [zmkBATx](https://github.com/mh4x0f/zmkBATx): System tray app for Linux
- [ZmkBatteryClient](https://github.com/JanValiska/ZmkBatteryClient): [Waybar](https://github.com/Alexays/Waybar) custom module
