export type MockBatteryInfo = {
  battery_level: number | null;
  user_description: string | null;
};

export type MockDevice = {
  id: string;
  name: string;
};

export type MockRegisteredDevice = {
  id: string;
  name: string;
  batteryInfos: MockBatteryInfo[];
  isDisconnected: boolean;
};

export type MockHistoryRecord = {
  timestamp: string;
  user_description: string;
  battery_level: number;
};

export type MockSeed = {
  platform?: string;
  config?: Record<string, unknown>;
  availableDevices?: MockDevice[];
  batteryById?: Record<string, MockBatteryInfo[]>;
  registeredDevices?: MockRegisteredDevice[];
  historyByKey?: Record<string, MockHistoryRecord[]>;
};

export type MockStoreData = {
  devices?: MockRegisteredDevice[];
};

declare global {
  interface Window {
    __E2E_TAURI_SEED__?: MockSeed;
    __e2eTauriMock: {
      emitBatteryInfo: (id: string, batteryInfo: MockBatteryInfo) => Promise<void>;
      emitMonitorStatus: (id: string, connected: boolean) => Promise<void>;
      readStore: (path: string) => MockStoreData;
      getInvocations: () => Array<{ cmd: string; args?: Record<string, unknown> }>;
      setBatteryInfo: (id: string, infos: MockBatteryInfo[]) => void;
      setHistory: (deviceName: string, bleId: string, records: MockHistoryRecord[]) => void;
    };
  }
}

export {};
