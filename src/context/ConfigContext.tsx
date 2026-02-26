import { createContext, useContext, Dispatch, SetStateAction, ReactNode, useState, useEffect, useCallback, useRef, useMemo } from 'react';
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

	// rerender-dependencies: Use refs for values that should not trigger effect re-runs
	const setThemeRef = useRef(setTheme);
	setThemeRef.current = setTheme;

	const isConfigLoadedRef = useRef(isConfigLoaded);
	isConfigLoadedRef.current = isConfigLoaded;

	const updateConfigWithPersistence = useCallback(async (newConfig: Config, skipEmit = false) => {
		await storeSetConfig(newConfig);
		// Only emit config-changed if this is a user-initiated change, not from an event
		if (!skipEmit) {
			await emit<Config>('config-changed', newConfig);
		}
	}, []);

	// rerender-dependencies: Read isConfigLoaded from ref inside setState updater
	// so updateConfig has a stable identity and doesn't cause effect re-subscriptions
	const updateConfig = useCallback((updates: SetStateAction<Config>, skipEmit = false) => {
		setConfig(prevConfig => {
			const newConfig = typeof updates === 'function' ? updates(prevConfig) : updates;
			if (isConfigLoadedRef.current) {
				updateConfigWithPersistence(newConfig, skipEmit);
			}
			return newConfig;
		});
	}, [updateConfigWithPersistence]);

	// rerender-dependencies: Use ref for setTheme so init effect runs only once on mount
	useEffect(() => {
		let isMounted = true;
		(async () => {
			const loaded = await loadSavedConfig();
			if (isMounted) {
				setConfig(loaded);
				setIsConfigLoaded(true);
				setThemeRef.current(loaded.theme as Theme);
				await emit<Config>('config-changed', loaded);
				logger.info(`Loaded config: ${JSON.stringify(loaded, null, 4)}`);
				logger.info(`Theme set to: ${loaded.theme}`);
			}
		})();
		return () => { isMounted = false; };
	}, []);

	useEffect(() => {
		const unlistenPromise = listen<Partial<Config>>('update-config', (event) => {
			const updates = event.payload;
			logger.info(`Received update-config event: ${JSON.stringify(updates)}`);

			updateConfig(prevConfig => ({
				...prevConfig,
				...updates,
			}), true); // Skip emitting config-changed to prevent loop
		});

		return () => {
			unlistenPromise.then(unlisten => unlisten());
		};
	}, [updateConfig]);

	// rerender-memo-with-default-value: Memoize context value to prevent
	// unnecessary re-renders of all consumers on every provider render
	const contextValue = useMemo(() => ({
		config,
		setConfig: updateConfig,
		isConfigLoaded,
	}), [config, updateConfig, isConfigLoaded]);

	return (
		<ConfigContext.Provider value={contextValue}>
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
