import React, { useState, useRef, useEffect, type RefObject, type MutableRefObject } from "react";
import BatteryIcon from "@/components/BatteryIcon";
import BatteryHistoryChart from "@/components/BatteryHistoryChart";
import type { RegisteredDevice } from "@/App";
import { Button } from "@/components/Button";
import {
	ArrowUturnLeftIcon,
	EllipsisHorizontalIcon,
	PencilSquareIcon,
} from "@heroicons/react/24/outline";
import type { BatteryInfo } from "@/utils/ble";
import {
	batteryPartLabelStorageKey,
	defaultBatteryPartDisplayName,
	getBatteryPartDisplayName,
} from "@/utils/batteryLabels";
import { cn } from "@/lib/utils";

const ChartCurveIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...props}>
		<path d="M4 4 V20 H20" />
		<path d="M7 16 Q11 6, 13 12 Q15 18, 19 8" />
	</svg>
);

interface DeviceListProps {
	registeredDevices: RegisteredDevice[];
	setRegisteredDevices: React.Dispatch<React.SetStateAction<RegisteredDevice[]>>;
	onRemoveDevice?: (device: RegisteredDevice) => void | Promise<void>;
	onChartOpenChange?: (isOpen: boolean) => void;
}

type DeviceTopBarProps = {
	deviceIdx: number;
	deviceCount: number;
	isMenuOpen: boolean;
	onChart: () => void;
	onOpenMenu: () => void;
	onMoveUp: () => void;
	onMoveDown: () => void;
	onRemove: () => void | Promise<void>;
};

const DeviceTopBar: React.FC<DeviceTopBarProps> = ({
	deviceIdx,
	deviceCount,
	isMenuOpen,
	onChart,
	onOpenMenu,
	onMoveUp,
	onMoveDown,
	onRemove,
}) => {
	const menuClass =
		deviceIdx !== deviceCount - 1 || deviceCount === 1
			? "absolute right-0"
			: "fixed bottom-4 right-4";

	return (
		<div className="absolute top-2 right-2 w-14 z-10 flex items-center gap-0.5">
			<Button
				className="w-8 h-8 text-muted-foreground group-hover:opacity-100 opacity-0 bg-transparent hover:bg-muted hover:text-foreground p-0! transition-opacity"
				onClick={onChart}
				aria-label="Show battery history chart"
			>
				<ChartCurveIcon className="size-5 mx-auto" />
			</Button>
			<Button
				className="w-10 h-8 text-muted-foreground group-hover:opacity-100 opacity-0 bg-transparent hover:bg-muted hover:text-foreground p-0! transition-opacity"
				onClick={onOpenMenu}
				aria-label="Open menu"
			>
				<EllipsisHorizontalIcon className="size-6 mx-auto" />
			</Button>
			{isMenuOpen && (
				<div
					className={`${menuClass} w-36 bg-popover text-popover-foreground border border-border rounded-lg shadow-lg z-20`}
				>
					{deviceIdx !== 0 && (
						<Button
							className="w-full text-left text-sm! px-3! py-2! bg-popover text-popover-foreground hover:bg-muted"
							onClick={onMoveUp}
						>
							Move Up
						</Button>
					)}
					{deviceIdx !== deviceCount - 1 && (
						<Button
							className="w-full text-left text-sm! px-3! py-2! bg-popover text-popover-foreground hover:bg-muted"
							onClick={onMoveDown}
						>
							Move Down
						</Button>
					)}
					<Button
						className="w-full text-left text-sm! px-3! py-2! bg-popover text-destructive hover:bg-muted"
						onClick={onRemove}
					>
						Remove
					</Button>
				</div>
			)}
		</div>
	);
};

type PartLabelEditProps = {
	value: string;
	onChange: (v: string) => void;
	onCommitBlur: () => void;
	onEnter: () => void;
	onEscape: () => void;
	onReset: () => void;
	inputRef: RefObject<HTMLInputElement | null>;
	skipLabelCommitOnBlur: MutableRefObject<boolean>;
};

const PartLabelEdit: React.FC<PartLabelEditProps> = ({
	value,
	onChange,
	onCommitBlur,
	onEnter,
	onEscape,
	onReset,
	inputRef,
	skipLabelCommitOnBlur,
}) => (
	<div className="relative w-full min-w-0">
		<input
			ref={inputRef}
			type="text"
			className="box-border w-full min-w-0 rounded border border-border bg-background py-0.5 pl-0.5 pr-7 text-sm text-card-foreground"
			value={value}
			onChange={(e) => onChange(e.target.value)}
			onBlur={onCommitBlur}
			onKeyDown={(e) => {
				if (e.key === "Enter") onEnter();
				else if (e.key === "Escape") onEscape();
			}}
		/>
		<button
			type="button"
			className="absolute right-0.5 top-1/2 z-10 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
			aria-label="Reset label and close"
			title="Reset label and close"
			onPointerDown={(e) => {
				e.preventDefault();
				skipLabelCommitOnBlur.current = true;
			}}
			onClick={onReset}
		>
			<ArrowUturnLeftIcon className="size-3.5" strokeWidth={1.5} />
		</button>
	</div>
);

