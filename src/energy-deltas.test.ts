import { describe, it, expect, vi } from "vitest";
import { EnergyDeltas } from "./energy-deltas.js";

function mk(persisted: Record<string, number> = {}) {
  const logger = { info: vi.fn(), warn: vi.fn() };
  const deviceManager = {
    getDeviceDataValue: vi.fn((_i: string, dev: string, key: string) => persisted[`${dev}/${key}`] ?? null),
  };
  return { deltas: new EnergyDeltas("apsystems", deviceManager, logger), logger, deviceManager };
}

describe("EnergyDeltas (sowel#934)", () => {
  it("anchors on the first report without crediting the counter", () => {
    const { deltas } = mk();
    expect(deltas.apply("INV_1", { energy_total: 1732.1, power: 100 })).toEqual({
      energy_total: 1732.1,
      energy: 0,
      power: 100,
    });
  });

  it("publishes the Wh produced since the previous report", () => {
    const { deltas } = mk();
    deltas.apply("INV_1", { energy_total: 1732.1 });
    expect(deltas.apply("INV_1", { energy_total: 1733.4 }).energy).toBe(1.3);
    expect(deltas.apply("INV_1", { energy_total: 1733.4 }).energy).toBe(0);
  });

  it("never sums counters: an hour of reports adds up to the production, not the counter", () => {
    const { deltas } = mk();
    let summed = 0;
    for (let i = 0; i <= 120; i++) {
      summed += deltas.apply("INV_1", { energy_total: 1732 + i * 0.5 }).energy as number;
    }
    expect(summed).toBeCloseTo(60, 6);
  });

  it("tracks each channel and each inverter separately", () => {
    const { deltas } = mk();
    deltas.apply("INV_1", { energy_total: 100, ch1_energy_total: 60, ch2_energy_total: 40 });
    deltas.apply("INV_2", { energy_total: 500 });
    expect(deltas.apply("INV_1", { energy_total: 103, ch1_energy_total: 62, ch2_energy_total: 41 })).toMatchObject({
      energy: 3,
      ch1_energy: 2,
      ch2_energy: 1,
    });
    expect(deltas.apply("INV_2", { energy_total: 510 }).energy).toBe(10);
  });

  it("rehydrates the baseline after a restart, crediting downtime production once", () => {
    const { deltas, logger } = mk({ "INV_1/energy_total": 1700 });
    expect(deltas.apply("INV_1", { energy_total: 1732 }).energy).toBe(32);
    expect(logger.info).toHaveBeenCalled();
  });

  it("re-anchors on a counter that went backwards, and credits correctly after", () => {
    const { deltas, logger } = mk();
    deltas.apply("INV_1", { energy_total: 1732 });
    expect(deltas.apply("INV_1", { energy_total: 0 }).energy).toBe(0);
    expect(deltas.apply("INV_1", { energy_total: 2 }).energy).toBe(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("refuses a counter-sized jump", () => {
    const { deltas, logger } = mk();
    deltas.apply("INV_1", { energy_total: 0 });
    expect(deltas.apply("INV_1", { energy_total: 250_000 }).energy).toBe(0);
    expect(deltas.apply("INV_1", { energy_total: 250_001 }).energy).toBe(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("works on a core without getDeviceDataValue", () => {
    const deltas = new EnergyDeltas("apsystems", {}, { info: vi.fn(), warn: vi.fn() });
    expect(deltas.apply("INV_1", { energy_total: 10 }).energy).toBe(0);
    expect(deltas.apply("INV_1", { energy_total: 11 }).energy).toBe(1);
  });

  it("does not mutate its input", () => {
    const { deltas } = mk();
    const data = { energy_total: 5 };
    deltas.apply("INV_1", data);
    expect(data).toEqual({ energy_total: 5 });
  });
});
