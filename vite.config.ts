import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const host = process.env.TAURI_DEV_HOST;
const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  lint: {
    plugins: ["typescript", "unicorn", "oxc", "react"],
    categories: {
      correctness: "error",
    },
    rules: {
      "no-undef": "off",
      "no-unused-vars": [
        "warn",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          vars: "all",
          varsIgnorePattern: "^_",
        },
      ],
      "react/rules-of-hooks": "error",
      "react/exhaustive-deps": "error",
      "react/no-deriving-state-in-effects": "warn",
      "react/refs": "off",
      "react/set-state-in-effect": "off",
      "react/purity": "off",
      "react/react-in-jsx-scope": "off",
    },
    settings: {
      react: {
        version: "19.2.8",
      },
    },
    env: {
      builtin: true,
    },
    globals: {
      window: "readonly",
      document: "readonly",
      console: "readonly",
      setTimeout: "readonly",
      clearTimeout: "readonly",
      setInterval: "readonly",
      clearInterval: "readonly",
      navigator: "readonly",
      fetch: "readonly",
      Promise: "readonly",
      AbortController: "readonly",
      Blob: "readonly",
      URL: "readonly",
      HTMLElement: "readonly",
      HTMLButtonElement: "readonly",
      localStorage: "readonly",
      location: "readonly",
      process: "readonly",
      NodeJS: "readonly",
      React: "readonly",
    },
    ignorePatterns: ["dist/**", "node_modules/**", "src-tauri/**"],
    overrides: [
      {
        files: ["src/**/*.ts", "src/**/*.tsx"],
        rules: {
          "unicorn/filename-case": [
            "error",
            {
              case: "kebabCase",
            },
          ],
        },
      },
      {
        files: ["e2e/**/*.ts"],
        rules: {
          "react/rules-of-hooks": "off",
          "react/exhaustive-deps": "off",
        },
      },
      {
        files: ["e2e/support/**/*.js"],
        globals: {
          window: "readonly",
          Map: "readonly",
          Set: "readonly",
          Promise: "readonly",
          Math: "readonly",
          Number: "readonly",
          JSON: "readonly",
          Object: "readonly",
          Error: "readonly",
          String: "readonly",
        },
      },
    ],
  },
  root: path.resolve(dirname, "src"),
  plugins: [react(), tailwindcss()],

  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./test/setup.ts",
    include: ["**/__tests__/**/*.test.ts", "**/__tests__/**/*.test.tsx"],
  },

  resolve: {
    alias: {
      "@": path.resolve(dirname, "src"),
    },
  },

  build: {
    outDir: path.resolve(dirname, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(dirname, "src/index.html"),
        about: path.resolve(dirname, "src/about.html"),
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
});
