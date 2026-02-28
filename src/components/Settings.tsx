import React from "react";
import Button from "./Button";
import { FETCH_INTERVAL_AUTO, NotificationType } from "../utils/config";
import { useTheme, type Theme } from "@/context/theme-provider";
import { Moon, Sun } from "lucide-react";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch"
import { XMarkIcon } from "@heroicons/react/24/outline";
import { useConfigContext } from "@/context/ConfigContext";
import TopRightButtons from "./TopRightButtons";

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

const Settings: React.FC<SettingsScreenProps> = ({
	onExit
}) => {
	const { setTheme, theme } = useTheme();
	const { config, setConfig } = useConfigContext();

	return (
		<div className="fixed inset-0 z-50 flex flex-col items-center justify-center h-full w-full p-4">
			{/* Top-right close button */}
			<div className="absolute top-2 right-2">
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

			<div className="flex flex-col gap-3 w-full p-4">
				{/* Theme */}
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
									${theme === opt.key ? 'bg-secondary' : 'bg-transparent'}
								`}
								aria-label={opt.label}
							>
								{opt.icon}
							</Button>
						))}
					</div>
				</div>

				{/* Battery fetch interval */}
				<div className="flex justify-between">
					<span>Battery fetch interval</span>
					<div>
					<Select
						value={config.fetchInterval.toString()}
						onValueChange={value => setConfig(c => ({ ...c, fetchInterval: value === FETCH_INTERVAL_AUTO ? FETCH_INTERVAL_AUTO : Number(value) }))}
					>
						<SelectTrigger size="sm">
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

				{/* Auto start at login */}
				<div className="flex justify-between">
					<span>Auto start at login</span>
					<Switch
						checked={config.autoStart}
						onCheckedChange={checked => setConfig(c => ({ ...c, autoStart: checked }))}
					/>
				</div>

				{/* Push notifications */}
				<div className="flex flex-col w-full gap-2">
					<div className="flex justify-between">
						<span className="">Push notifications</span>
						<Switch
							checked={config.pushNotification}
							onCheckedChange={checked => setConfig(c => ({ ...c, pushNotification: checked }))}
						/>
					</div>
					<ul className={`w-full pl-2 space-y-0.5 ${!config.pushNotification ? ' text-muted-foreground' : 'text-card-foreground'}`}>
						<li className="flex justify-between">
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
						<li className="flex justify-between">
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
						<li className="flex justify-between">
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
				</div>
			</div>
		</div>
	);
};

export default Settings;
