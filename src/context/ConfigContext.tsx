import { createContext, useContext, Dispatch, SetStateAction, ReactNode, useState, useEffect, useCallback } from 'react';
import { defaultConfig, loadSavedConfig, setConfig as storeSetConfig, type Config } from '../utils/config';
import { useTheme, type Theme } from '@/context/theme-provider';
import { logger } from '@/utils/log';
import { listen, emit } from '@tauri-apps/api/event';

type ConfigContextType = {
	config: Config;
	setConfig: Dispatch<SetStateAction<Config>>;
	isConfigLoaded: boolean;
};

const ConfigContext = createContext<ConfigContextType | undefined>(undefined);

export const ConfigProvider = ({ children }: { children: ReactNode }) => {
	const [config, setConfig] = useState<Config>(defaultConfig);
	const [isConfigLoaded, setIsConfigLoaded] = useState(false);
	const { setTheme } = useTheme();

	const updateConfigWithPersistence = useCallback(async (newConfig: Config) => {
		await storeSetConfig(newConfig);
		await emit<Config>('config-changed', newConfig);
	}, []);

	const updateConfig = useCallback((updates: SetStateAction<Config>) => {
		setConfig(prevConfig => {
			const newConfig = typeof updates === 'function' ? updates(prevConfig) : updates;
			if (isConfigLoaded) {
				updateConfigWithPersistence(newConfig);
			}
			return newConfig;
		});
	}, [isConfigLoaded, updateConfigWithPersistence]);

	useEffect(() => {
		let isMounted = true;
		(async () => {
			const loaded = await loadSavedConfig();
			if (isMounted) {
				setConfig(loaded);
				setIsConfigLoaded(true);
				setTheme(loaded.theme as Theme);
				await emit<Config>('config-changed', loaded);
				logger.info(`Loaded config: ${JSON.stringify(loaded, null, 4)}`);
				logger.info(`Theme set to: ${loaded.theme}`);
			}
		})();
		return () => { isMounted = false; };
	}, [setTheme]);

	useEffect(() => {
		const unlistenPromise = listen<Partial<Config>>('update-config', (event) => {
			const updates = event.payload;
			logger.info(`Received update-config event: ${JSON.stringify(updates)}`);
			updateConfig(prevConfig => ({
				...prevConfig,
				...updates,
			}));
		});

		return () => {
			unlistenPromise.then(unlisten => unlisten());
		};
	}, [updateConfig]);

	return (
		<ConfigContext.Provider value={{ config, setConfig: updateConfig, isConfigLoaded }}>
			{children}
		</ConfigContext.Provider>
	);
};

export function useConfigContext(): ConfigContextType {
	const context = useContext(ConfigContext);
	if (!context) {
		throw new Error('useConfigContext must be used within a ConfigProvider');
	}
	return context;
}
