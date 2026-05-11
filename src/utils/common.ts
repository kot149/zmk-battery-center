import { invoke } from "@tauri-apps/api/core";
import { logger } from "./log";

export async function sleep(ms: number) {
	await new Promise(resolve => setTimeout(resolve, ms));
}

export function logAsyncWarning(context: string, error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	logger.warn(`${context}: ${message}`);
}

export function fireAndForget(promise: Promise<unknown>, context: string) {
	promise.catch((error) => {
		logAsyncWarning(context, error);
	});
}

export async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	createTimeoutError: () => Error,
) {
	let timeoutId: number | null = null;
	const timeoutPromise = new Promise<T>((_, reject) => {
		timeoutId = window.setTimeout(() => {
			reject(createTimeoutError());
		}, timeoutMs);
	});

	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timeoutId !== null) {
			clearTimeout(timeoutId);
		}
	}
}

export async function exitApp() {
	await invoke("exit_app");
}
