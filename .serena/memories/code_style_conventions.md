# Code Style and Conventions

## TypeScript/React Conventions
- **Strict TypeScript**: Enabled with strict mode, noUnusedLocals, noUnusedParameters
- **Function Components**: Use function declarations, not arrow functions for components
- **State Management**: useState with TypeScript generics, React Context for global state
- **Imports**: ES modules, path aliases using `@/` for src directory
- **Component Structure**: Props interfaces defined inline or as separate types
- **Event Handlers**: Prefix with `handle` (e.g., `handleCloseModal`)
- **Async Functions**: Use async/await pattern, proper error handling with try/catch

## File Organization
- **Components**: `/src/components/` - React components
- **UI Components**: `/src/components/ui/` - shadcn/ui components
- **Utils**: `/src/utils/` - Utility functions and shared logic
- **Context**: `/src/context/` - React context providers
- **Types**: Defined inline or in respective files

## Naming Conventions
- **Files**: camelCase for TypeScript files (e.g., `App.tsx`, `config.ts`)
- **Components**: PascalCase (e.g., `BatteryIcon`, `RegisteredDevicesPanel`)
- **Variables/Functions**: camelCase (e.g., `fetchDevices`, `isDebugMode`)
- **Constants**: camelCase for local, UPPER_SNAKE_CASE for globals (e.g., `IS_DEV`)
- **Types/Interfaces**: PascalCase (e.g., `Config`, `BatteryInfo`)

## Rust Conventions
- **Standard Rust**: Following rustfmt defaults
- **Module Structure**: Separate files for different concerns (ble.rs, tray.rs, window.rs)
- **Error Handling**: Result types with proper error propagation
- **Async**: Tokio runtime for async operations

## Tailwind CSS
- **Utility Classes**: Extensive use of Tailwind utilities
- **CSS Variables**: Using CSS custom properties for theming
- **Component Variants**: class-variance-authority for component styling
- **Responsive**: Mobile-first approach where applicable