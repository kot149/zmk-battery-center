#!/usr/bin/env node

import * as fs from "fs/promises";
import { execSync } from "child_process";

const REQUIRED_FILES = [
	"package.json",
	"src-tauri/tauri.conf.json",
	"src-tauri/Cargo.toml",
];

async function checkFilesExist(): Promise<boolean> {
	let allFilesExist = true;

	for (const file of REQUIRED_FILES) {
		try {
			await fs.access(file);
		} catch {
			console.error(`Error: ${file} not found.`);
			allFilesExist = false;
		}
	}

	return allFilesExist;
}

async function updatePackageJson(versionNumber: string): Promise<void> {
	const packageJsonPath = "package.json";
	let content = await fs.readFile(packageJsonPath, "utf-8");

	content = content.replace(
		/"version"\s*:\s*"[\d.]+"/,
		`"version": "${versionNumber}"`
	);

	await fs.writeFile(packageJsonPath, content);

	console.log(`Updated package.json version to ${versionNumber}`);
}

async function updateTauriConfig(versionNumber: string): Promise<void> {
	const tauriConfPath = "src-tauri/tauri.conf.json";
	let content = await fs.readFile(tauriConfPath, "utf-8");

	content = content.replace(
		/"version"\s*:\s*"[\d.]+"/,
		`"version": "${versionNumber}"`
	);

	await fs.writeFile(tauriConfPath, content);

	console.log(`Updated src-tauri/tauri.conf.json version to ${versionNumber}`);
}

async function updateCargoToml(versionNumber: string): Promise<void> {
	const cargoTomlPath = "src-tauri/Cargo.toml";
	let content = await fs.readFile(cargoTomlPath, "utf-8");

	content = content.replace(
		/^version\s*=\s*"[\d.]+"/m,
		`version = "${versionNumber}"`
	);

	await fs.writeFile(cargoTomlPath, content);

	console.log(`Updated src-tauri/Cargo.toml version to ${versionNumber}`);
}

function createGitCommit(version: string): void {
	const commitMessage = `chore: bump up to ${version}`;

	execSync(
		"git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml",
		{
			stdio: "inherit",
		}
	);

	execSync(`git commit -m "${commitMessage}"`, {
		stdio: "inherit",
	});

	console.log(`Created commit: ${commitMessage}`);
}

function createGitTag(version: string): void {
	execSync(`git tag ${version}`, {
		stdio: "inherit",
	});

	console.log(`Created tag: ${version}`);
}

function printNextSteps(version: string): void {
	console.log("");
	console.log("\x1b[32m=============================================\x1b[0m");
	console.log(
		"\x1b[32mTo push changes to remote, run the following commands:\x1b[0m"
	);
	console.log("\x1b[33mgit push\x1b[0m");
	console.log("\x1b[33mgit push --tags\x1b[0m");
	console.log("\x1b[32m=============================================\x1b[0m");

	console.log("");
	console.log("\x1b[36m=============================================\x1b[0m");
	console.log("\x1b[36mTo cancel changes, run the following commands:\x1b[0m");
	console.log("\x1b[36m1. To delete the tag:\x1b[0m");
	console.log(`\x1b[33m	 git tag -d ${version}\x1b[0m`);
	console.log(
		`\x1b[33m	 (If already pushed to remote): git push origin --delete ${version}\x1b[0m`
	);
	console.log("");
	console.log("\x1b[36m2. To revert the commit:\x1b[0m");
	console.log("\x1b[33m	 git reset --hard HEAD~1\x1b[0m");
	console.log(
		"\x1b[33m	 (If force push is needed, execute with caution): git push --force\x1b[0m"
	);
	console.log("\x1b[36m=============================================\x1b[0m");

	console.log(`\nVersion update to ${version} completed!`);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);

	if (args.length === 0) {
		console.error("Error: Version argument is required.");
		console.error("Usage: bun bump-version <version> [--no-git]");
		console.error("Example: bun bump-version v1.2.3");
		console.error("Example: bun bump-version v1.2.3 --no-git");
		process.exit(1);
	}

	const skipGit = args.includes("--no-git");
	const version = args.find((arg) => !arg.startsWith("--"));

	if (!version) {
		console.error("Error: Version argument is required.");
		console.error("Usage: bun bump-version <version> [--no-git]");
		process.exit(1);
	}

	if (!/^v\d+\.\d+\.\d+$/.test(version)) {
		console.error(
			'Error: Version must be in the format "vx.x.x". Example: v1.2.3'
		);
		process.exit(1);
	}

	const versionNumber = version.substring(1);

	const allFilesExist = await checkFilesExist();
	if (!allFilesExist) {
		console.error("Error: Required files not found. Cancelling process.");
		process.exit(1);
	}

	console.log(`Updating version to ${version}...`);
	if (skipGit) {
		console.log("Git operations will be skipped.");
	}

	try {
		await updatePackageJson(versionNumber);
		await updateTauriConfig(versionNumber);
		await updateCargoToml(versionNumber);

		if (!skipGit) {
			createGitCommit(version);
			createGitTag(version);
			printNextSteps(version);
		} else {
			console.log(`\nVersion update to ${version} completed!`);
			console.log(
				"Note: Git commit and tag were not created due to --no-git flag."
			);
		}
	} catch (error) {
		console.error("Error occurred during version update:", error);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error("Unexpected error:", error);
	process.exit(1);
});
