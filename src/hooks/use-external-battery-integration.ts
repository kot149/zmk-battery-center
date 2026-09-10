import { useCallback, useEffect, useRef } from "react";
import { fireAndForget } from "@/utils/common";
import {
  buildExternalBatteryDevices,
  publishExternalBatterySnapshot,
  startExternalBatterySourceSession,
  type RegisteredDevicesSnapshot,
} from "@/utils/external-battery-integration";
import type { RegisteredDevice } from "@/utils/app-helpers";

const PUBLISH_DEBOUNCE_MS = 75;

type UseExternalBatteryIntegrationOptions = {
  isDeviceLoaded: boolean;
  registeredDevices: RegisteredDevice[] | undefined;
  getRegisteredDevicesSnapshot: () => RegisteredDevicesSnapshot;
};

export function useExternalBatteryIntegration({
  isDeviceLoaded,
  registeredDevices,
  getRegisteredDevicesSnapshot,
}: UseExternalBatteryIntegrationOptions) {
  const getSnapshotRef = useRef(getRegisteredDevicesSnapshot);
  const isDeviceLoadedRef = useRef(isDeviceLoaded);
  const publishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sourceGenerationRef = useRef<number | null>(null);
  const sourceGenerationPromiseRef = useRef<Promise<number> | null>(null);

  useEffect(() => {
    getSnapshotRef.current = getRegisteredDevicesSnapshot;
    isDeviceLoadedRef.current = isDeviceLoaded;
  });

  const getSourceGeneration = useCallback(() => {
    if (sourceGenerationRef.current !== null) {
      return Promise.resolve(sourceGenerationRef.current);
    }
    if (sourceGenerationPromiseRef.current !== null) {
      return sourceGenerationPromiseRef.current;
    }
    const promise = startExternalBatterySourceSession()
      .then((sourceGeneration) => {
        sourceGenerationRef.current = sourceGeneration;
        return sourceGeneration;
      })
      .finally(() => {
        sourceGenerationPromiseRef.current = null;
      });
    sourceGenerationPromiseRef.current = promise;
    return promise;
  }, []);

  const publishSnapshot = useCallback(() => {
    if (!isDeviceLoadedRef.current) return;
    fireAndForget(
      getSourceGeneration().then((sourceGeneration) => {
        const snapshot = getSnapshotRef.current();
        return publishExternalBatterySnapshot(
          sourceGeneration,
          snapshot.sourceRevision,
          buildExternalBatteryDevices(snapshot.devices),
        );
      }),
      "Failed to publish external battery snapshot",
    );
  }, [getSourceGeneration]);

  useEffect(() => {
    if (!isDeviceLoaded) return;
    if (publishTimerRef.current !== null) {
      clearTimeout(publishTimerRef.current);
    }
    publishTimerRef.current = setTimeout(() => {
      publishTimerRef.current = null;
      publishSnapshot();
    }, PUBLISH_DEBOUNCE_MS);
    return () => {
      if (publishTimerRef.current !== null) {
        clearTimeout(publishTimerRef.current);
        publishTimerRef.current = null;
      }
    };
  }, [isDeviceLoaded, registeredDevices, publishSnapshot]);

  useEffect(
    () => () => {
      if (publishTimerRef.current !== null) {
        clearTimeout(publishTimerRef.current);
      }
    },
    [],
  );
}
