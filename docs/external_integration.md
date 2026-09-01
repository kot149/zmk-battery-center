# External battery snapshot

zmk-battery-center publishes cached battery state for local integrations. Consumers read the snapshot file only. The app does not open an HTTP server, socket, D-Bus service, named pipe, or WebSocket.

## Path

Production files are stored in the app data directory:

- Windows: `%APPDATA%\com.zmk-battery-center.app\external`
- macOS: `~/Library/Application Support/com.zmk-battery-center.app/external`
- Linux: `$XDG_DATA_HOME/com.zmk-battery-center.app/external`, or `~/.local/share/com.zmk-battery-center.app/external` when `XDG_DATA_HOME` is unset

Debug builds use `<repo>/.dev-data/external`, unless `ZMK_BATTERY_CENTER_DATA_DIR` is set. Relative values are resolved from the repository root.

The directory is created on the first publish. Unix builds use mode `0700` for the directory and `0600` for files. Windows uses the parent directory ACL inheritance.

## `battery-state-v1.json`

This is the common snapshot consumed by file-based integrations.

```json
{
  "schemaVersion": 1,
  "revision": 12,
  "generatedAtUnixMs": 1786060800000,
  "devices": [
    {
      "id": "raw-platform-ble-id",
      "key": "device7261772d706c6174666f726d2d626c652d6964",
      "name": "Corne",
      "displayName": "Work keyboard",
      "connectionStatus": "connected",
      "connectionObservedAtUnixMs": 1786060799000,
      "batteryParts": [
        {
          "id": "central",
          "sourceDescription": null,
          "displayName": "Central",
          "levelPercent": 87,
          "observedAtUnixMs": 1786060799000,
          "valueStatus": "current"
        },
        {
          "id": "part5065726970686572616c",
          "sourceDescription": "Peripheral",
          "displayName": "Right hand",
          "levelPercent": 64,
          "observedAtUnixMs": 1786060700000,
          "valueStatus": "stale"
        }
      ]
    }
  ]
}
```

### Field definitions

- `schemaVersion`: fixed at `1`. Breaking changes use a new v2 filename.
- `revision`: monotonically increasing per successful publish in one app process. Values may be skipped after a partial write failure, but a revision is never reused. Restart continuity is not guaranteed.
- `generatedAtUnixMs`: the UTC time at which the snapshot was generated. It is not a battery observation time.
- `device.id`: the raw platform BLE ID. Consumers must not depend on its syntax.
- `device.key`: `device` followed by the lowercase hexadecimal UTF-8 bytes of `device.id`.
- `name`: the BLE-advertised device name.
- `displayName`: the user-defined name, or `name` when no custom name is set.
- `connectionStatus`: `unknown`, `connected`, or `disconnected`. This mirrors the device connection state used by the zmk-battery-center UI and does not necessarily represent the instantaneous OS-level BLE link state. A device loaded from storage is `unknown` until its state is checked.
- `connectionObservedAtUnixMs`: the last time the UI connection state was observed, or `null` when it is unknown.
- `batteryParts[].id`: `central` when there is no GATT User Description, otherwise `part` followed by lowercase hexadecimal UTF-8 bytes of the description.
- `sourceDescription`: the GATT User Description, or `null`.
- `batteryParts[].displayName`: the custom part label, or the source description, or `Central`.
- `levelPercent`: an integer from `0` through `100`, or `null`.
- `observedAtUnixMs`: the last successful observation time for the level. Reusing a last-known value does not change it.
- `valueStatus`: `current`, `stale`, or `unavailable`. Numeric values are stale when disconnected, unknown, or the latest read did not succeed. A missing numeric value is unavailable. This describes freshness at `generatedAtUnixMs`; it does not indicate that zmk-battery-center is currently running. The last snapshot remains on disk after the app exits.

## Atomic access

The producer writes complete JSON to a same-directory temporary file, flushes and syncs it, then atomically replaces the target. It never truncates a target in place or deletes the target before replacement. Consumers should keep the last-good document when a read observes invalid or incomplete content.

## Integrations

`battery-state-v1.json` is a generic snapshot API intended for use by external tools and adapters.

### Available integrations

- **RunCat Neo:** [zmk-battery-center-runcat-adapter](https://github.com/kot149/zmk-battery-center-runcat-adapter) converts `battery-state-v1.json` into the Custom Metrics JSON format supported by RunCat Neo.
- **TrafficMonitor:** [zmk-battery-center-trafficmonitor-plugin](https://github.com/kot149/zmk-battery-center-trafficmonitor-plugin) reads `battery-state-v1.json`, caches values outside `GetItemValueText()`, and displays one item for each device.

### Building other integrations

Integrations for other applications, such as GNOME Shell, can be implemented by reading and monitoring `battery-state-v1.json` directly.

## Compatibility

Version 1 fields must not be deleted, renamed, or given a different meaning. Optional fields may be added. A breaking change requires a new v2 filename.
