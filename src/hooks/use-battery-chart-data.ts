import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { RegisteredDevice } from "@/utils/app-helpers";
import { logger } from "@/utils/log";
import {
  readBatteryHistorySnapshot,
  type BatteryHistoryEvent,
  type BatteryHistoryRecord,
  type BatteryHistorySnapshot,
} from "@/utils/battery-history";
import { smooth, type ChartRow } from "@/utils/battery-chart-math";
import type { DateRange } from "@/components/date-range-picker";

type GroupedHistory = Map<string, BatteryHistoryRecord[]>;
type SequencedRecord = BatteryHistoryRecord & { sequence: string; epoch: string };

function compareSequence(left: string, right: string): number {
  const a = left.replace(/^0+(?=\d)/, "");
  const b = right.replace(/^0+(?=\d)/, "");
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

function groupRecords(records: BatteryHistoryRecord[]): GroupedHistory {
  const grouped = new Map<string, BatteryHistoryRecord[]>();
  for (const record of records) {
    if (record.battery_level === 0) continue;
    const key = record.user_description || "Central";
    const part = grouped.get(key) ?? [];
    part.push(record);
    grouped.set(key, part);
  }
  return grouped;
}

export function retainHistoryForChart(
  records: BatteryHistoryRecord[],
  rangeMs: number,
  customRange: DateRange | null,
  smoothingWindow: number,
  now: number,
): BatteryHistoryRecord[] {
  if (rangeMs === 0 || (rangeMs === -1 && !customRange)) return records;
  const margin = Math.max(0, smoothingWindow);
  const start =
    rangeMs === -1 && customRange ? customRange.start.getTime() - margin : now - rangeMs - margin;
  const end = rangeMs === -1 && customRange ? customRange.end.getTime() + margin : Infinity;
  return records.filter((record) => {
    const timestamp = new Date(record.timestamp).getTime();
    return timestamp >= start && timestamp <= end;
  });
}

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
  const loadGeneration = useRef(0);
  const [readyDevice, setReadyDevice] = useState<string | null>(null);
  const boundary = useRef<{ epoch: string; throughSequence: string } | null>(null);
  const pending = useRef(new Map<string, SequencedRecord>());
  const loading = useRef(false);
  const refreshNeeded = useRef(false);
  const rangeRef = useRef({ rangeMs, customRange, smoothingWindow });
  rangeRef.current = { rangeMs, customRange, smoothingWindow };

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    loading.current = true;
    setIsLoading(true);
    setError(null);
    try {
      let sinceForFetch: string | undefined;
      if (rangeMs > 0) {
        sinceForFetch = new Date(Date.now() - rangeMs - smoothingWindow).toISOString();
      } else if (rangeMs === -1 && customRange) {
        sinceForFetch = new Date(customRange.start.getTime() - smoothingWindow).toISOString();
      }
      const snapshot: BatteryHistorySnapshot = await readBatteryHistorySnapshot(
        device.name,
        device.id,
        sinceForFetch,
      );
      if (generation !== loadGeneration.current) return;
      boundary.current = { epoch: snapshot.epoch, throughSequence: snapshot.throughSequence };
      for (const [key, record] of pending.current) {
        if (
          record.epoch !== snapshot.epoch ||
          compareSequence(record.sequence, snapshot.throughSequence) <= 0
        ) {
          pending.current.delete(key);
        }
      }
      const later = [...pending.current.values()].sort((a, b) =>
        compareSequence(a.sequence, b.sequence),
      );
      const records = [...snapshot.records, ...later];
      records.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
      setGrouped(
        groupRecords(
          retainHistoryForChart(records, rangeMs, customRange, smoothingWindow, Date.now()),
        ),
      );
    } catch (e) {
      if (generation !== loadGeneration.current) return;
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      logger.warn("Failed to load battery history", e);
    } finally {
      if (generation === loadGeneration.current) {
        loading.current = false;
        setIsLoading(false);
        if (refreshNeeded.current) {
          refreshNeeded.current = false;
          queueMicrotask(() => void loadRef.current());
        }
      }
    }
  }, [device.name, device.id, rangeMs, customRange, smoothingWindow]);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (readyDevice === device.id) void load();
    return () => {
      loadGeneration.current += 1;
    };
  }, [load, readyDevice, device.id]);

  useEffect(() => {
    let active = true;
    let unlistenHistory: (() => void) | undefined;
    let unlistenShown: (() => void) | undefined;
    loadGeneration.current += 1;
    boundary.current = null;
    pending.current.clear();
    loading.current = false;
    refreshNeeded.current = false;
    setGrouped(new Map());
    setReadyDevice(null);

    const refresh = () => {
      if (loading.current) refreshNeeded.current = true;
      else void loadRef.current();
    };
    const onHistory = (event: { payload: BatteryHistoryEvent }) => {
      const payload = event.payload;
      if (!active || payload.deviceId !== device.id) return;
      const records = payload.records;
      if (
        !payload.epoch ||
        !Array.isArray(records) ||
        records.length === 0 ||
        records.some(
          (record) => typeof record.sequence !== "string" || !/^\d+$/.test(record.sequence),
        )
      ) {
        refresh();
        return;
      }
      if (boundary.current && boundary.current.epoch !== payload.epoch) {
        refresh();
        return;
      }
      const accepted: SequencedRecord[] = [];
      for (const record of records) {
        const sequence = record.sequence as string;
        const key = `${payload.epoch}:${sequence}`;
        if (
          (boundary.current && compareSequence(sequence, boundary.current.throughSequence) <= 0) ||
          pending.current.has(key)
        )
          continue;
        const received = { ...record, sequence, epoch: payload.epoch };
        pending.current.set(key, received);
        accepted.push(received);
      }
      if (boundary.current && accepted.length > 0) {
        setGrouped((previous) => {
          const all = [...previous.values()].flat().concat(accepted);
          all.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
          return groupRecords(
            retainHistoryForChart(
              all,
              rangeRef.current.rangeMs,
              rangeRef.current.customRange,
              rangeRef.current.smoothingWindow,
              Date.now(),
            ),
          );
        });
      }
    };
    void (async () => {
      try {
        unlistenHistory = await listen<BatteryHistoryEvent>("battery-history-updated", onHistory);
        if (!active) {
          unlistenHistory();
          return;
        }
        unlistenShown = await listen("main-window-shown", () => void loadRef.current());
        if (!active) {
          unlistenHistory();
          unlistenShown();
          return;
        }
        setReadyDevice(device.id);
      } catch (cause) {
        unlistenHistory?.();
        if (active) {
          const message = cause instanceof Error ? cause.message : String(cause);
          setError(message);
          setIsLoading(false);
          logger.warn(`Failed to listen for battery history: ${message}`);
        }
      }
    })();
    return () => {
      active = false;
      loadGeneration.current += 1;
      unlistenHistory?.();
      unlistenShown?.();
    };
  }, [device.id]);

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
