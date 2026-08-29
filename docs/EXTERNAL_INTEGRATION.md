# External battery integration

zmk-battery-center publishes cached battery state for local integrations such as TrafficMonitor, GNOME Shell extensions, and RunCat Neo. Consumers read files only. The app does not open an HTTP server, socket, D-Bus service, named pipe, or WebSocket.

## Paths

Production files are stored in the app data directory:

- Windows: `%APPDATA%\com.zmk-battery-center.app\external`
- macOS: `~/Library/Application Support/com.zmk-battery-center.app/external`
- Linux: `$XDG_DATA_HOME/com.zmk-battery-center.app/external`, or `~/.local/share/com.zmk-battery-center.app/external` when `XDG_DATA_HOME` is unset

Debug builds use `<repo>/.dev-data/external`, unless `ZMK_BATTERY_CENTER_DATA_DIR` is set. Relative values are resolved from the repository root.

The directory is created on the first publish. Unix builds use mode `0700` for the directory and `0600` for files. Windows uses the parent directory ACL inheritance.

## Files

### `battery-state-v1.json`

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
  ],
  "lastRefresh": {
    "requestId": "traffic-monitor-1786060797000",
    "requestedAtUnixMs": 1786060797000,
    "acceptedAtUnixMs": 1786060797100,
    "completedAtUnixMs": 1786060799200,
    "status": "partial",
    "devices": [
      {
        "id": "raw-platform-ble-id",
        "status": "updated"
      }
    ]
  }
}
```

`lastRefresh` is `null` until a refresh request is accepted.

### `runcat-custom-metrics-v1.json`

This is the RunCat Neo projection of the same cached state.

```json
{
  "title": "ZMK Battery Center",
  "symbol": "battery.100percent",
  "metricsBarValue": "87% · 64%*",
  "lastUpdatedDate": "2026-08-07T00:00:00.000Z",
  "metrics": [
    {
      "title": "Work keyboard / Connection",
      "formattedValue": "Connected"
    },
    {
      "title": "Work keyboard / Central",
      "formattedValue": "87%",
      "normalizedValue": 0.87
    },
    {
      "title": "Work keyboard / Right hand",
      "formattedValue": "64% (stale)",
      "normalizedValue": 0.64
    }
  ]
}
```

`normalizedValue` is present only for numeric levels and is in the range `0..1`. The asterisk in `metricsBarValue` marks a stale last-known value.

### `refresh-request-v1.json`

A client requests a fresh BLE read by writing a temporary file in the same directory and atomically replacing this file:

```json
{
  "schemaVersion": 1,
  "requestId": "traffic-monitor-1786060797000",
  "requestedAtUnixMs": 1786060797000
}
```

The request file is a coalescing single-slot trigger, not a queue. The latest valid file is considered after the current refresh finishes and the five-second cooldown expires. Request IDs must be unique and must not be reused.

Requests are limited to 16 KiB. `schemaVersion` must be `1`, `requestId` must contain 1 to 128 printable ASCII bytes, and `requestedAtUnixMs` must be a non-negative integer. Unknown fields are ignored. Invalid requests are logged without stopping monitoring, and unchanged malformed content is not logged repeatedly.

## Field definitions

- `schemaVersion`: fixed at `1`. Breaking changes use a new v2 filename.
- `revision`: monotonically increasing per successful publish in one app process. Values may be skipped after a partial write failure, but a revision is never reused. Restart continuity is not guaranteed.
- `generatedAtUnixMs`: the UTC time at which the snapshot was generated. It is not a battery observation time.
- `device.id`: the raw platform BLE ID. Consumers must not depend on its syntax.
- `device.key`: `device` followed by the lowercase hexadecimal UTF-8 bytes of `device.id`.
- `name`: the BLE-advertised device name.
- `displayName`: the user-defined name, or `name` when no custom name is set.
- `connectionStatus`: `unknown`, `connected`, or `disconnected`. A device loaded from storage is `unknown` until a connection state is observed.
- `connectionObservedAtUnixMs`: the last time connection state was observed, or `null` when it is unknown.
- `batteryParts[].id`: `central` when there is no GATT User Description, otherwise `part` followed by lowercase hexadecimal UTF-8 bytes of the description.
- `sourceDescription`: the GATT User Description, or `null`.
- `batteryParts[].displayName`: the custom part label, or the source description, or `Central`.
- `levelPercent`: an integer from `0` through `100`, or `null`.
- `observedAtUnixMs`: the last successful observation time for the level. Reusing a last-known value does not change it.
- `valueStatus`: `current`, `stale`, or `unavailable`. Numeric values are stale when disconnected, unknown, or the latest read did not succeed. A missing numeric value is unavailable.
- `lastRefresh.status`: `pending`, `completed`, `partial`, or `failed`.

## Atomic access

The producer writes complete JSON to a same-directory temporary file, flushes and syncs it, then atomically replaces the target. It never truncates a target in place or deletes the target before replacement. Consumers should keep the last-good document when a read observes invalid or incomplete content.

The common snapshot and RunCat projection are replaced independently. They are generated from the same source revision and generation time, but cross-file atomicity is not guaranteed. A refresh terminal state is committed in memory only after both files have been published successfully.

## Refresh semantics

`refresh-request-v1.json` is a coalescing single-slot trigger, not a queue.

A client should keep one outstanding request. To detect completion, first check for an exact request ID match with a terminal `lastRefresh.status`. If requests may have been coalesced, a terminal status with `acceptedAtUnixMs >= requestedAtUnixMs` also satisfies the request. If neither condition is met before the client timeout, write a new unique request ID.

At most one refresh is active. New requests during an active refresh remain in the file for later evaluation. If terminal publication fails, the refresh remains active and pending until a later publish or the watchdog can commit a terminal result. New physical refresh acceptance is rate-limited to one every five seconds. Polling-mode refresh joins the existing polling cycle, while notification-mode refresh reads the connected battery characteristics without restarting the notification monitor.

## Security

This is a local, same-user integration interface. Device-derived strings and request files are untrusted input. Validate request size and fields, escape output strings before inserting them into UI markup, and do not treat device names as trusted identifiers.

## TrafficMonitor

Use the common snapshot as a cache:

```text
DataRequired()
  -> read battery-state-v1.json
  -> update plugin cache

GetItemValueText()
  -> return cached text only
```

Do not perform BLE refreshes or wait for file I/O from `GetItemValueText()`. When a fresh value is needed, write a unique refresh request and inspect a later snapshot.

## GNOME Shell

Monitor `battery-state-v1.json` with `GFileMonitor`. The producer replaces the target by rename, so handle change events for replacement and reload the complete document.

## RunCat Neo

Select `runcat-custom-metrics-v1.json` in the custom metrics settings. Use `metricsBarValue` for the Metrics Bar. A `*` marks a stale last-known numeric value.

## Compatibility

Version 1 fields must not be deleted, renamed, or given a different meaning. Optional fields may be added. A breaking change requires a new v2 filename.
