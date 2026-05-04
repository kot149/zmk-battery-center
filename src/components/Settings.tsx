import React from "react";
import Button from "./Button";
import { FETCH_INTERVAL_AUTO, NotificationType, TrayIconComponent } from "../utils/config";
import { useTheme, type Theme } from "@/context/theme-provider";
import { Moon, Sun } from "lucide-react";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch"
import { XMarkIcon } from "@heroicons/react/24/outline";
import { useConfigContext } from "@/context/ConfigContext";
import TopRightButtons from "./TopRightButtons";
import { platform } from "@tauri-apps/plugin-os";

import { cn } from "@/lib/utils";

type SettingsGroupProps = {
	children: React.ReactNode;
	className?: string;
};

export const SettingsGroup: React.FC<SettingsGroupProps> = ({ children, className }) => (
	<div
		className={cn(
			"rounded-lg border border-card bg-card/90 p-3",
			className,
		)}
	>
		{children}
	</div>
);

interface SettingsScreenProps {
	onExit: () => Promise<void>;
}

const Dot = () => (
	<span className="mr-1 font-bold">•</span>
);

const fetchIntervalOptions = [
	{ label: 'Auto (experimental)', value: FETCH_INTERVAL_AUTO },
	{ label: '10 sec', value: 10_000 },
	{ label: '30 sec', value: 30_000 },
	{ label: '1 min', value: 60_000 },
	{ label: '3 min', value: 180_000 },
	{ label: '5 min', value: 300_000 },
	{ label: '10 min', value: 600_000 },
	{ label: '20 min', value: 1_200_000 },
	{ label: '30 min', value: 1_800_000 },
];

const trayIconComponentOptions = [
	{ label: "App icon", value: TrayIconComponent.AppIcon },
	{ label: "Role label", value: TrayIconComponent.RoleLabel },
	{ label: "Battery icon", value: TrayIconComponent.BatteryIcon },
	{ label: "Battery percentage", value: TrayIconComponent.BatteryPercent },
];

const settingsScrollAreaClassName = cn(
	"app-scrollbar min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-y-contain",
);

