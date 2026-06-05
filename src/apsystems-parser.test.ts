import { describe, it, expect } from "vitest";
import { parseJson, parseSensorPayload } from "./apsystems-parser.js";

/** A full DS3 inverter object (2 channels) as published by ESP32-ECU. */
function inverter(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ACVoltage: 228.4,
    Frequency: 50.02,
    Temperature: 19.1,
    Signal: 78,
    Power: 115.5,
    Energy: 1732.1,
    Ch1Voltage: 36.7,
    Ch1Current: 1.55,
    Ch1Power: 56.9,
    Ch1Energy: 848.6,
    Ch2Voltage: 36.4,
    Ch2Current: 1.61,
    Ch2Power: 58.6,
    Ch2Energy: 883.5,
    ...extra,
  };
}

describe("parseSensorPayload", () => {
  it("single inverter, 2 channels → one sample with inverter + ch1 + ch2 data", () => {
    const samples = parseSensorPayload({ "705000165830": inverter() });
    expect(samples).toHaveLength(1);
    const s = samples[0];
    expect(s.serial).toBe("705000165830");
    expect(s.discovered.friendlyName).toBe("705000165830");
    expect(s.discovered.manufacturer).toBe("APsystems");
    expect(s.discovered.orders).toEqual([]);

    // Inverter-level values
    expect(s.data.power).toBe(115.5);
    expect(s.data.energy).toBe(1732.1);
    expect(s.data.ac_voltage).toBe(228.4);
    expect(s.data.frequency).toBe(50.02);
    expect(s.data.inverter_temp).toBe(19.1);
    expect(s.data.signal).toBe(78);
    // Per-channel
    expect(s.data.ch1_voltage).toBe(36.7);
    expect(s.data.ch1_current).toBe(1.55);
    expect(s.data.ch1_power).toBe(56.9);
    expect(s.data.ch1_energy).toBe(848.6);
    expect(s.data.ch2_power).toBe(58.6);

    // 6 inverter-level + 8 channel = 14 data points
    expect(s.discovered.data).toHaveLength(14);
  });

  it("maps Temperature to inverter_temp / temperature_device", () => {
    const [s] = parseSensorPayload({ "705000165830": inverter() });
    const def = s.discovered.data.find((d) => d.key === "inverter_temp");
    expect(def).toBeDefined();
    expect(def!.category).toBe("temperature_device");
    expect(def!.unit).toBe("C");
  });

  it("maps channel metrics to the right categories", () => {
    const [s] = parseSensorPayload({ "705000165830": inverter() });
    const byKey = Object.fromEntries(s.discovered.data.map((d) => [d.key, d]));
    expect(byKey.ch1_voltage.category).toBe("voltage");
    expect(byKey.ch1_current.category).toBe("current");
    expect(byKey.ch1_power.category).toBe("power");
    expect(byKey.ch1_energy.category).toBe("energy");
  });

  it("two inverters → two independent samples", () => {
    const samples = parseSensorPayload({
      "705000165830": inverter(),
      "705000165960": inverter({ Power: 90.0 }),
    });
    expect(samples).toHaveLength(2);
    expect(samples.map((s) => s.serial).sort()).toEqual(["705000165830", "705000165960"]);
    expect(samples[1].data.power).toBe(90.0);
  });

  it("inverter with only Ch1 fields → no ch2_* keys", () => {
    const obj = inverter();
    delete obj.Ch2Voltage;
    delete obj.Ch2Current;
    delete obj.Ch2Power;
    delete obj.Ch2Energy;
    const [s] = parseSensorPayload({ "705000165830": obj });
    expect(s.data.ch1_power).toBe(56.9);
    expect(s.data.ch2_power).toBeUndefined();
    expect(s.discovered.data.some((d) => d.key.startsWith("ch2_"))).toBe(false);
  });

  it("Name field is read but not emitted as a data point", () => {
    const [s] = parseSensorPayload({ "705000165830": inverter({ Name: "Toit Sud" }) });
    expect(s.data).not.toHaveProperty("Name");
    expect(s.discovered.data.some((d) => d.key === "Name")).toBe(false);
  });

  it("malformed / non-object payloads → empty array, no throw", () => {
    expect(parseSensorPayload(null)).toEqual([]);
    expect(parseSensorPayload("nope")).toEqual([]);
    expect(parseSensorPayload(42)).toEqual([]);
    expect(parseSensorPayload([1, 2, 3])).toEqual([]);
    // object whose value is not an inverter object is skipped
    expect(parseSensorPayload({ "705000165830": "garbage" })).toEqual([]);
    // inverter object with no numeric telemetry is dropped
    expect(parseSensorPayload({ "705000165830": { Name: "x" } })).toEqual([]);
  });
});

describe("parseJson", () => {
  it("parses valid JSON and returns null on garbage", () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseJson("not json")).toBeNull();
    expect(parseJson(Buffer.from('{"b":2}'))).toEqual({ b: 2 });
  });
});
