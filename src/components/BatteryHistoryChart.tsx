import React, { useEffect, useState, useCallback, useMemo } from "react";
import {
	ResponsiveContainer,
	LineChart,
	Line,
	XAxis,
	YAxis,
	Tooltip,
	Legend,
	ReferenceLine,
} from "recharts";
import { readBatteryHistory, type BatteryHistoryRecord } from "@/utils/batteryHistory";
import type { RegisteredDevice } from "@/App";
import { ArrowPathIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { logger } from "@/utils/log";
import TopRightButtons from "@/components/TopRightButtons";

// ── Types ──────────────────────────────────────────────
interface BatteryHistoryChartProps {
	device: RegisteredDevice;
	onClose: () => void;
}

type GroupedHistory = Map<string, BatteryHistoryRecord[]>;

// Unified row that Recharts consumes (timestamp + one key per part)
type ChartRow = { timestamp: number } & Record<string, number | undefined>;

// ── Constants ──────────────────────────────────────────

/** Range presets – value is duration in ms */
const RANGE_PRESETS = [
	{ label: "1 day", ms: 1 * 24 * 60 * 60 * 1000 },
	{ label: "3 days", ms: 3 * 24 * 60 * 60 * 1000 },
	{ label: "1 week", ms: 7 * 24 * 60 * 60 * 1000 },
	{ label: "2 weeks", ms: 14 * 24 * 60 * 60 * 1000 },
	{ label: "1 month", ms: 30 * 24 * 60 * 60 * 1000 },
	{ label: "All", ms: 0 },
] as const;

// ── Smoothing (simple moving average) ──────────────────
function smooth(records: BatteryHistoryRecord[], windowSize = 3): BatteryHistoryRecord[] {
	if (records.length <= windowSize) return records;
	const result: BatteryHistoryRecord[] = [];
	const half = Math.floor(windowSize / 2);
	for (let i = 0; i < records.length; i++) {
		const start = Math.max(0, i - half);
		const end = Math.min(records.length - 1, i + half);
		let sum = 0;
		let count = 0;
		for (let j = start; j <= end; j++) {
			sum += records[j].battery_level;
			count++;
		}
		result.push({ ...records[i], battery_level: Math.round(sum / count) });
	}
	return result;
}

// ── Helpers ────────────────────────────────────────────
const MS_IN_DAY = 24 * 60 * 60 * 1000;

function formatXTick(ts: number, rangeMs: number): string {
	const d = new Date(ts);
	if (rangeMs > 0 && rangeMs <= 2 * MS_IN_DAY) {
		// Short range → show time only
		return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	}
	// Longer range → show date
	return d.toLocaleDateString([], { month: "numeric", day: "numeric" });
}

function formatTooltipLabel(ts: number): string {
	const d = new Date(ts);
	return d.toLocaleString([], {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

const NICE_STEPS = [
	5 * 60 * 1000,
	10 * 60 * 1000,
	15 * 60 * 1000,
	30 * 60 * 1000,
	1 * 60 * 60 * 1000,
	2 * 60 * 60 * 1000,
	3 * 60 * 60 * 1000,
	6 * 60 * 60 * 1000,
	12 * 60 * 60 * 1000,
	1 * 24 * 60 * 60 * 1000,
	2 * 24 * 60 * 60 * 1000,
	3 * 24 * 60 * 60 * 1000,
	7 * 24 * 60 * 60 * 1000,
	14 * 24 * 60 * 60 * 1000,
	30 * 24 * 60 * 60 * 1000,
];

function getNiceTicks(min: number, max: number, maxTicks = 12): number[] {
	if (min >= max) return [min];
	const duration = max - min;
	const approxStep = duration / maxTicks;
	
	let step = NICE_STEPS[NICE_STEPS.length - 1];
	for (const s of NICE_STEPS) {
		if (s >= approxStep) {
			step = s;
			break;
		}
	}

	const ticks = [];
	const d = new Date(min);
	
	if (step >= 24 * 60 * 60 * 1000) {
		d.setHours(0, 0, 0, 0);
	} else if (step >= 60 * 60 * 1000) {
		d.setMinutes(0, 0, 0);
		const hoursStep = step / (60 * 60 * 1000);
		if (hoursStep > 1) {
			d.setHours(Math.floor(d.getHours() / hoursStep) * hoursStep);
		}
	} else if (step >= 60 * 1000) {
		d.setSeconds(0, 0);
		const minutesStep = step / (60 * 1000);
		if (minutesStep > 1) {
			d.setMinutes(Math.floor(d.getMinutes() / minutesStep) * minutesStep);
		}
	} else {
		d.setMilliseconds(0);
	}

	let current = d.getTime();
	while (current < min) current += step;
	while (current <= max) {
		ticks.push(current);
		current += step;
	}
	
	return ticks;
}

// ── Component ──────────────────────────────────────────
const BatteryHistoryChart: React.FC<BatteryHistoryChartProps> = ({ device, onClose }) => {
	const [grouped, setGrouped] = useState<GroupedHistory>(new Map());
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [rangeIdx, setRangeIdx] = useState(RANGE_PRESETS.length - 1); // default: "All"

	// ── Data loading ───────────────────────────────────
	const load = useCallback(async () => {
		setIsLoading(true);
		setError(null);
		try {
			const records = await readBatteryHistory(device.name, device.id);
			const map = new Map<string, BatteryHistoryRecord[]>();
			for (const r of records) {
				if (r.battery_level === 0) continue; // Ignore 0%
				const key = r.user_description || "Central";
				if (!map.has(key)) map.set(key, []);
				map.get(key)!.push(r);
			}
			setGrouped(map);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			setError(msg);
			logger.warn(`Failed to load battery history: ${msg}`);
		} finally {
			setIsLoading(false);
		}
	}, [device.name, device.id]);

	useEffect(() => {
		load();
	}, [load]);

	// ── Derived data ───────────────────────────────────
	const allKeys = useMemo(() => [...grouped.keys()], [grouped]);

	const rangeMs = RANGE_PRESETS[rangeIdx].ms;

	/** Build a single sorted array of ChartRow for Recharts */
	const chartData = useMemo<ChartRow[]>(() => {
		const now = Date.now();
		const cutoff = rangeMs > 0 ? now - rangeMs : 0;

		// Collect every unique timestamp across all parts
		const tsMap = new Map<number, ChartRow>();

		for (const key of allKeys) {
			const raw = grouped.get(key) ?? [];
			const smoothed = smooth(raw, 5);
			for (const r of smoothed) {
				const ts = new Date(r.timestamp).getTime();
				if (ts < cutoff) continue;
				if (!tsMap.has(ts)) {
					tsMap.set(ts, { timestamp: ts });
				}
				tsMap.get(ts)![key] = Math.max(0, Math.min(100, r.battery_level));
			}
		}

		return [...tsMap.values()].sort((a, b) => a.timestamp - b.timestamp);
	}, [grouped, allKeys, rangeMs]);

	const now = useMemo(() => Date.now(), [chartData]); // eslint-disable-line react-hooks/exhaustive-deps

	const effectiveRange = useMemo<number>(() => {
		if (rangeMs > 0) return rangeMs;
		if (chartData.length < 2) return MS_IN_DAY;
		return chartData[chartData.length - 1].timestamp - chartData[0].timestamp;
	}, [chartData, rangeMs]);

	/** X axis domain and explicit ticks */
	const { xDomain, xTicks } = useMemo(() => {
		let min: number;
		let max: number;
		let domain: [number, number] | [string, string];

		if (rangeMs > 0) {
			min = now - rangeMs;
			max = now;
			domain = [min, max];
		} else {
			if (chartData.length >= 2) {
				min = chartData[0].timestamp;
				max = chartData[chartData.length - 1].timestamp;
				domain = ["dataMin", "dataMax"];
			} else if (chartData.length === 1) {
				min = chartData[0].timestamp - (MS_IN_DAY / 2);
				max = chartData[0].timestamp + (MS_IN_DAY / 2);
				domain = [min, max];
			} else {
				min = now - MS_IN_DAY;
				max = now;
				domain = [min, max];
			}
		}
		
		const ticks = getNiceTicks(min, max, 12);
		return { xDomain: domain, xTicks: ticks };
	}, [rangeMs, now, chartData]);

	// ── Render ─────────────────────────────────────────
	return (
		<div className="fixed inset-0 z-50 flex flex-col bg-background rounded-[10px] overflow-hidden">
			{/* Top-right absolute buttons */}
			<div className="absolute top-2 right-2 z-50">
				<TopRightButtons
					buttons={[
						{
							icon: <ArrowPathIcon className="size-5" />,
							onClick: load,
							ariaLabel: "Reload",
						},
						{
							icon: <XMarkIcon className="size-5" />,
							onClick: onClose,
							ariaLabel: "Close",
						}
					]}
				/>
			</div>

			{/* Header and Range selector – each independently positioned via pt/pb */}
			<div className="relative px-5">
				{/* Title */}
				<div className="flex flex-col pt-4 pb-0">
					<span className="text-2xl font-semibold text-foreground">
						{device.name}
					</span>
					<span className="text-sm text-muted-foreground tracking-wide">
						Battery History
					</span>
				</div>

				{/* Range selector */}
				<div className="absolute top-12 right-5 flex items-center gap-2 pb-0">
					<span className="text-sm text-muted-foreground">Range:</span>
					<Select
						value={String(rangeIdx)}
						onValueChange={(v) => setRangeIdx(Number(v))}
					>
						<SelectTrigger size="sm">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{RANGE_PRESETS.map((preset, idx) => (
								<SelectItem key={preset.label} value={String(idx)}>
									{preset.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</div>


			{/* Chart area */}
			<div className="flex-1 flex flex-col p-4 min-h-0">
				{isLoading ? (
					<div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
						Loading...
					</div>
				) : error ? (
					<div className="flex-1 flex items-center justify-center text-xs text-destructive">
						{error}
					</div>
				) : chartData.length === 0 ? (
					<div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
						No history recorded yet
					</div>
				) : (
					<ResponsiveContainer width="100%" height="100%">
						<LineChart
							data={chartData}
							margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
						>
							{/* Internal grid lines (excluding top/right boundaries) */}
							{[25, 50, 75].map((y) => (
								<ReferenceLine
									key={y}
									y={y}
									stroke="currentColor"
									strokeOpacity={0.15}
								/>
							))}
							{xTicks.map((tick) => (
								<ReferenceLine
									key={tick}
									x={tick}
									stroke="currentColor"
									strokeOpacity={0.15}
								/>
							))}
							<XAxis
								dataKey="timestamp"
								type="number"
								domain={xDomain}
								scale="time"
								ticks={xTicks}
								tickFormatter={(ts: number) => formatXTick(ts, effectiveRange)}
								tick={{ fontSize: 11, fill: "currentColor", fillOpacity: 0.9 }}
								tickLine={false}
								axisLine={{ stroke: "currentColor", strokeOpacity: 0.5 }}
								minTickGap={20}
							/>
							<YAxis
								domain={[0, 100]}
								ticks={[0, 25, 50, 75, 100]}
								tickFormatter={(v: number) => `${v}%`}
								tick={{ fontSize: 11, fill: "currentColor", fillOpacity: 0.9 }}
								tickLine={false}
								axisLine={{ stroke: "currentColor", strokeOpacity: 0.5 }}
								width={42}
							/>
							<Tooltip
								content={({ active, payload, label }) => {
									if (!active && (!payload || payload.length === 0)) return null;
									// Find the row matching the current label to show all parts
									const rowIdx = chartData.findIndex((r) => r.timestamp === label);
									const row = rowIdx >= 0 ? chartData[rowIdx] : undefined;

									// For each key, find the last known value if the current row doesn't have it
									const resolveValue = (key: string): number | undefined => {
										if (row?.[key] != null) return row[key] as number;
										// Walk backwards through chartData to find the most recent value
										for (let j = (rowIdx >= 0 ? rowIdx : chartData.length) - 1; j >= 0; j--) {
											if (chartData[j][key] != null) return chartData[j][key] as number;
										}
										return undefined;
									};

									return (
										<div
											style={{
												backgroundColor: "var(--popover)",
												color: "var(--popover-foreground)",
												border: "1px solid var(--border)",
												borderRadius: "0.5rem",
												padding: "8px 12px",
												fontSize: "0.8rem",
											}}
										>
											<div style={{ fontWeight: 600, marginBottom: 4 }}>
												{formatTooltipLabel(label as number)}
											</div>
											{allKeys.map((key, i) => {
												const val = resolveValue(key);
												const isInterpolated = row?.[key] == null && val != null;
												return (
													<div key={key} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
														<span
															style={{
																display: "inline-block",
																width: 10,
																height: 10,
																borderRadius: "50%",
																backgroundColor: `var(--chart-${(i % 5) + 1})`,
															}}
														/>
														<span style={{ opacity: isInterpolated ? 0.5 : 1 }}>
															{key}: {val != null ? `${val}%` : "—"}
														</span>
													</div>
												);
											})}
										</div>
									);
								}}
							/>
							<Legend
								content={(props) => {
									const { payload } = props;
									const count = payload?.length || 0;
									let layoutClass = "flex justify-center";
									let gridCols = undefined;
									if (count === 2 || count === 4) {
										layoutClass = "grid";
										gridCols = "auto auto";
									} else if (count >= 3) {
										layoutClass = "grid";
										gridCols = "auto auto auto";
									}

									return (
										<div className={`${layoutClass} gap-x-6 gap-y-2 pt-1 w-fit mx-auto`} style={{ fontSize: "0.8rem", gridTemplateColumns: gridCols }}>
											{payload?.map((entry, index) => (
												<div key={`item-${index}`} className="flex items-center gap-1.5">
													<div
														style={{
															minWidth: 20,
															height: 4,
															backgroundColor: entry.color,
															borderRadius: 2,
														}}
													/>
													<span className="truncate" style={{ color: "var(--foreground)" }}>{entry.value}</span>
												</div>
											))}
										</div>
									);
								}}
							/>
							{allKeys.map((key, i) => (
								<Line
									key={key}
									type="monotone"
									dataKey={key}
									name={key}
									stroke={`var(--chart-${(i % 5) + 1})`}
									strokeWidth={2}
									dot={{ r: 3, fill: `var(--chart-${(i % 5) + 1})`, strokeWidth: 0 }}
									activeDot={{ r: 5, stroke: "var(--foreground)", strokeWidth: 2, fill: `var(--chart-${(i % 5) + 1})` }}
									connectNulls
									isAnimationActive={false}
								/>
							))}
						</LineChart>
					</ResponsiveContainer>
				)}
			</div>
		</div>
	);
};

export default BatteryHistoryChart;
