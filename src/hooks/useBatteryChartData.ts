import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { RegisteredDevice } from "@/utils/appHelpers";
import { logger } from "@/utils/log";
import { readBatteryHistory, type BatteryHistoryRecord } from "@/utils/batteryHistory";
import { smooth, type ChartRow } from "@/utils/batteryChartMath";
import type { DateRange } from "@/components/DateRangePicker";

type GroupedHistory = Map<string, BatteryHistoryRecord[]>;

export function useBatteryChartData(options: {
	device: RegisteredDevice;
	rangeMs: number;
	customRange: DateRange | null;
	smoothingWindow: number;
}): {
	recordedData: ChartRow[];
	allKeys: string[];
	isLoading: boolean;
	error: string | null;
	hasHistory: boolean;
} {
	const { device, rangeMs, customRange, smoothingWindow } = options;
	const [grouped, setGrouped] = useState<GroupedHistory>(new Map());
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setIsLoading(true);
		setError(null);
		try {
			// Fetch only the visible range plus the smoothing margin, so edge
			// points still have earlier context to smooth against.
			let sinceForFetch: string | undefined;
			if (rangeMs > 0) {
				sinceForFetch = new Date(Date.now() - rangeMs - smoothingWindow).toISOString();
			} else if (rangeMs === -1 && customRange) {
				sinceForFetch = new Date(customRange.start.getTime() - smoothingWindow).toISOString();
			}
			const records = await readBatteryHistory(device.name, device.id, sinceForFetch);
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
	}, [device.name, device.id, rangeMs, customRange, smoothingWindow]);

	useEffect(() => {
		load();
	}, [load]);

	// Apply new readings incrementally; fall back to a full reload for
	// events that don't carry the appended records.
	useEffect(() => {
		const unlistenPromise = listen<{ deviceId: string; records?: BatteryHistoryRecord[] }>(
			"battery-history-updated",
			(event) => {
				if (event.payload.deviceId !== device.id) return;
				const records = event.payload.records;
				if (Array.isArray(records) && records.length > 0) {
					setGrouped(prev => {
						const next = new Map(prev);
						for (const r of records) {
							if (r.battery_level === 0) continue; // match load()'s 0% skip
							const key = r.user_description || "Central";
							next.set(key, [...(next.get(key) ?? []), r]);
						}
						return next;
					});
				} else {
					load();
				}
			},
		);
		return () => {
			unlistenPromise.then(unlisten => unlisten());
		};
	}, [device.id, load]);

	// ── Derived data ───────────────────────────────────
	const allKeys = useMemo(() => [...grouped.keys()], [grouped]);

	const smoothedByKey = useMemo<Map<string, BatteryHistoryRecord[]>>(() => {
		const out = new Map<string, BatteryHistoryRecord[]>();
		for (const key of allKeys) {
			const raw = grouped.get(key) ?? [];
			out.set(key, smoothingWindow > 0 ? smooth(raw, smoothingWindow) : raw);
		}
		return out;
	}, [grouped, allKeys, smoothingWindow]);

	const recordedData = useMemo<ChartRow[]>(() => {
		const now = Date.now();
		let cutoff: number;
		let ceiling: number | undefined;

		if (rangeMs === -1 && customRange) {
			cutoff = customRange.start.getTime();
			ceiling = customRange.end.getTime();
		} else if (rangeMs > 0) {
			cutoff = now - rangeMs;
			ceiling = undefined;
		} else {
			cutoff = 0;
			ceiling = undefined;
		}

		const tsMap = new Map<number, ChartRow>();

		for (const key of allKeys) {
			const smoothed = smoothedByKey.get(key) ?? [];
			for (const r of smoothed) {
				const ts = new Date(r.timestamp).getTime();
				if (ts < cutoff) continue;
				if (ceiling != null && ts > ceiling) continue;
				if (!tsMap.has(ts)) {
					tsMap.set(ts, { timestamp: ts });
				}
				tsMap.get(ts)![key] = Math.max(0, Math.min(100, r.battery_level));
			}
		}

		return [...tsMap.values()].sort((a, b) => a.timestamp - b.timestamp);
	}, [smoothedByKey, allKeys, rangeMs, customRange]);

	return {
		recordedData,
		allKeys,
		isLoading,
		error,
		hasHistory: grouped.size > 0,
	};
}
