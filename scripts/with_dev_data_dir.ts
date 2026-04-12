import { spawn } from "node:child_process";
import { resolve } from "node:path";

const DEFAULT_DIR = ".dev-data-test";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: bun scripts/with_dev_data_dir.ts <command> [args...]");
  process.exit(1);
}

const customDirArg = process.env.ZMK_BATTERY_CENTER_DEV_TEST_DIR?.trim();
const targetDir = customDirArg && customDirArg.length > 0 ? customDirArg : DEFAULT_DIR;
const resolvedDir = resolve(process.cwd(), targetDir);

const child = spawn(args[0], args.slice(1), {
  stdio: "inherit",
  shell: true,
  env: {
    ...process.env,
    ZMK_BATTERY_CENTER_DATA_DIR: resolvedDir,
  },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
