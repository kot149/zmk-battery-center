# Development Environment

## Required Tools
- **Bun**: Package manager and bundler (latest version)
- **Rust**: Via rustup with stable toolchain
- **Platform-specific**:
  - Windows: No additional requirements
  - macOS: Xcode command line tools
  - Linux: libwebkit2gtk-4.1-dev, libappindicator3-dev, librsvg2-dev, patchelf

## VS Code Extensions (Recommended)
- Rust Analyzer
- TypeScript and JavaScript Language Features
- ESLint
- Tailwind CSS IntelliSense
- Tauri

## Project Setup
1. Clone repository
2. Run `bun install` to install frontend dependencies
3. Run `bun tauri dev` for development

## Build Targets
The project supports cross-compilation:
- **macOS**: Both Intel and Apple Silicon targets
- **Windows**: x64 target
- **Linux**: x64 target (configuration available)

## Development Workflow
1. **Frontend changes**: `bun dev` for fast UI development
2. **Full app testing**: `bun tauri dev` for complete functionality
3. **Production testing**: `bun tauri build` for release builds

## Debugging
- Frontend: Browser DevTools available in development
- Backend: Rust logging via tracing crate
- Tauri: Console logs forwarded to frontend console

## Platform Considerations
- **Windows**: Primary development platform
- **macOS**: Requires Bluetooth permissions for BLE functionality
- **BLE Testing**: Requires actual ZMK keyboards for full functionality