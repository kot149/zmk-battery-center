import type { DateRange } from "@/components/DateRangePicker";
import type { BatteryHistoryRecord } from "@/utils/batteryHistory";

// Unified row that Recharts consumes (timestamp + one key per part)
export type ChartRow = { timestamp: number } & Record<string, number | undefined>;

// ── Smoothing (time-based Gaussian-weighted moving average) ────────
/**
 * windowSizeMs: half-window in milliseconds. Points within this time radius
 * are included; Gaussian sigma = windowSizeMs / 2.
 */
export function smooth(records: BatteryHistoryRecord[], windowSizeMs: number): BatteryHistoryRecord[] {
	if (records.length <= 1) return records;
	const sigma = windowSizeMs / 2.0;
	const sigmaSq2 = 2 * sigma * sigma;
	// Pre-parse timestamps once
	const timestamps = records.map(r => new Date(r.timestamp).getTime());
	const result: BatteryHistoryRecord[] = [];
	for (let i = 0; i < records.length; i++) {
		const ti = timestamps[i];
		let sum = 0;
		let wsum = 0;
		// Walk backwards while within window
		for (let j = i; j >= 0; j--) {
			const dt = ti - timestamps[j];
			if (dt > windowSizeMs) break;
			const w = Math.exp(-(dt * dt) / sigmaSq2);
			sum += records[j].battery_level * w;
			wsum += w;
		}
		// Walk forwards while within window
		for (let j = i + 1; j < records.length; j++) {
			const dt = timestamps[j] - ti;
			if (dt > windowSizeMs) break;
			const w = Math.exp(-(dt * dt) / sigmaSq2);
			sum += records[j].battery_level * w;
			wsum += w;
		}
		result.push({ ...records[i], battery_level: Math.round(sum / wsum) });
	}
	return result;
}

// ── Helpers ────────────────────────────────────────────
export const MS_IN_DAY = 24 * 60 * 60 * 1000;

export function formatXTick(ts: number, rangeMs: number): string {
	const d = new Date(ts);
	if (rangeMs > 0 && rangeMs <= 2 * MS_IN_DAY) {
		// Short range → show time only
		return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	}
	// Longer range → show date
	return d.toLocaleDateString([], { month: "numeric", day: "numeric" });
}

export function findRowIndexAtOrBefore(rows: ChartRow[], target: number): number {
	let lo = 0, hi = rows.length - 1, ans = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (rows[mid].timestamp <= target) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
	}
	return ans;
}

export function formatTooltipLabel(ts: number): string {
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

export const NICE_STEPS = [
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
	36 * 60 * 60 * 1000,
	2 * 24 * 60 * 60 * 1000,
	3 * 24 * 60 * 60 * 1000,
	7 * 24 * 60 * 60 * 1000,
	14 * 24 * 60 * 60 * 1000,
	30 * 24 * 60 * 60 * 1000,
];

export const MIN_X_AXIS_TICKS = 5;
export const MAX_X_AXIS_TICKS = 7;

export function getTicksForStep(min: number, max: number, step: number): number[] {
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

export function getNiceTicks(
	min: number,
	max: number,
	maxTicks = MAX_X_AXIS_TICKS,
	minTicks = MIN_X_AXIS_TICKS,
): number[] {
	if (min >= max) return [min];
	const duration = max - min;
	const targetTickCount = Math.round((minTicks + maxTicks) / 2);
	const approxStep = duration / Math.max(targetTickCount - 1, 1);
	const candidates = NICE_STEPS.map((step) => ({
		step,
		ticks: getTicksForStep(min, max, step),
	}));

	const validCandidates = candidates.filter(
		(candidate) => candidate.ticks.length >= minTicks && candidate.ticks.length <= maxTicks,
	);

	if (validCandidates.length > 0) {
		return validCandidates.reduce((best, candidate) => {
			return Math.abs(candidate.step - approxStep) < Math.abs(best.step - approxStep)
				? candidate
				: best;
		}).ticks;
	}

	const fallback = candidates.reduce((best, candidate) => {
		const bestDistance = Math.abs(best.ticks.length - targetTickCount);
		const candidateDistance = Math.abs(candidate.ticks.length - targetTickCount);
		if (candidateDistance !== bestDistance) {
			return candidateDistance < bestDistance ? candidate : best;
		}
		return Math.abs(candidate.step - approxStep) < Math.abs(best.step - approxStep)
			? candidate
			: best;
	});

	return fallback.ticks;
}

export type XAxisDomain = [number, number] | [string, string];

export function getXAxisConfig({
	rangeMs,
	now,
	recordedData,
	customRange,
	maxTicks = MAX_X_AXIS_TICKS,
}: {
	rangeMs: number;
	now: number;
	recordedData: ChartRow[];
	customRange: DateRange | null;
	maxTicks?: number;
}): { xDomain: XAxisDomain; xTicks: number[] } {
	let min: number;
	let max: number;
	let xDomain: XAxisDomain;

	if (rangeMs === -1 && customRange) {
		min = customRange.start.getTime();
		max = customRange.end.getTime();
		xDomain = [min, max];
	} else if (rangeMs > 0) {
		min = now - rangeMs;
		max = now;
		xDomain = [min, max];
	} else if (recordedData.length >= 2) {
		min = recordedData[0].timestamp;
		max = recordedData[recordedData.length - 1].timestamp;
		xDomain = ["dataMin", "dataMax"];
	} else if (recordedData.length === 1) {
		min = recordedData[0].timestamp - (MS_IN_DAY / 2);
		max = recordedData[0].timestamp + (MS_IN_DAY / 2);
		xDomain = [min, max];
	} else {
		min = now - MS_IN_DAY;
		max = now;
		xDomain = [min, max];
	}

	return {
		xDomain,
		xTicks: getNiceTicks(min, max, maxTicks),
	};
}
