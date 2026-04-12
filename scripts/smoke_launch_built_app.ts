import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const APP_NAME = "zmk-battery-center";
const STARTUP_WAIT_MS = Number.parseInt(process.env.ZMK_BATTERY_CENTER_SMOKE_WAIT_MS ?? "8000", 10);
const STOP_WAIT_MS = 3000;

function delay(ms: number) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function candidatePaths(root: string): string[] {
  const ext = process.platform === "win32" ? ".exe" : "";
  return [
    resolve(root, "src-tauri", "target", "release", `${APP_NAME}${ext}`),
    resolve(root, "src-tauri", "target", "debug", `${APP_NAME}${ext}`),
  ];
}

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolveOutput(stdout);
        return;
      }
      reject(new Error(stderr || `Command failed with code ${String(code)}`));
    });
  });
}

async function hasPeerProcessRunning(binaryPath: string): Promise<boolean> {
  const exeName = binaryPath.split(/[\\/]/).pop() ?? APP_NAME;

  if (process.platform === "win32") {
    try {
      const output = await runCommand("tasklist", ["/FI", `IMAGENAME eq ${exeName}`]);
      const lines = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      return lines.some((line) => line.toLowerCase().startsWith(exeName.toLowerCase()));
    } catch {
      return false;
    }
  }

  try {
    const output = await runCommand("ps", ["-A", "-o", "comm="]);
    const names = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const baseName = exeName.replace(/\.exe$/i, "");
    return names.some((name) => name === baseName || name === exeName);
  } catch {
    return false;
  }
}

async function resolveBinaryPath(root: string): Promise<string> {
  const fromEnv = process.env.ZMK_BATTERY_CENTER_SMOKE_BIN?.trim();
  if (fromEnv) {
    const explicit = resolve(root, fromEnv);
    if (!(await pathExists(explicit))) {
      throw new Error(`Binary not found: ${explicit}`);
    }
    return explicit;
  }

  for (const candidate of candidatePaths(root)) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    [
      "Built app binary was not found.",
      "Build first with: bun run build:app",
      "Or set ZMK_BATTERY_CENTER_SMOKE_BIN to an explicit binary path.",
    ].join(" "),
  );
}

async function main() {
  const root = process.cwd();
  const binaryPath = await resolveBinaryPath(root);
  const dataDir = process.env.ZMK_BATTERY_CENTER_DATA_DIR ?? resolve(root, ".dev-data-smoke");

  console.log(`Using binary: ${binaryPath}`);
  console.log(`Using data dir: ${dataDir}`);
  console.log(`Waiting ${STARTUP_WAIT_MS}ms to verify process stays alive...`);

  const child = spawn(binaryPath, [], {
    stdio: "ignore",
    env: {
      ...process.env,
      ZMK_BATTERY_CENTER_DATA_DIR: dataDir,
    },
  });

  let exited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;

  child.on("error", (err) => {
    console.error(`Failed to start app: ${err.message}`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    exited = true;
    exitCode = code;
    exitSignal = signal;
  });

  await delay(STARTUP_WAIT_MS);

  if (exited) {
    if (exitCode === 0 && (await hasPeerProcessRunning(binaryPath))) {
      console.log(
        "App process exited quickly, but another instance is already running. Treating as pass due to single-instance behavior.",
      );
      console.log("Smoke launch test passed.");
      return;
    }
    throw new Error(`App exited too early (code=${String(exitCode)}, signal=${String(exitSignal)}).`);
  }

  console.log("App remained running during smoke window.");

  child.kill("SIGTERM");
  await delay(STOP_WAIT_MS);
  if (!exited) {
    child.kill("SIGKILL");
    await delay(200);
  }

  console.log("Smoke launch test passed.");
}

main().catch((err) => {
  console.error(`Smoke launch test failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
