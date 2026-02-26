import React, { useEffect, useState, useCallback } from "react";
import { readBatteryHistory, type BatteryHistoryRecord } from "@/utils/batteryHistory";
import type { RegisteredDevice } from "@/App";
import { ArrowPathIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { logger } from "@/utils/log";

interface BatteryHistoryChartProps {
	device: RegisteredDevice;
	onClose: () => void;
}

// Assign colors to graphs for each user description
const LINE_COLORS = [
	"oklch(62.3% 0.214 259.815)",   // primary blue
	"oklch(0.696 0.17 162.48)",     // green
	"oklch(0.769 0.188 70.08)",     // yellow
	"oklch(0.627 0.265 303.9)",     // purple
	"oklch(0.645 0.246 16.439)",    // red
];

type GroupedHistory = Map<string, BatteryHistoryRecord[]>;

const CHART_W = 600;
const CHART_H = 300;
const PAD_LEFT = 36;
const PAD_RIGHT = 16;
const PAD_TOP = 16;
const PAD_BOTTOM = 32;
const W = CHART_W - PAD_LEFT - PAD_RIGHT;
const H = CHART_H - PAD_TOP - PAD_BOTTOM;

function formatTime(iso: string): string {
	const d = new Date(iso);
	return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDate(iso: string): string {
	const d = new Date(iso);
	return d.toLocaleDateString([], { month: "numeric", day: "numeric" });
}

/** 表示する最新N件 */
const MAX_POINTS = 60;

/** data点をSVGのパス文字列に変換 */
function toPolyline(points: { x: number; y: number }[]): string {
	if (points.length === 0) return "";
	return points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
}

const BatteryHistoryChart: React.FC<BatteryHistoryChartProps> = ({ device, onClose }) => {
	const [grouped, setGrouped] = useState<GroupedHistory>(new Map());
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setIsLoading(true);
		setError(null);
		try {
			const records = await readBatteryHistory(device.name, device.id);
			const map = new Map<string, BatteryHistoryRecord[]>();
			for (const r of records) {
				// Ignore 0% records
				if (r.battery_level === 0) continue;
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

	const allKeys = [...grouped.keys()];

	// Get all records and find the time range
	const allRecords = allKeys.flatMap(k => grouped.get(k)!.slice(-MAX_POINTS));
	const allTimes = allRecords.map(r => new Date(r.timestamp).getTime());
	const minTime = allTimes.length > 0 ? Math.min(...allTimes) : 0;
	const maxTime = allTimes.length > 0 ? Math.max(...allTimes) : 1;
	const timeRange = maxTime - minTime || 1;

	// X axis labels (5 points)
	const labelCount = 5;
	const xLabels: { x: number; label: string; date: string }[] = [];
	if (allTimes.length > 0) {
		for (let i = 0; i < labelCount; i++) {
			const t = minTime + (timeRange * i) / (labelCount - 1);
			const x = PAD_LEFT + ((t - minTime) / timeRange) * W;
			const iso = new Date(t).toISOString();
			xLabels.push({ x, label: formatTime(iso), date: formatDate(iso) });
		}
	}

	return (
		<div className="fixed inset-0 z-50 flex flex-col bg-background">
			{/* Header */}
			<div className="flex items-center justify-between p-2 pb-0">
				<div className="flex flex-col">
					<span className="text-lg font-semibold text-foreground">
						{device.name}
					</span>
					<span className="text-sm text-muted-foreground tracking-wide uppercase">
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

			{/* Chart area - fills remaining space */}
			<div className="flex-1 flex flex-col p-4 min-h-0">
				{isLoading ? (
					<div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
						Loading...
					</div>
				) : error ? (
					<div className="flex-1 flex items-center justify-center text-xs text-destructive">
						{error}
					</div>
				) : allRecords.length === 0 ? (
					<div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
						No history recorded yet
					</div>
				) : (
					<>
						{/* Legend */}
						{allKeys.length > 1 && (
							<div className="flex flex-wrap gap-x-3 gap-y-1 mb-3">
								{allKeys.map((key, i) => (
									<div key={key} className="flex items-center gap-1">
										<span
											className="inline-block w-5 h-1 rounded"
											style={{ backgroundColor: LINE_COLORS[i % LINE_COLORS.length] }}
										/>
										<span className="text-sm text-muted-foreground">{key}</span>
									</div>
								))}
							</div>
						)}

						{/* Chart - fills available space */}
						<svg
							className="flex-1 overflow-visible min-h-0"
							viewBox={`0 0 ${CHART_W} ${CHART_H}`}
							preserveAspectRatio="xMidYMid meet"
						>
							{/* Y grid lines: 0, 25, 50, 75, 100 */}
							{[0, 25, 50, 75, 100].map(pct => {
								const y = PAD_TOP + H - (pct / 100) * H;
								return (
									<g key={pct}>
										<line
											x1={PAD_LEFT} y1={y} x2={PAD_LEFT + W} y2={y}
											stroke="currentColor"
											strokeOpacity={pct === 0 || pct === 100 ? 0.25 : 0.1}
											strokeWidth={1}
										/>
										<text
											x={PAD_LEFT - 4}
											y={y + 4.5}
											textAnchor="end"
											fontSize={10}
											fill="currentColor"
											opacity={0.5}
										>
											{pct}
										</text>
									</g>
								);
							})}

							{/* X axis */}
							<line
								x1={PAD_LEFT} y1={PAD_TOP + H} x2={PAD_LEFT + W} y2={PAD_TOP + H}
								stroke="currentColor" strokeOpacity={0.2} strokeWidth={1}
							/>

							{/* X axis labels */}
							{xLabels.map((l, i) => (
								<g key={i}>
									<text
										x={l.x}
										y={CHART_H - 8}
										textAnchor="middle"
										fontSize={9}
										fill="currentColor"
										opacity={0.45}
									>
										{l.label}
									</text>
									<text
										x={l.x}
										y={CHART_H}
										textAnchor="middle"
										fontSize={8}
										fill="currentColor"
										opacity={0.35}
									>
										{l.date}
									</text>
								</g>
							))}

							{/* Lines per description */}
							{allKeys.map((key, colorIdx) => {
								const records = (grouped.get(key) ?? []).slice(-MAX_POINTS);
								const points = records.map(r => ({
									x: PAD_LEFT + ((new Date(r.timestamp).getTime() - minTime) / timeRange) * W,
									y: PAD_TOP + H - (Math.max(0, Math.min(100, r.battery_level)) / 100) * H,
								}));
								const color = LINE_COLORS[colorIdx % LINE_COLORS.length];
								const pathD = toPolyline(points);

								return (
									<g key={key}>
										{/* Gradient fill under line */}
										<defs>
											<linearGradient id={`grad-${device.id}-${colorIdx}`} x1="0" y1="0" x2="0" y2="1">
												<stop offset="0%" stopColor={color} stopOpacity="0.25" />
												<stop offset="100%" stopColor={color} stopOpacity="0" />
											</linearGradient>
										</defs>
										{points.length > 1 && (
											<path
												d={`${pathD} L ${points[points.length - 1].x.toFixed(1)} ${(PAD_TOP + H).toFixed(1)} L ${points[0].x.toFixed(1)} ${(PAD_TOP + H).toFixed(1)} Z`}
												fill={`url(#grad-${device.id}-${colorIdx})`}
											/>
										)}
										<path
											d={pathD}
											fill="none"
											stroke={color}
											strokeWidth={2}
											strokeLinejoin="round"
											strokeLinecap="round"
										/>
										{/* Latest dot */}
										{points.length > 0 && (
											<circle
												cx={points[points.length - 1].x}
												cy={points[points.length - 1].y}
												r={4}
												fill={color}
											/>
										)}
									</g>
								);
							})}
						</svg>
					</>
				)}
			</div>
		</div>
	);
};

export default BatteryHistoryChart;
