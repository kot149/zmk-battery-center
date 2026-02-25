import React, { useState } from "react";
import BatteryIcon from "@/components/BatteryIcon";
import type { RegisteredDevice } from "@/App";
import { Button } from "@/components/Button";
import { EllipsisHorizontalIcon } from "@heroicons/react/24/outline";

interface DeviceListProps {
	registeredDevices: RegisteredDevice[];
	setRegisteredDevices: React.Dispatch<React.SetStateAction<RegisteredDevice[]>>;
	onRemoveDevice?: (device: RegisteredDevice) => void | Promise<void>;
}

const RegisteredDevicesPanel: React.FC<DeviceListProps> = ({
	registeredDevices,
	setRegisteredDevices,
	onRemoveDevice,
}) => {
	const [menuOpen, setMenuOpen] = useState<string | null>(null);
	const handleMenuOpen = (id: string) => setMenuOpen(id);
	const handleMenuClose = () => setMenuOpen(null);

	return (
		<div className="max-w-3xl mx-auto rounded-xl overflow-hidden">
			<div className="p-4 pt-2">
				<div className="space-y-4">
					{registeredDevices.map((device, deviceIdx) => (
						<div key={device.id} className="relative group bg-card rounded-lg p-4">
							{/* Top-right menu */}
							<div className="absolute top-2 right-2 z-10">
								<Button
									className="w-10 h-8 text-muted-foreground group-hover:opacity-100 opacity-0 bg-transparent hover:bg-muted hover:text-foreground !p-0"
									onClick={() => handleMenuOpen(device.id)}
									aria-label="Open menu"
								>
									<EllipsisHorizontalIcon className="size-6 mx-auto" />
								</Button>
								{menuOpen === device.id && (
									<div className={`${deviceIdx !== registeredDevices.length - 1 || registeredDevices.length === 1 ? 'absolute right-0' : 'fixed bottom-4 right-4'} w-30 bg-popover text-popover-foreground border border-border rounded-lg shadow-lg z-20`}>
										{ deviceIdx !== 0 && (
											<Button
												className="w-full text-left !text-sm !px-3 !py-2 bg-popover text-popover-foreground hover:bg-muted"
												onClick={() => {
													if (deviceIdx > 0) {
														setRegisteredDevices(prev => {
															const arr = [...prev];
															[arr[deviceIdx-1], arr[deviceIdx]] = [arr[deviceIdx], arr[deviceIdx-1]];
															return arr;
														});
													}
													handleMenuClose();
												}}
											>
												Move Up
											</Button>
										)}
										{ deviceIdx !== registeredDevices.length - 1 && (
											<Button
												className="w-full text-left !text-sm !px-3 !py-2 bg-popover text-popover-foreground hover:bg-muted"
												onClick={() => {
													if (deviceIdx < registeredDevices.length - 1) {
														setRegisteredDevices(prev => {
															const arr = [...prev];
															[arr[deviceIdx+1], arr[deviceIdx]] = [arr[deviceIdx], arr[deviceIdx+1]];
															return arr;
														});
													}
													handleMenuClose();
												}}
											>
												Move Down
											</Button>
										)}
										<Button
											className="w-full text-left !text-sm !px-3 !py-2 bg-popover text-destructive hover:bg-muted"
											onClick={async () => {
												if (onRemoveDevice) {
													await onRemoveDevice(device);
												} else {
													setRegisteredDevices(prev => prev.filter(d => d.id !== device.id));
												}
												handleMenuClose();
											}}
										>
											Remove
										</Button>
									</div>
								)}
							</div>

							{/* Click outside menu to close */}
							{menuOpen === device.id && (
								<div className="fixed inset-0 z-0" onClick={handleMenuClose}></div>
							)}

							{/* Device name + disconnected indicator */}
							<div className="flex items-baseline gap-2 mb-2">
								<span className={`text-lg font-semibold truncate ${device.isDisconnected ? 'max-w-45' : 'max-w-60'}`}>{device.name}</span>
								{device.isDisconnected && (
									<span className="text-xs text-destructive">disconnected</span>
								)}
							</div>

							{/* Battery info list */}
							{device.batteryInfos.length === 0 ? (
								<div className="text-muted-foreground mx-auto">No battery information</div>
							) : (
								<div className="space-y-1 ml-7">
									{device.batteryInfos.map((b, propIdx) => (
										<div key={propIdx} className="flex items-center gap-4">
											<span className="min-w-27 text-card-foreground/80">{b.user_descriptor ?? "Central"}</span>
											<BatteryIcon percentage={b.battery_level ?? 0} />
											<span className="w-10 min-w-10 text-card-foreground/90 text-right text-sm">{b.battery_level !== null ? `${b.battery_level}%` : "N/A"}</span>
										</div>
									))}
								</div>
							)}
						</div>
					))}
				</div>
			</div>
		</div>
	);
};

export default RegisteredDevicesPanel;
