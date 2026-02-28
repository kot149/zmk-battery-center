import React, { useEffect, useState, useCallback, useMemo } from "react";
import {
	ResponsiveContainer,
	LineChart,
	Line,
	XAxis,
	YAxis,
	CartesianGrid,
	Tooltip,
	Legend,
} from "recharts";
import { readBatteryHistory, type BatteryHistoryRecord } from "@/utils/batteryHistory";
import type { RegisteredDevice } from "@/App";
import { ArrowPathIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { logger } from "@/utils/log";

// ── Types ──────────────────────────────────────────────
interface BatteryHistoryChartProps {
	device: RegisteredDevice;
	onClose: () => void;
}

type GroupedHistory = Map<string, BatteryHistoryRecord[]>;

// Unified row that Recharts consumes (timestamp + one key per part)
type ChartRow = { timestamp: number } & Record<string, number | undefined>;

// ── Constants ──────────────────────────────────────────
const LINE_COLORS = [
	"oklch(62.3% 0.214 259.815)",   // primary blue
	"oklch(0.696 0.17 162.48)",     // green
	"oklch(0.769 0.188 70.08)",     // yellow
	"oklch(0.627 0.265 303.9)",     // purple
	"oklch(0.645 0.246 16.439)",    // red
];

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

	/** X axis domain: fixed range for presets, auto for "All" */
	const xDomain = useMemo<[number, number] | [string, string]>(() => {
		if (rangeMs > 0) return [now - rangeMs, now];
		return ["dataMin", "dataMax"] as [string, string];
	}, [rangeMs, now]);

	// ── Render ─────────────────────────────────────────
	return (
		<div className="fixed inset-0 z-50 flex flex-col bg-background rounded-[10px] overflow-hidden">
			{/* Header */}
			<div className="flex items-center justify-between px-5 pt-4 pb-0">
				<div className="flex flex-col">
					<span className="text-2xl font-semibold text-foreground">
						{device.name}
					</span>
					<span className="text-sm text-muted-foreground tracking-wide">
						Battery History
					</span>
				</div>
				<div className="flex">
					<button
						onClick={load}
						className="w-10 h-10 rounded-lg flex items-center justify-center hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
						title="Reload"
					>
						<ArrowPathIcon className="size-5" />
					</button>
					<button
						onClick={onClose}
						className="w-10 h-10 rounded-lg flex items-center justify-center hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
						title="Close"
					>
						<XMarkIcon className="size-5" />
					</button>
				</div>
			</div>

			{/* Range selector */}
			<div className="flex items-center justify-end gap-2 px-4 pt-2">
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
							<CartesianGrid
								strokeDasharray="3 3"
								stroke="currentColor"
								strokeOpacity={0.08}
							/>
							<XAxis
								dataKey="timestamp"
								type="number"
								domain={xDomain}
								scale="time"
								tickFormatter={(ts: number) => formatXTick(ts, effectiveRange)}
								tick={{ fontSize: 11, fill: "currentColor", fillOpacity: 0.75 }}
								tickLine={false}
								axisLine={false}
								minTickGap={40}
							/>
							<YAxis
								domain={[0, 100]}
								ticks={[0, 25, 50, 75, 100]}
								tickFormatter={(v: number) => `${v}%`}
								tick={{ fontSize: 11, fill: "currentColor", fillOpacity: 0.75 }}
								tickLine={false}
								axisLine={false}
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
																backgroundColor: LINE_COLORS[i % LINE_COLORS.length],
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
								iconType="plainline"
								wrapperStyle={{ fontSize: "0.8rem", paddingTop: 4 }}
								formatter={(value) => <span style={{ color: "var(--foreground)" }}>{value}</span>}
							/>
							{allKeys.map((key, i) => (
								<Line
									key={key}
									type="monotone"
									dataKey={key}
									name={key}
									stroke={LINE_COLORS[i % LINE_COLORS.length]}
									strokeWidth={2}
									dot={{ r: 3, fill: LINE_COLORS[i % LINE_COLORS.length], strokeWidth: 0 }}
									activeDot={{ r: 5, stroke: "white", strokeWidth: 2, fill: LINE_COLORS[i % LINE_COLORS.length] }}
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
