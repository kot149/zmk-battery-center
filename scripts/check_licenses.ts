#!/usr/bin/env node

/**
 * License verification script
 *
 * Verifies licenses for Cargo and JS dependencies,
 * checking for denied licenses such as GPL.
 *
 * Usage:
 *   bun scripts/check_licenses.ts [--cargo-only] [--js-only]
 */

import { execSync } from "child_process";

// Allowed licenses list (same as deny.toml)
const ALLOWED_JS_LICENSES = [
	"MIT",
	"MIT-0",
	"Apache-2.0",
	"Apache 2.0",
	"Apache License 2.0",
	"BSD-2-Clause",
	"BSD-3-Clause",
	"ISC",
	"Zlib",
	"CC0-1.0",
	"0BSD",
	"Unlicense",
	"MPL-2.0",
	"Unicode-3.0",
	"BSL-1.0",
	"CC-BY-4.0",
	"Python-2.0",
	"BlueOak-1.0.0",
];

// Denied licenses (GPL variants, etc.)
const DENIED_JS_LICENSES = [
	"GPL",
	"GPL-2.0",
	"GPL-2.0-only",
	"GPL-2.0-or-later",
	"GPL-3.0",
	"GPL-3.0-only",
	"GPL-3.0-or-later",
	"LGPL",
	"LGPL-2.0",
	"LGPL-2.1",
	"LGPL-3.0",
	"AGPL",
	"AGPL-3.0",
	"AGPL-3.0-only",
	"SSPL",
	"SSPL-1.0",
];

interface LicenseViolation {
	name: string;
	version: string;
	license: string;
	reason: "denied" | "unknown";
}

function checkCargoDenyInstalled(): boolean {
	try {
		execSync("cargo deny --version", { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

function isLicenseAllowed(license: string): boolean {
	if (!license || license === "UNKNOWN") {
		return false;
	}

	const normalizedLicense = license.trim();

	if (normalizedLicense.includes(" OR ")) {
		const licenses = normalizedLicense
			.replace(/[()]/g, "")
			.split(" OR ")
			.map((l) => l.trim());
		return licenses.some((l) => ALLOWED_JS_LICENSES.includes(l));
	}

	if (normalizedLicense.includes(" AND ")) {
		const licenses = normalizedLicense
			.replace(/[()]/g, "")
			.split(" AND ")
			.map((l) => l.trim());
		return licenses.every((l) => ALLOWED_JS_LICENSES.includes(l));
	}

	return ALLOWED_JS_LICENSES.includes(normalizedLicense);
}

function isLicenseDenied(license: string): boolean {
	if (!license) {
		return false;
	}

	const normalizedLicense = license.trim().toUpperCase();

	for (const denied of DENIED_JS_LICENSES) {
		if (
			normalizedLicense === denied.toUpperCase() ||
			normalizedLicense.includes(denied.toUpperCase())
		) {
			return true;
		}
	}

	return false;
}

function verifyCargoLicenses(): boolean {
	console.log("\nVerifying Cargo licenses with cargo-deny...");

	if (!checkCargoDenyInstalled()) {
		console.warn(
			"\x1b[33mWarning: cargo-deny is not installed. Skipping Cargo license verification.\x1b[0m"
		);
		console.log("Install it with: cargo install cargo-deny");
		return true;
	}

	try {
		execSync("cargo deny check licenses", {
			cwd: "src-tauri",
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		console.log("\x1b[32mCargo license verification passed!\x1b[0m");
		return true;
	} catch (error) {
		if (error instanceof Error && "stderr" in error) {
			console.error("\x1b[31mCargo license verification failed!\x1b[0m");
			console.error((error as { stderr: string }).stderr);
		}
		return false;
	}
}

function verifyJsLicenses(): boolean {
	console.log("\nVerifying JS licenses...");

	try {
		const result = execSync(
			"bun license-checker --json --production --relativeLicensePath",
			{
				encoding: "utf-8",
				maxBuffer: 50 * 1024 * 1024,
			}
		);

		const rawData = JSON.parse(result);
		const violations: LicenseViolation[] = [];

		for (const [pkgName, info] of Object.entries(rawData)) {
			const pkgInfo = info as { licenses?: string };
			const license = pkgInfo.licenses || "UNKNOWN";

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

			// Skip own project
			if (name === "zmk-battery-center") {
				continue;
			}

			if (isLicenseDenied(license)) {
				violations.push({ name, version, license, reason: "denied" });
			} else if (!isLicenseAllowed(license)) {
				violations.push({ name, version, license, reason: "unknown" });
			}
		}

		if (violations.length > 0) {
			console.error("\x1b[31mJS License verification failed!\x1b[0m");
			console.error("\nThe following packages have license issues:\n");

			const deniedViolations = violations.filter((v) => v.reason === "denied");
			const unknownViolations = violations.filter(
				(v) => v.reason === "unknown"
			);

			if (deniedViolations.length > 0) {
				console.error(
					"\x1b[31m=== DENIED LICENSES (must be removed) ===\x1b[0m"
				);
				for (const v of deniedViolations) {
					console.error(`  - ${v.name}@${v.version}: ${v.license}`);
				}
			}

			if (unknownViolations.length > 0) {
				console.error(
					"\n\x1b[33m=== UNKNOWN LICENSES (review required) ===\x1b[0m"
				);
				for (const v of unknownViolations) {
					console.error(`  - ${v.name}@${v.version}: ${v.license}`);
				}
				console.error(
					"\nAdd these licenses to ALLOWED_JS_LICENSES if they are permissive."
				);
			}

			return deniedViolations.length === 0;
		}

		console.log("\x1b[32mJS License verification passed!\x1b[0m");
		return true;
	} catch (error) {
		if (error instanceof Error) {
			console.error("Error verifying JS licenses:", error.message);
		}
		return false;
	}
}

function main(): void {
	const args = process.argv.slice(2);
	const cargoOnly = args.includes("--cargo-only");
	const jsOnly = args.includes("--js-only");

	console.log("License Checker for zmk-battery-center");

	let hasError = false;

	if (!jsOnly) {
		if (!verifyCargoLicenses()) {
			hasError = true;
		}
	}

	if (!cargoOnly) {
		if (!verifyJsLicenses()) {
			hasError = true;
		}
	}

	if (hasError) {
		console.error("\x1b[31mLicense check failed!\x1b[0m");
		process.exit(1);
	} else {
		console.log("\x1b[32mAll license checks passed!\x1b[0m");
	}
}

main();
