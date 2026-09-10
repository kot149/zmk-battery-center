import type { BatteryInfo } from "./ble";

export type RegisteredDevice = {
  id: string;
  /** Advertised BLE name; kept for history storage keys and device identity. */
  name: string;
  /** Optional user-defined label; falls back to {@link name} for display and notifications. */
  displayName?: string;
  batteryInfos: BatteryInfo[];
  isDisconnected: boolean;
  isCollapsed: boolean;
  connectionStatusKnown?: boolean;
  connectionObservedAtUnixMs?: number | null;
  /** Custom display names per part; keys match battery history user_description (null → "Central"). */
  batteryPartLabels?: Record<string, string>;
};

export function isValidBatteryLevel(level: unknown): level is number {
  return typeof level === "number" && Number.isInteger(level) && level >= 0 && level <= 100;
}

export function annotateBatteryInfosFromRead(infos: BatteryInfo[], now: number): BatteryInfo[] {
  return infos.map((info) =>
    isValidBatteryLevel(info.battery_level)
      ? {
          ...info,
          battery_level: info.battery_level,
          observed_at_unix_ms: now,
          last_read_succeeded: true,
        }
      : {
          ...info,
          battery_level: null,
          observed_at_unix_ms: null,
          last_read_succeeded: false,
        },
  );
}

export function markBatteryInfosReadFailed(infos: BatteryInfo[]): BatteryInfo[] {
  return infos.map((info) => ({ ...info, last_read_succeeded: false }));
}

function normalizeBatteryPartLabels(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "string" && v.trim() !== "") {
      out[k] = v.trim();
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeDeviceDisplayName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  return t !== "" ? t : undefined;
}

function normalizeObservedTimestamp(raw: unknown): number | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : null;
}

export function getRegisteredDeviceDisplayName(device: {
  name: string;
  displayName?: string | null;
}): string {
  const custom = device.displayName?.trim();
  return custom && custom !== "" ? custom : device.name;
}

const DEVICE_ID_PATTERN = /^DeviceId\("(.+)"\)$/;

export function mapIsLowBattery(batteryInfos: BatteryInfo[], threshold: number) {
  return batteryInfos.map((info) =>
    info.battery_level !== null ? info.battery_level <= threshold : false,
  );
}

export function mapIsHighBattery(batteryInfos: BatteryInfo[], threshold: number) {
  return batteryInfos.map((info) =>
    info.battery_level !== null ? info.battery_level >= threshold : false,
  );
}

export function upsertBatteryInfo(
  batteryInfos: BatteryInfo[],
  nextInfo: BatteryInfo,
): BatteryInfo[] {
  const key = nextInfo.user_description ?? null;
  const idx = batteryInfos.findIndex((info) => (info.user_description ?? null) === key);
  if (idx === -1) {
    return [...batteryInfos, nextInfo];
  }
  const next = [...batteryInfos];
  const merged = isValidBatteryLevel(nextInfo.battery_level)
    ? nextInfo
    : {
        ...nextInfo,
        battery_level: batteryInfos[idx].battery_level,
        observed_at_unix_ms: batteryInfos[idx].observed_at_unix_ms ?? null,
        last_read_succeeded: false,
      };
  next[idx] = merged;
  return next;
}

export function mergeBatteryInfos(prev: BatteryInfo[], next: BatteryInfo[]): BatteryInfo[] {
  return next.map((info) => {
    if (isValidBatteryLevel(info.battery_level)) {
      return info;
    }
    const key = info.user_description ?? null;
    const existing = prev.find((p) => (p.user_description ?? null) === key);
    return existing
      ? {
          ...info,
          battery_level: existing.battery_level,
          observed_at_unix_ms: existing.observed_at_unix_ms ?? null,
          last_read_succeeded: false,
        }
      : { ...info, battery_level: null, observed_at_unix_ms: null, last_read_succeeded: false };
  });
}

export function normalizeLoadedDevices(raw: unknown): RegisteredDevice[] {
  const devices = Array.isArray(raw) ? raw : [];
  return devices.map((device): RegisteredDevice => {
    const d =
      typeof device === "object" && device !== null ? (device as Record<string, unknown>) : {};
    const batteryInfos: BatteryInfo[] = Array.isArray(d.batteryInfos)
      ? d.batteryInfos.map((rawInfo): BatteryInfo => {
          const info =
            typeof rawInfo === "object" && rawInfo !== null
              ? (rawInfo as Record<string, unknown>)
              : {};
          const rawUserDesc = info.user_description ?? info.user_descriptor;
          const userDesc =
            typeof rawUserDesc === "string" || rawUserDesc === null ? rawUserDesc : null;
          const level = isValidBatteryLevel(info.battery_level) ? info.battery_level : null;
          return {
            battery_level: level,
            user_description: userDesc ?? null,
            observed_at_unix_ms: normalizeObservedTimestamp(info.observed_at_unix_ms),
            last_read_succeeded: false,
          };
        })
      : [];
    const rawId = typeof d.id === "string" ? d.id : "";
    const rawName = typeof d.name === "string" ? d.name : "";
    const extractFromDeviceId = (value: string) => {
      const match = value.match(DEVICE_ID_PATTERN);
      return match ? match[1] : value;
    };
    const displayName = normalizeDeviceDisplayName(d.displayName);
    const batteryPartLabels = normalizeBatteryPartLabels(d.batteryPartLabels);
    const base: RegisteredDevice = {
      id: extractFromDeviceId(rawId),
      name: extractFromDeviceId(rawName),
      batteryInfos,
      isDisconnected: d.isDisconnected === true,
      isCollapsed: d.isCollapsed === true,
      connectionStatusKnown: false,
      connectionObservedAtUnixMs: null,
    };
    return {
      ...base,
      ...(displayName !== undefined ? { displayName } : {}),
      ...(batteryPartLabels !== undefined ? { batteryPartLabels } : {}),
    };
  });
}
