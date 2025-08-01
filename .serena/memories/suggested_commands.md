# Suggested Commands

## Development Commands
- `bun install` - Install frontend dependencies
- `bun tauri dev` - Run in development mode
- `bun dev` - Run Vite dev server only (for UI development)
- `bun tauri build` - Build for production
- `bun tauri build --target <target>` - Build for specific target platform

## Build Targets
- `aarch64-apple-darwin` - macOS ARM64 (M1+)
- `x86_64-apple-darwin` - macOS Intel
- `x86_64-pc-windows-msvc` - Windows x64

## Rust/Cargo Commands (in src-tauri/)
- `cargo clean` - Clean build cache (useful when build fails)
- `cargo check` - Check code without building
- `cargo clippy` - Run linter
- `cargo test` - Run tests

## Windows System Commands
- `dir` - List directory contents (equivalent to `ls`)
- `cd` - Change directory
- `findstr` - Search text in files (equivalent to `grep`)
- `where` - Find executable location (equivalent to `which`)

## Git Commands
- `git status` - Check repository status
- `git add .` - Stage all changes
- `git commit -m "message"` - Commit changes
- `git push` - Push to remote

## Package Management
- `bun add <package>` - Add dependency
- `bun remove <package>` - Remove dependency