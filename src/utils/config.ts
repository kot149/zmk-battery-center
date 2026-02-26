import { load, type Store, getStorePath } from '@/utils/storage';
import { Theme } from '@/context/theme-provider';
import { enable as enableAutostart, isEnabled as isAutostartEnabled, disable as disableAutostart } from '@tauri-apps/plugin-autostart';
import { requestNotificationPermission } from './notification';
import { logger } from './log';

export enum NotificationType {
	LowBattery = 'low_battery',
	Disconnected = 'disconnected',
	Connected = 'connected',
}

export const FETCH_INTERVAL_AUTO = 'auto' as const;
export type FetchInterval = number | typeof FETCH_INTERVAL_AUTO;

export type Config = {
	theme: Theme;
	fetchInterval: FetchInterval;
	autoStart: boolean;
	pushNotification: boolean;
	pushNotificationWhen: Record<NotificationType, boolean>;
	manualWindowPositioning: boolean;
	windowPosition: {
		x: number;
		y: number;
	};
}

export const defaultConfig: Config = {
	theme: 'dark' as Theme,
	fetchInterval: FETCH_INTERVAL_AUTO,
	autoStart: false,
	pushNotification: false,
	pushNotificationWhen: {
		[NotificationType.LowBattery]: true,
		[NotificationType.Connected]: true,
		[NotificationType.Disconnected]: true,
	},
	manualWindowPositioning: false,
	windowPosition: {
		x: 0,
		y: 0,
	},
};

let configStoreInstance: Store | null = null;

async function getConfigStore() {
	if (!configStoreInstance) {
		const storePath = await getStorePath('config.json');
		configStoreInstance = await load(storePath, { autoSave: true, defaults: defaultConfig });
	}
	return configStoreInstance;
}

export async function loadSavedConfig(): Promise<Config> {
	const config = await getConfigStore().then((store: Store) => store.get<Config>('config'));
	logger.info(`Loaded config: ${JSON.stringify(config, null, 4)}`);
	return {
		...defaultConfig,
		...config,
	};
};

export async function setConfig(config: Config) {
	const [, isEnabled] = await Promise.all([
		getConfigStore().then((store: Store) => store.set('config', config)),
		isAutostartEnabled(),
	]);

	// Set/Unset autostart
	if (config.autoStart && !isEnabled) {
		await enableAutostart();
	} else if (!config.autoStart && isEnabled) {
		await disableAutostart();
	}

	// Set/Unset notification permission
	if (config.pushNotification) {
		const isGranted = await requestNotificationPermission();
		if(isGranted){
			logger.info('Notification permission granted');
		} else {
			logger.warn('Notification permission not granted');
		}
	}

	logger.info(`Set config: ${JSON.stringify(config, null, 4)}`);
};
