# sowel-plugin-apsystems

Sowel integration for **APsystems micro-inverters** (DS3 / YC600 / QS1), read locally
through the [ESP32-ECU](https://github.com/mchacher/ESP32-ECU) firmware — no cloud, no
EMA account.

The ESP32-ECU bridge reads the inverters over Zigbee (CC2530) and republishes their
telemetry over MQTT. This plugin subscribes to that stream, discovers **one device per
micro-inverter**, and pushes per-channel data so you can bind a **Solar Panel** equipment
(`solar_panel`) to each PV panel in Sowel.

## What it does

- Subscribes to `tele/<root>/SENSOR` (retained JSON keyed by inverter serial) and
  `tele/<root>/LWT` (bridge presence).
- Discovers one device per serial, exposing:
  - inverter level: `power`, `energy`, `ac_voltage`, `frequency`, `inverter_temp`
    (category `temperature_device`), `signal`
  - per channel: `ch<N>_voltage`, `ch<N>_current`, `ch<N>_power`, `ch<N>_energy`
- Marks an inverter **offline** when it drops out of the `SENSOR` payload (out of range,
  or at night — DS3 are panel-powered), and all inverters offline when the bridge `LWT`
  goes `Offline`.

Read-only: the bridge does not accept commands.

## Binding to Sowel equipments

A DS3 carries up to 2 panels. When you create a **Solar Panel** equipment and pick the
inverter device, Sowel offers **one binding candidate per channel** (Panel 1, Panel 2),
each grouping that channel's voltage/current/power/energy plus the shared inverter
temperature. Create one Solar Panel per physical panel.

## Settings

| Setting          | Required | Default           | Notes                                |
| ---------------- | -------- | ----------------- | ------------------------------------ |
| `mqtt_url`       | yes      | —                 | e.g. `mqtt://192.168.0.230:1883`     |
| `mqtt_username`  | no       | —                 |                                      |
| `mqtt_password`  | no       | —                 |                                      |
| `mqtt_client_id` | no       | `sowel-apsystems` | a random suffix is appended          |
| `base_topic`     | no       | `esp32ecu`        | the ESP32-ECU topic root (`<root>`)  |

## Develop

```bash
npm install
npm run build      # tsc → dist/
npm test           # vitest (pure parser + engine logic)
```

## Release

Tag `vX.Y.Z`; the GitHub Action builds, tests, and uploads
`sowel-plugin-apsystems-X.Y.Z.tar.gz`. Then update `plugins/registry.json` in the Sowel
repo (`node scripts/backfill-registry-sha256.mjs`).
