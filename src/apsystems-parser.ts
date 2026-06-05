/**
 * APsystems parser — converts the ESP32-ECU `tele/<root>/SENSOR` payload into
 * per-inverter Sowel devices + data updates.
 *
 * Wire contract (see ESP32-ECU docs/mqtt-api.md): one JSON object keyed by the
 * 12-hex inverter serial, each value an object of inverter-level + per-channel
 * telemetry. A DS3 carries up to 2 channels (2 PV panels).
 *
 * This module is PURE (no MQTT, no Sowel deps) so it is fully unit-testable.
 */

export interface DiscoveredDevice {
  ieeeAddress?: string;
  friendlyName: string;
  manufacturer?: string;
  model?: string;
  data: {
    key: string;
    type: string;
    category: string;
    unit?: string;
  }[];
  orders: {
    key: string;
    type: string;
    category?: string;
  }[];
}

/** One inverter's discovery definition + the flat data values to push. */
export interface InverterSample {
  /** 12-hex serial — the stable Sowel sourceDeviceId. */
  serial: string;
  discovered: DiscoveredDevice;
  data: Record<string, number>;
}

/** Inverter-level MQTT field → Sowel device data key/category/unit. */
const INVERTER_FIELDS: { field: string; key: string; category: string; unit: string }[] = [
  { field: "Power", key: "power", category: "power", unit: "W" },
  { field: "Energy", key: "energy", category: "energy", unit: "Wh" },
  { field: "ACVoltage", key: "ac_voltage", category: "voltage", unit: "V" },
  { field: "Frequency", key: "frequency", category: "generic", unit: "Hz" },
  { field: "Temperature", key: "inverter_temp", category: "temperature_device", unit: "C" },
  { field: "Signal", key: "signal", category: "rssi", unit: "%" },
];

/** Per-channel metric suffix → Sowel key suffix/category/unit. */
const CHANNEL_METRICS: { suffix: string; key: string; category: string; unit: string }[] = [
  { suffix: "Voltage", key: "voltage", category: "voltage", unit: "V" },
  { suffix: "Current", key: "current", category: "current", unit: "A" },
  { suffix: "Power", key: "power", category: "power", unit: "W" },
  { suffix: "Energy", key: "energy", category: "energy", unit: "Wh" },
];

const CHANNEL_FIELD_RE = /^Ch(\d+)(Voltage|Current|Power|Energy)$/;

/** Safe JSON parse. Returns null on error. */
export function parseJson(raw: string | Buffer): unknown {
  try {
    const str = typeof raw === "string" ? raw : raw.toString("utf-8");
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Build one InverterSample from a single inverter object, or null if it carries
 * no usable numeric telemetry. Only fields actually present are emitted.
 */
function buildInverterSample(serial: string, obj: Record<string, unknown>): InverterSample | null {
  const data: Record<string, number> = {};
  const dataDefs: DiscoveredDevice["data"] = [];

  for (const f of INVERTER_FIELDS) {
    const v = obj[f.field];
    if (!isFiniteNumber(v)) continue;
    data[f.key] = v;
    dataDefs.push({ key: f.key, type: "number", category: f.category, unit: f.unit });
  }

  // Discover the channels present, then map each channel's metrics in a stable order.
  const channels = new Set<number>();
  for (const k of Object.keys(obj)) {
    const m = CHANNEL_FIELD_RE.exec(k);
    if (m) channels.add(Number(m[1]));
  }
  for (const n of [...channels].sort((a, b) => a - b)) {
    for (const cm of CHANNEL_METRICS) {
      const v = obj[`Ch${n}${cm.suffix}`];
      if (!isFiniteNumber(v)) continue;
      const key = `ch${n}_${cm.key}`;
      data[key] = v;
      dataDefs.push({ key, type: "number", category: cm.category, unit: cm.unit });
    }
  }

  if (dataDefs.length === 0) return null;

  return {
    serial,
    discovered: {
      friendlyName: serial,
      manufacturer: "APsystems",
      model: "DS3",
      data: dataDefs,
      orders: [],
    },
    data,
  };
}

/**
 * Parse a decoded `tele/<root>/SENSOR` payload (object keyed by serial) into an
 * array of InverterSample. The optional `Name` field per inverter is ignored
 * (informational — device identity is the serial). Malformed input yields `[]`.
 */
export function parseSensorPayload(payload: unknown): InverterSample[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const out: InverterSample[] = [];
  for (const [serial, raw] of Object.entries(payload as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const sample = buildInverterSample(serial, raw as Record<string, unknown>);
    if (sample) out.push(sample);
  }
  return out;
}