const Settings: React.FC<SettingsScreenProps> = ({
	onExit
}) => {
	const { setTheme, theme } = useTheme();
	const { config, setConfig } = useConfigContext();
	const isMac = platform() === "macos";

	const handleTrayIconComponentChange = (component: TrayIconComponent, checked: boolean) => {
		setConfig(c => {
			const current = c.trayIconComponents;
			const next = checked
				? [...current, component]
				: current.filter(item => item !== component);
			return {
				...c,
				trayIconComponents: next.length > 0 ? next : current,
			};
		});
	};

	return (
		<div className="fixed inset-0 z-50 flex h-full w-full min-h-0 flex-col pt-4 pb-4 pl-4 pr-1.5">
			{/* Top row: close stays inset; scroll track can extend into where right padding would be */}
			<div className="shrink-0 flex justify-end pr-4">
				<TopRightButtons
					buttons={[
						{
							icon: <XMarkIcon className="size-5 text-foreground" />,
							onClick: onExit,
							ariaLabel: "Close",
						}
					]}
				/>
			</div>

			<div className={settingsScrollAreaClassName}>
				<div className="mx-auto flex w-full min-w-0 max-w-md flex-col gap-3 pr-2.5 pt-1">
				{/* Auto start at login */}
				<SettingsGroup>
					<div className="flex items-center justify-between gap-3">
						<span className="shrink-0">Auto start at login</span>
						<Switch
							checked={config.autoStart}
							onCheckedChange={checked => setConfig(c => ({ ...c, autoStart: checked }))}
						/>
					</div>
				</SettingsGroup>

				{/* Theme */}
				<SettingsGroup>
					<div className="flex justify-between items-center">
						<span>Theme</span>
						<div className="flex-1 flex justify-end gap-2">
							{[
								{ key: "light", icon: (
									<div className="flex flex-col items-center justify-center">
										<Sun className="w-6 h-6" />
										<span className="text-xs">Light</span>
									</div>
								), label: "Light" },
								{ key: "dark", icon: (
									<div className="flex flex-col items-center justify-center">
										<Moon className="w-6 h-6" />
										<span className="text-xs">Dark</span>
									</div>
								), label: "Dark" },
								{ key: "system", icon: (
									<div className="flex flex-col items-center justify-center">
										<span className="relative w-6 h-6 flex items-center justify-center">
											<Sun className="absolute w-4 h-4 left-[-7%] top-[-7%]" />
											<Moon className="absolute w-4 h-4 right-[-7%] bottom-[-7%]" />
											<svg className="absolute left-0 top-0 w-6 h-6 pointer-events-none" width="24" height="24">
												<line x1="0" y1="20" x2="20" y2="0" stroke="currentColor" strokeWidth="0.5" strokeLinecap="round" />
											</svg>
										</span>
										<span className="text-xs">System</span>
									</div>
								), label: "System" },
							].map(opt => (
								<Button
									key={opt.key}
									onClick={() => {
										setTheme(opt.key as Theme);
										setConfig(c => ({ ...c, theme: opt.key as Theme }));
									}}
									className={`relative w-12 h-12 flex items-center justify-center rounded-lg transition-colors
									${theme === opt.key ? 'bg-muted-foreground/30' : 'bg-transparent'}
								`}
									aria-label={opt.label}
								>
									{opt.icon}
								</Button>
							))}
						</div>
					</div>
				</SettingsGroup>

				{/* Battery fetch interval */}
				<SettingsGroup>
					<div className="flex min-w-0 items-center justify-between gap-3">
						<span className="shrink-0">Battery fetch interval</span>
						<div className="flex min-w-0 max-w-full flex-1 basis-0 justify-end">
							<Select
								value={config.fetchInterval.toString()}
								onValueChange={value => setConfig(c => ({ ...c, fetchInterval: value === FETCH_INTERVAL_AUTO ? FETCH_INTERVAL_AUTO : Number(value) }))}
							>
								<SelectTrigger
									size="sm"
									className={cn(
										"data-[size=sm]:h-auto h-auto min-h-8 w-fit min-w-0 max-w-full whitespace-normal",
										"*:data-[slot=select-value]:block! *:data-[slot=select-value]:line-clamp-2! *:data-[slot=select-value]:whitespace-normal! *:data-[slot=select-value]:text-left",
									)}
								>
									<SelectValue placeholder="Select" />
								</SelectTrigger>
								<SelectContent>
									{fetchIntervalOptions.map(opt => (
										<SelectItem key={opt.value.toString()} value={opt.value.toString()}>
											{opt.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>
				</SettingsGroup>

				{isMac && (
					<SettingsGroup className="flex w-full flex-col gap-2">
						<div className="flex justify-between">
							<span>Tray icon components [macOS only]</span>
						</div>
						<ul className="w-full space-y-0.5 pl-2">
							{trayIconComponentOptions.map(option => {
								const checked = config.trayIconComponents.includes(option.value);
								const isLastChecked = checked && config.trayIconComponents.length === 1;
								return (
									<li key={option.value} className="flex items-center justify-between gap-3">
										<div>
											<Dot /> {option.label}
										</div>
										<Switch
											checked={checked}
											onCheckedChange={nextChecked => handleTrayIconComponentChange(option.value, nextChecked)}
											disabled={isLastChecked}
										/>
									</li>
								);
							})}
						</ul>
					</SettingsGroup>
				)}

				{/* Push notifications */}
				<SettingsGroup className="flex w-full flex-col gap-2">
					<div className="flex items-center justify-between gap-3">
						<span className="shrink-0">Push notifications</span>
						<Switch
							checked={config.pushNotification}
							onCheckedChange={checked => setConfig(c => ({ ...c, pushNotification: checked }))}
						/>
					</div>
					<ul className={`w-full space-y-0.5 pl-2 ${!config.pushNotification ? ' text-muted-foreground' : 'text-card-foreground'}`}>
						<li className="flex items-center justify-between gap-3">
							<div>
								<Dot /> when battery level ≤ 20%
							</div>
							<Switch
								checked={config.pushNotificationWhen[NotificationType.LowBattery]}
								onCheckedChange={checked => setConfig(c => ({
									...c,
									pushNotificationWhen: { ...c.pushNotificationWhen, [NotificationType.LowBattery]: checked }
								}))}
								disabled={!config.pushNotification}
							/>
						</li>
						<li className="flex items-center justify-between gap-3">
							<div>
								<Dot /> when device connected
							</div>
							<Switch
								checked={config.pushNotificationWhen[NotificationType.Connected]}
								onCheckedChange={checked => setConfig(c => ({
									...c,
									pushNotificationWhen: { ...c.pushNotificationWhen, [NotificationType.Connected]: checked }
								}))}
								disabled={!config.pushNotification}
							/>
						</li>
						<li className="flex items-center justify-between gap-3">
							<div>
								<Dot /> when device disconnected
							</div>
							<Switch
								checked={config.pushNotificationWhen[NotificationType.Disconnected]}
								onCheckedChange={checked => setConfig(c => ({
									...c,
									pushNotificationWhen: { ...c.pushNotificationWhen, [NotificationType.Disconnected]: checked }
								}))}
								disabled={!config.pushNotification}
							/>
						</li>
					</ul>
				</SettingsGroup>
				</div>
			</div>
		</div>
	);
};

export default Settings;
