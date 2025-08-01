# Project Structure

## Root Directory
- `package.json` - Frontend dependencies and scripts
- `bun.lock` - Bun lockfile for dependencies
- `tsconfig.json` - TypeScript configuration
- `vite.config.ts` - Vite build configuration
- `components.json` - shadcn/ui configuration
- `index.html` - Entry HTML file

## Frontend (`/src/`)
- `App.tsx` - Main React application component
- `App.css` - Global styles and Tailwind imports
- `main.tsx` - React application entry point

### Components (`/src/components/`)
- `BatteryIcon.tsx` - Battery level visualization
- `Button.tsx` - Reusable button component
- `Modal.tsx` - Modal dialog component
- `RegisteredDevicesPanel.tsx` - Panel for managing devices
- `Settings.tsx` - Settings screen component
- `ui/` - shadcn/ui components (select.tsx, switch.tsx)

### Utils (`/src/utils/`)
- `ble.ts` - Bluetooth Low Energy functionality
- `common.ts` - Common utility functions
- `config.ts` - Configuration management
- `log.ts` - Logging utilities
- `mockData.ts` - Mock data for development
- `notification.ts` - Push notification handling
- `tray.ts` - System tray integration
- `window.ts` - Window management

### Context (`/src/context/`)
- `ConfigContext.tsx` - Global configuration state
- `theme-provider.tsx` - Theme management context

## Backend (`/src-tauri/`)
- `Cargo.toml` - Rust dependencies and configuration
- `tauri.conf.json` - Tauri application configuration
- `build.rs` - Build script
- `src/` - Rust source code
  - `main.rs` - Application entry point
  - `lib.rs` - Library exports
  - `ble.rs` - Bluetooth functionality
  - `tray.rs` - System tray implementation
  - `window.rs` - Window management
  - `common.rs` - Common utilities

## Build & CI (`/.github/`)
- `workflows/build.yml` - Main build workflow
- `workflows/build-linux.yml` - Linux-specific build
- `workflows/release.yml` - Release workflow

## Configuration
- `.vscode/` - VS Code settings
- `.cursor/` - Cursor IDE settings
- `capabilities/` - Tauri capability definitions
- `icons/` - Application icons