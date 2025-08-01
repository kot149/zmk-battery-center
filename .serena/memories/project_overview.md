# ZMK Battery Center - Project Overview

## Purpose
A cross-platform system tray application that monitors battery levels of ZMK-based keyboards, built with Tauri v2. It supports both central and peripheral sides of split keyboards and can monitor multiple keyboards simultaneously.

## Tech Stack
- **Frontend**: React 18 + TypeScript + Vite 6
- **UI**: Tailwind CSS 4 + shadcn/ui components (New York style)
- **Backend**: Rust (Tauri v2)
- **State Management**: React Context + local storage (Tauri store plugin)
- **Icons**: Lucide React + Heroicons
- **Build Tool**: Bun (package manager + bundler)
- **Bluetooth**: bluest crate for Rust BLE communication

## Supported Platforms
- macOS (both Intel and Apple Silicon)
- Windows
- Linux (build configuration available but commented out)

## Key Features
- Real-time battery monitoring via BLE GATT
- System tray integration
- Push notifications for low battery/connection status
- Multi-device support
- Auto-start functionality
- Light/dark theme switching
- Manual window positioning