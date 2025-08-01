# Task Completion Checklist

## When a development task is completed, ensure:

### Code Quality
- [ ] TypeScript compilation passes (`tsc --noEmit` or through VS Code)
- [ ] No linting errors (VS Code ESLint extension or manual check)
- [ ] Rust code compiles without warnings (`cargo check` in src-tauri/)
- [ ] Rust clippy passes (`cargo clippy` in src-tauri/)

### Testing
- [ ] Application runs in development mode (`bun tauri dev`)
- [ ] UI changes work correctly across light/dark themes
- [ ] BLE functionality works with test devices (if applicable)
- [ ] Window positioning and sizing work correctly

### Build Verification
- [ ] Production build succeeds (`bun tauri build`)
- [ ] Built application launches and functions correctly

### Code Style
- [ ] Follows established naming conventions
- [ ] Proper TypeScript types and interfaces
- [ ] Consistent indentation and formatting
- [ ] Appropriate error handling and logging

### Platform Considerations
- [ ] Works on Windows (primary development platform)
- [ ] Consider macOS compatibility for BLE permissions
- [ ] Tauri-specific APIs used correctly

## Commands to Run
1. `bun tauri dev` - Verify development build
2. `cargo check` (in src-tauri/) - Check Rust compilation
3. `cargo clippy` (in src-tauri/) - Run Rust linter
4. `bun tauri build` - Verify production build

## No Automated Testing
This project does not have automated tests configured. Manual testing is required for all functionality.