type PartLabelViewProps = {
	displayName: string;
	defaultNameTitle: string;
	onStartEdit: () => void;
};

const PartLabelView: React.FC<PartLabelViewProps> = ({ displayName, defaultNameTitle, onStartEdit }) => (
	<div className="flex w-full min-w-0 max-w-full flex-nowrap items-center justify-start gap-1.5">
		<span
			className="min-w-0 max-w-[calc(100%-1.875rem)] shrink truncate text-card-foreground/80"
			title={defaultNameTitle}
		>
			{displayName}
		</span>
		<Button
			type="button"
			className="h-6 w-6 shrink-0 p-0! text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover/labelrow:opacity-100"
			aria-label="Edit battery part label"
			onClick={onStartEdit}
		>
			<PencilSquareIcon className="size-3.5" />
		</Button>
	</div>
);

type BatteryPartRowProps = {
	device: RegisteredDevice;
	b: BatteryInfo;
	isEditing: boolean;
	displayName: string;
	labelDraft: string;
	setLabelDraft: (v: string) => void;
	inputRef: RefObject<HTMLInputElement | null>;
	skipLabelCommitOnBlur: MutableRefObject<boolean>;
	onCommitPartLabel: (deviceId: string, userDescription: string | null, value: string) => void;
	setLabelEdit: React.Dispatch<React.SetStateAction<{ deviceId: string; partKey: string } | null>>;
	startLabelEdit: (device: RegisteredDevice, userDescription: string | null) => void;
	resetLabelAndCloseEdit: (deviceId: string, userDescription: string | null) => void;
};

const BatteryPartRow: React.FC<BatteryPartRowProps> = ({
	device,
	b,
	isEditing,
	displayName,
	labelDraft,
	setLabelDraft,
	inputRef,
	skipLabelCommitOnBlur,
	onCommitPartLabel,
	setLabelEdit,
	startLabelEdit,
	resetLabelAndCloseEdit,
}) => {
	const defaultTitle = defaultBatteryPartDisplayName(b.user_description);
	const testIdPart = b.user_description ?? "Central";

	const commitBlur = () => {
		if (skipLabelCommitOnBlur.current) {
			skipLabelCommitOnBlur.current = false;
			return;
		}
		onCommitPartLabel(device.id, b.user_description, labelDraft);
		setLabelEdit(null);
	};

	return (
		<div
			className="group/labelrow flex w-full min-w-0 flex-nowrap items-center gap-4"
			data-testid={`device-battery-row-${device.id}-${testIdPart}`}
		>
			<div className="box-border -mr-4 flex w-30 min-w-0 max-w-full shrink-0 flex-none items-center justify-start overflow-hidden">
				{isEditing ? (
					<PartLabelEdit
						value={labelDraft}
						onChange={setLabelDraft}
						onCommitBlur={commitBlur}
						onEnter={() => inputRef.current?.blur()}
						onEscape={() => {
							skipLabelCommitOnBlur.current = true;
							setLabelEdit(null);
						}}
						onReset={() => resetLabelAndCloseEdit(device.id, b.user_description)}
						inputRef={inputRef}
						skipLabelCommitOnBlur={skipLabelCommitOnBlur}
					/>
				) : (
					<PartLabelView
						displayName={displayName}
						defaultNameTitle={defaultTitle}
						onStartEdit={() => startLabelEdit(device, b.user_description)}
					/>
				)}
			</div>
			<BatteryIcon percentage={b.battery_level ?? 0} className="shrink-0" />
			<span
				className="w-10 min-w-10 shrink-0 text-card-foreground/90 text-right text-sm"
				data-testid={`device-battery-level-${device.id}-${testIdPart}`}
			>
				{b.battery_level !== null ? `${b.battery_level}%` : "N/A"}
			</span>
		</div>
	);
};

type OpenChartOverlayProps = {
	chartOpenId: string | null;
	devices: RegisteredDevice[];
	onClose: () => void;
};

const OpenChartOverlay: React.FC<OpenChartOverlayProps> = ({ chartOpenId, devices, onClose }) => {
	if (chartOpenId == null) return null;
	const chartDevice = devices.find((d) => d.id === chartOpenId);
	if (!chartDevice) return null;
	return <BatteryHistoryChart device={chartDevice} onClose={onClose} />;
};

