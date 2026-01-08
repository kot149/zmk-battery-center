import * as fs from "fs/promises";

type VersionSources = {
	packageJson: string;
	tauriConf: string;
	cargoToml: string;
	gitTag: string;
};

function parseArgs(argv: string[]) {
	const args = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (!token?.startsWith("--")) continue;
		const key = token.slice(2);
		const next = argv[i + 1];
		if (next && !next.startsWith("--")) {
			args.set(key, next);
			i++;
			continue;
		}
		args.set(key, "true");
	}
	return args;
}

function isPlainSemver(version: string): boolean {
	return /^\d+\.\d+\.\d+$/.test(version);
}

function normalizeTag(tag: string): string {
	return tag.trim();
}

function tagToVersion(tag: string): string {
	const t = normalizeTag(tag);
	if (!/^v\d+\.\d+\.\d+$/.test(t)) {
		throw new Error(
			`git tag must be in the format "vX.Y.Z" (example: v1.2.3). Received: ${JSON.stringify(t)}`
		);
	}
	return t.slice(1);
}

async function readPackageJsonVersion(): Promise<string> {
	const raw = await fs.readFile("package.json", "utf-8");
	const data = JSON.parse(raw) as { version?: unknown };
	if (typeof data.version !== "string" || !isPlainSemver(data.version)) {
		throw new Error(
			`package.json version must be a string in the format "X.Y.Z". Received: ${JSON.stringify(
				data.version
			)}`
		);
	}
	return data.version;
}

async function readTauriConfVersion(): Promise<string> {
	const raw = await fs.readFile("src-tauri/tauri.conf.json", "utf-8");
	const data = JSON.parse(raw) as { version?: unknown };
	if (typeof data.version !== "string" || !isPlainSemver(data.version)) {
		throw new Error(
			`src-tauri/tauri.conf.json version must be a string in the format "X.Y.Z". Received: ${JSON.stringify(
				data.version
			)}`
		);
	}
	return data.version;
}

function readCargoPackageVersionFromToml(toml: string): string {
	const lines = toml.split(/\r?\n/);
	let inPackage = false;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		const sectionMatch = trimmed.match(/^\[(.+?)\]$/);
		if (sectionMatch) {
			inPackage = sectionMatch[1] === "package";
			continue;
		}

		if (!inPackage) continue;

		const versionMatch = trimmed.match(/^version\s*=\s*"([^"]+)"\s*$/);
		if (!versionMatch) continue;

		const version = versionMatch[1];
		if (!isPlainSemver(version)) {
			throw new Error(
				`src-tauri/Cargo.toml [package] version must be in the format "X.Y.Z". Received: ${JSON.stringify(
					version
				)}`
			);
		}
		return version;
	}

	throw new Error(`Could not find [package] version in src-tauri/Cargo.toml`);
}

async function readCargoTomlVersion(): Promise<string> {
	const raw = await fs.readFile("src-tauri/Cargo.toml", "utf-8");
	return readCargoPackageVersionFromToml(raw);
}

function formatMismatchTable(s: VersionSources) {
	return [
		`package.json:           ${s.packageJson}`,
		`src-tauri/tauri.conf.json: ${s.tauriConf}`,
		`src-tauri/Cargo.toml:      ${s.cargoToml}`,
		`git tag:               ${s.gitTag}`,
	].join("\n");
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const tagArg = args.get("tag") ?? process.env.GIT_TAG ?? process.env.GITHUB_REF_NAME;

	if (!tagArg) {
		throw new Error(
			`git tag is required. Provide via "--tag vX.Y.Z" or set GIT_TAG / GITHUB_REF_NAME.`
		);
	}

	const versionFromTag = tagToVersion(tagArg);
	const packageJson = await readPackageJsonVersion();
	const tauriConf = await readTauriConfVersion();
	const cargoToml = await readCargoTomlVersion();

	const sources: VersionSources = {
		packageJson,
		tauriConf,
		cargoToml,
		gitTag: `v${versionFromTag}`,
	};

	const allMatch =
		packageJson === versionFromTag &&
		tauriConf === versionFromTag &&
		cargoToml === versionFromTag;

	if (!allMatch) {
		console.error("Version mismatch detected:\n");
		console.error(formatMismatchTable(sources));
		console.error("");
		console.error(
			`Expected all versions to match git tag ${sources.gitTag} (version ${versionFromTag}).`
		);
		process.exit(1);
	}

	console.log(`Version check OK: ${sources.gitTag}`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
