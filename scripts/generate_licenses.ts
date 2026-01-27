#!/usr/bin/env node

/**
 * License information generation script
 *
 * Outputs license lists for Cargo and JS dependencies to JSON files.
 *
 * Required tools:
 * - cargo-about: `cargo install cargo-about`
 * - cargo-deny: `cargo install cargo-deny` (for license verification)
 * - license-checker: runs via bun
 *
 * Usage:
 *   bun scripts/generate_licenses.ts [--cargo-only] [--js-only] [--skip-verify]
 */

import * as fs from "fs/promises";
import { execSync } from "child_process";
import * as path from "path";

const OUTPUT_DIR = "licenses";
const CARGO_OUTPUT = path.join(OUTPUT_DIR, "cargo-licenses.json");
const JS_OUTPUT = path.join(OUTPUT_DIR, "js-licenses.json");

interface CargoLicense {
	name: string;
	version: string;
	license: string;
	authors: string[];
	repository?: string;
}

interface JsLicense {
	name: string;
	version: string;
	license: string;
	repository?: string;
	publisher?: string;
	path: string;
}

async function ensureOutputDir(): Promise<void> {
	try {
		await fs.access(OUTPUT_DIR);
	} catch {
		await fs.mkdir(OUTPUT_DIR, { recursive: true });
		console.log(`Created output directory: ${OUTPUT_DIR}`);
	}
}

function checkCargoAboutInstalled(): boolean {
	try {
		execSync("cargo about --version", { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

/**
 * Run license verification using check_licenses.ts
 */
function runLicenseCheck(cargoOnly: boolean, jsOnly: boolean): boolean {
	console.log("\n=== Running license verification ===");

	try {
		const args: string[] = [];
		if (cargoOnly) args.push("--cargo-only");
		if (jsOnly) args.push("--js-only");

		execSync(`bun scripts/check_licenses.ts ${args.join(" ")}`, {
			encoding: "utf-8",
			stdio: "inherit",
		});
		return true;
	} catch {
		return false;
	}
}

async function generateCargoLicenses(): Promise<void> {
	console.log("\n=== Generating Cargo licenses ===");

	if (!checkCargoAboutInstalled()) {
		console.error("\x1b[31mError: cargo-about is not installed.\x1b[0m");
		console.log("Install it with: cargo install cargo-about");
		console.log("For more info: https://github.com/EmbarkStudios/cargo-about");
		throw new Error("cargo-about not installed");
	}

	console.log("Running cargo-about...");

	// Temp file path (using -o option to avoid PowerShell encoding issues)
	const tempOutputFile = path.join("..", OUTPUT_DIR, "cargo-about-raw.json");

	try {
		// Output to file using cargo-about with -o option
		execSync(
			`cargo about generate --format json --all-features -o "${tempOutputFile}"`,
			{
				cwd: "src-tauri",
				encoding: "utf-8",
				maxBuffer: 50 * 1024 * 1024, // 50MB buffer
			}
		);

		// Read output file
		const result = await fs.readFile(
			path.join(OUTPUT_DIR, "cargo-about-raw.json"),
			"utf-8"
		);
		const aboutData = JSON.parse(result);

		// Delete temp file
		await fs.unlink(path.join(OUTPUT_DIR, "cargo-about-raw.json"));

		// Format license information
		const licenses: CargoLicense[] = [];

		if (aboutData.licenses) {
			for (const licenseGroup of aboutData.licenses) {
				for (const pkg of licenseGroup.used_by || []) {
					licenses.push({
						name: pkg.crate.name,
						version: pkg.crate.version,
						license: licenseGroup.id || licenseGroup.name || "Unknown",
						authors: pkg.crate.authors || [],
						repository: pkg.crate.repository,
					});
				}
			}
		}

		// Sort by name
		licenses.sort((a, b) => a.name.localeCompare(b.name));

		await fs.writeFile(CARGO_OUTPUT, JSON.stringify(licenses, null, 2));
		console.log(`\x1b[32mCargo licenses saved to: ${CARGO_OUTPUT}\x1b[0m`);
		console.log(`Total packages: ${licenses.length}`);
	} catch (error) {
		if (error instanceof Error) {
			console.error("Error running cargo-about:", error.message);
		}
		throw error;
	}
}

async function generateJsLicenses(): Promise<void> {
	console.log("\n=== Generating JS licenses ===");

	try {
		// Run license-checker via bun
		const result = execSync(
			"bun license-checker --json --production --relativeLicensePath",
			{
				encoding: "utf-8",
				maxBuffer: 50 * 1024 * 1024,
			}
		);

		const rawData = JSON.parse(result);

		// Format data
		const licenses: JsLicense[] = [];

	for (const [pkgName, info] of Object.entries(rawData)) {
		const pkgInfo = info as {
			licenses?: string;
			repository?: string;
			publisher?: string;
			path?: string;
		};

		// Extract package name and version
		const atIndex = pkgName.lastIndexOf("@");
		let name: string;
		let version: string;

		if (atIndex > 0) {
			name = pkgName.substring(0, atIndex);
			version = pkgName.substring(atIndex + 1);
		} else {
			name = pkgName;
			version = "unknown";
		}

		// Skip the project itself (zmk-battery-center)
		if (name === "zmk-battery-center") {
			continue;
		}

		licenses.push({
			name,
			version,
			license: pkgInfo.licenses || "Unknown",
			repository: pkgInfo.repository,
			publisher: pkgInfo.publisher,
			path: pkgInfo.path || "",
		});
	}

		// Sort by name
		licenses.sort((a, b) => a.name.localeCompare(b.name));

		await fs.writeFile(JS_OUTPUT, JSON.stringify(licenses, null, 2));
		console.log(`\x1b[32mJS licenses saved to: ${JS_OUTPUT}\x1b[0m`);
		console.log(`Total packages: ${licenses.length}`);
	} catch (error) {
		if (error instanceof Error) {
			console.error("Error running license-checker:", error.message);
		}
		throw error;
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const cargoOnly = args.includes("--cargo-only");
	const jsOnly = args.includes("--js-only");
	const skipVerify = args.includes("--skip-verify");

	console.log("License Generator for zmk-battery-center");
	console.log("=========================================");

	await ensureOutputDir();

	let hasError = false;

	// License verification (unless --skip-verify is specified)
	if (!skipVerify) {
		if (!runLicenseCheck(cargoOnly, jsOnly)) {
			console.error("\x1b[31mLicense verification failed! Aborting.\x1b[0m");
			console.error("If you believe this is a false positive, run with --skip-verify");
			process.exit(1);
		}
	}

	if (!jsOnly) {
		try {
			await generateCargoLicenses();
		} catch {
			hasError = true;
			console.error("\x1b[31mFailed to generate Cargo licenses\x1b[0m");
		}
	}

	if (!cargoOnly) {
		try {
			await generateJsLicenses();
		} catch {
			hasError = true;
			console.error("\x1b[31mFailed to generate JS licenses\x1b[0m");
		}
	}

	console.log("\n=========================================");

	if (hasError) {
		console.log("\x1b[33mCompleted with errors. See above for details.\x1b[0m");
		process.exit(1);
	} else {
		console.log("\x1b[32mAll licenses generated successfully!\x1b[0m");
		console.log(`Output directory: ${OUTPUT_DIR}/`);
	}
}

main().catch((error) => {
	console.error("Unexpected error:", error);
	process.exit(1);
});
