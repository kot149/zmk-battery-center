import React, { useCallback, useEffect, useRef, useState } from "react";
import { XMarkIcon, AdjustmentsHorizontalIcon } from "@heroicons/react/24/outline";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import TopRightButtons from "@/components/TopRightButtons";

type RangePreset = {
	label: string;
	ms: number;
};

interface ChartSettingsPanelProps {
	rangeMs: number;
	setRangeMs: (ms: number) => void;
	rangePresets: readonly RangePreset[];
	customRangeMs: number;
	onCustomRange: () => void;
	smoothingWindow: number;
	setSmoothingWindow: (window: number) => void;
	onClose: () => void;
}

// ── Smoothing options (window radius in ms) ───────────
const SMOOTHING_OPTIONS = [
	{ label: "Off",    value: 0 },
	{ label: "5 min",  value: 5 * 60 * 1000 },
	{ label: "15 min", value: 15 * 60 * 1000 },
	{ label: "30 min", value: 30 * 60 * 1000 },
	{ label: "60 min", value: 60 * 60 * 1000 },
	{ label: "180 min", value: 180 * 60 * 1000 },
] as const;

const ChartSettingsPanel: React.FC<ChartSettingsPanelProps> = ({
	rangeMs,
	setRangeMs,
	rangePresets,
	customRangeMs,
	onCustomRange,
	smoothingWindow,
	setSmoothingWindow,
	onClose,
}) => {
	const [showSettings, setShowSettings] = useState(false);
	const settingsPanelRef = useRef<HTMLDivElement>(null);
	const settingsButtonRef = useRef<HTMLDivElement>(null);

	// Lock clicks briefly after closing a Select to prevent the collapse click from reaching the panel
	const isClickLocked = useRef(false);

	// Close settings panel when clicking outside
	useEffect(() => {
		if (!showSettings) return;
		const handler = (e: MouseEvent) => {
			if (isClickLocked.current) return;
			const target = e.target as Element;
			// Ignore clicks inside Radix UI portals (Select dropdown, etc.)
			if (target.closest?.("[data-radix-popper-content-wrapper]")) return;
			if (settingsPanelRef.current?.contains(target)) return;
			if (settingsButtonRef.current?.contains(target)) return;
			setShowSettings(false);
		};
		// Use setTimeout to ensure the lock prevents immediate event bubbling
		const id = setTimeout(() => {
			document.addEventListener("mousedown", handler);
		}, 0);
		return () => {
			clearTimeout(id);
			document.removeEventListener("mousedown", handler);
		};
	}, [showSettings]);

	const handleSelectOpenChange = useCallback((open: boolean) => {
		if (open) {
			isClickLocked.current = true;
		} else {
			// Keep locked for a tiny bit longer to absorb the dismiss click
			setTimeout(() => {
				isClickLocked.current = false;
			}, 100);
		}
	}, []);

	return (
		<>
			<div ref={settingsButtonRef} className="absolute top-2 right-2 z-50">
				<TopRightButtons
					buttons={[
						{
							icon: <AdjustmentsHorizontalIcon className="size-5" />,
							onClick: () => setShowSettings((s) => !s),
							ariaLabel: "Chart settings",
						},
						{
							icon: <XMarkIcon className="size-5" />,
							onClick: onClose,
							ariaLabel: "Close",
						}
					]}
				/>
			</div>

			{showSettings && (
				<div
					ref={settingsPanelRef}
					className="absolute top-2 right-[88px] z-50 flex flex-col gap-2 rounded-lg border border-border bg-popover p-3 shadow-lg"
				>
					{/* Range row */}
					<div className="flex items-center gap-2">
						<span className="text-sm text-muted-foreground w-20 text-right">Range:</span>
						<Select
							value={String(rangeMs)}
							onOpenChange={handleSelectOpenChange}
							onValueChange={(v) => {
								const ms = Number(v);
								setRangeMs(ms);
								if (ms === customRangeMs) {
									onCustomRange();
								}
							}}
						>
							<SelectTrigger size="sm" className="min-w-20">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{rangePresets.map((preset) => (
									<SelectItem
										key={preset.label}
										value={String(preset.ms)}
										onPointerUp={() => {
											// onValueChange won't fire when re-selecting the same value,
											// so handle re-selecting Custom here
											if (preset.ms === customRangeMs && rangeMs === customRangeMs) {
												onCustomRange();
											}
										}}
									>
										{preset.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					{/* Smoothing row */}
					<div className="flex items-center gap-2">
						<span className="text-sm text-muted-foreground w-20 text-right">Smoothing:</span>
						<Select
							value={String(smoothingWindow)}
							onOpenChange={handleSelectOpenChange}
							onValueChange={(v) => setSmoothingWindow(Number(v))}
						>
							<SelectTrigger size="sm" className="min-w-20">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{SMOOTHING_OPTIONS.map((opt) => (
									<SelectItem key={opt.label} value={String(opt.value)}>
										{opt.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				</div>
			)}
		</>
	);
};

export default ChartSettingsPanel;