const RegisteredDevicesPanel: React.FC<DeviceListProps> = ({
	registeredDevices,
	setRegisteredDevices,
	onRemoveDevice,
	onChartOpenChange,
}) => {
	const [menuOpen, setMenuOpen] = useState<string | null>(null);
	const [chartOpen, setChartOpen] = useState<string | null>(null);
	const [labelEdit, setLabelEdit] = useState<{
		deviceId: string;
		partKey: string;
	} | null>(null);
	const [labelDraft, setLabelDraft] = useState("");
	const labelInputRef = useRef<HTMLInputElement>(null);
	const skipLabelCommitOnBlur = useRef(false);

	useEffect(() => {
		if (labelEdit && labelInputRef.current) {
			labelInputRef.current.focus();
			labelInputRef.current.select();
		}
	}, [labelEdit]);

	const handleMenuClose = () => setMenuOpen(null);

	const handleToggleChart = (id: string) => {
		setChartOpen((prev) => {
			const next = prev === id ? null : id;
			onChartOpenChange?.(next !== null);
			return next;
		});
		setMenuOpen(null);
	};

	const commitPartLabel = (deviceId: string, userDescription: string | null, value: string) => {
		const partKey = batteryPartLabelStorageKey(userDescription);
		const defaultName = defaultBatteryPartDisplayName(userDescription);
		const trimmed = value.trim();
		setRegisteredDevices((prev) =>
			prev.map((d) => {
				if (d.id !== deviceId) {
					return d;
				}
				const nextLabels: Record<string, string> = { ...d.batteryPartLabels };
				if (trimmed === "" || trimmed === defaultName) {
					delete nextLabels[partKey];
				} else {
					nextLabels[partKey] = trimmed;
				}
				if (Object.keys(nextLabels).length === 0) {
					const { batteryPartLabels: _removed, ...rest } = d;
					return rest;
				}
				return { ...d, batteryPartLabels: nextLabels };
			}),
		);
	};

	const startLabelEdit = (device: RegisteredDevice, userDescription: string | null) => {
		const partKey = batteryPartLabelStorageKey(userDescription);
		setLabelDraft(getBatteryPartDisplayName(device.batteryPartLabels, userDescription));
		setLabelEdit({ deviceId: device.id, partKey });
	};

	const resetLabelAndCloseEdit = (deviceId: string, userDescription: string | null) => {
		const def = defaultBatteryPartDisplayName(userDescription);
		commitPartLabel(deviceId, userDescription, def);
		setLabelEdit(null);
	};

	const n = registeredDevices.length;

	return (
		<div className="max-w-3xl mx-auto rounded-xl overflow-hidden p-4 pt-2">
			{registeredDevices.map((device, deviceIdx) => (
				<div
					key={device.id}
					className={cn("relative group bg-card rounded-lg p-4", deviceIdx > 0 && "mt-4")}
				>
					<DeviceTopBar
						deviceIdx={deviceIdx}
						deviceCount={n}
						isMenuOpen={menuOpen === device.id}
						onChart={() => handleToggleChart(device.id)}
						onOpenMenu={() => setMenuOpen(device.id)}
						onMoveUp={() => {
							if (deviceIdx > 0) {
								setRegisteredDevices((prev) => {
									const arr = [...prev];
									[arr[deviceIdx - 1], arr[deviceIdx]] = [arr[deviceIdx], arr[deviceIdx - 1]];
									return arr;
								});
							}
							handleMenuClose();
						}}
						onMoveDown={() => {
							if (deviceIdx < n - 1) {
								setRegisteredDevices((prev) => {
									const arr = [...prev];
									[arr[deviceIdx + 1], arr[deviceIdx]] = [arr[deviceIdx], arr[deviceIdx + 1]];
									return arr;
								});
							}
							handleMenuClose();
						}}
						onRemove={async () => {
							if (onRemoveDevice) {
								await onRemoveDevice(device);
							} else {
								setRegisteredDevices((prev) => prev.filter((d) => d.id !== device.id));
							}
							handleMenuClose();
						}}
					/>

					{menuOpen === device.id && (
						<div className="fixed inset-0 z-0" onClick={handleMenuClose}></div>
					)}

					<div className="flex items-baseline gap-2 mb-2">
						<span
							className={`text-lg font-semibold truncate ${
								device.isDisconnected ? "max-w-45" : "max-w-60"
							}`}
						>
							{device.name}
						</span>
						{device.isDisconnected && (
							<span className="text-xs text-destructive">disconnected</span>
						)}
					</div>

					{device.batteryInfos.length === 0 ? (
						<div className="text-muted-foreground mx-auto">No battery information</div>
					) : (
						<div className="space-y-1 ml-7">
							{device.batteryInfos.map((b, batteryIndex) => {
								const partKey = batteryPartLabelStorageKey(b.user_description);
								const isEditing =
									labelEdit?.deviceId === device.id && labelEdit.partKey === partKey;
								return (
									<BatteryPartRow
										key={batteryIndex}
										device={device}
										b={b}
										isEditing={isEditing}
										displayName={getBatteryPartDisplayName(
											device.batteryPartLabels,
											b.user_description,
										)}
										labelDraft={labelDraft}
										setLabelDraft={setLabelDraft}
										inputRef={labelInputRef}
										skipLabelCommitOnBlur={skipLabelCommitOnBlur}
										onCommitPartLabel={commitPartLabel}
										setLabelEdit={setLabelEdit}
										startLabelEdit={startLabelEdit}
										resetLabelAndCloseEdit={resetLabelAndCloseEdit}
									/>
								);
							})}
						</div>
					)}
				</div>
			))}
			<OpenChartOverlay
				chartOpenId={chartOpen}
				devices={registeredDevices}
				onClose={() => {
					setChartOpen(null);
					onChartOpenChange?.(false);
				}}
			/>
		</div>
	);
};

export default RegisteredDevicesPanel;
