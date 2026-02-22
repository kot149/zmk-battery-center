import { invoke } from '@tauri-apps/api/core';
import { platform } from '@tauri-apps/plugin-os';
import { load, type Store } from '@tauri-apps/plugin-store';

export const DATA_DIR_ENV = 'ZMK_BATTERY_CENTER_DATA_DIR';

let devStorePathCached: string | null | undefined = undefined;

export async function getDevStorePath(): Promise<string | null> {
	if (devStorePathCached !== undefined) {
		return devStorePathCached;
	}
	try {
		devStorePathCached = await invoke<string | null>('get_dev_store_path');
		return devStorePathCached;
	} catch {
		devStorePathCached = null;
		return null;
	}
}

export async function getStorePath(filename: string): Promise<string> {
	const devPath = await getDevStorePath();
	if (devPath) {
		const sep = platform() === 'windows' ? '\\' : '/';
		return `${devPath}${sep}${filename}`;
	}
	return filename;
}

export { load, type Store };
