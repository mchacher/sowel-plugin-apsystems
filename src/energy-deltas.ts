/**
 * Cumulative → delta energy (sowel#934).
 *
 * The ESP32-ECU publishes `Energy` and `Ch<N>Energy` as lifetime cumulative
 * counters in Wh (ESP32-ECU docs/mqtt-api.md). Sowel's `energy` category is the
 * opposite: an additive **Wh delta since the previous report** —
 * `HistoryWriter.accumulateEnergyDelta` does `wh += value`, and the hourly
 * downsampling task sums every point with `category == "energy"`. Pushing the
 * counter there sums counters, fabricating tens of kWh per hour.
 *
 * So each counter is published twice:
 * - `<key>_total`: the raw counter, declared `generic`, for display;
 * - `<key>`: the Wh delta since the previous report, declared `energy`.
 *
 * Same approach as `sowel-plugin-zigbee2mqtt`'s energy-counter.ts.
 */

interface Logger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

interface DeviceManager {
  /** Available since Sowel v1.5.1 — used to rehydrate counter baselines. */
  getDeviceDataValue?(
    integrationId: string,
    sourceDeviceId: string,
    key: string,
  ): string | number | boolean | null;
}

/** Suffix of the key carrying the raw counter. */
export const TOTAL_SUFFIX = "_total";

/** Wh precision kept on the emitted delta — 1 mWh. */
const WH_PRECISION = 1000;

/**
 * Largest delta credited from one report. A backwards step (counter reset, a
 * failed read surfacing as 0) re-anchors low, and without this cap the NEXT
 * report would credit the whole counter — the very bug this module exists to
 * prevent. 10 kWh is more than a day of a DS3 (≈ 880 W peak), so a catch-up
 * after downtime is kept and a counter-sized jump is rejected.
 */
const MAX_DELTA_WH = 10_000;

export class EnergyDeltas {
  /**
   * `<deviceId>\0<totalKey>` → last seen counter. A present key with an
   * `undefined` value means "hydration attempted, nothing persisted": the next
   * report anchors the baseline instead of crediting the whole counter.
   */
  private readonly baselines = new Map<string, number | undefined>();

  constructor(
    private readonly integrationId: string,
    private readonly deviceManager: DeviceManager,
    private readonly logger: Logger,
  ) {}

  /**
   * For every `<key>_total` counter in `data`, set `<key>` to the Wh delta
   * since the previous report. Returns a new object; `data` is not mutated.
   */
  apply(deviceId: string, data: Record<string, number | string>): Record<string, number | string> {
    const out = { ...data };
    for (const [totalKey, raw] of Object.entries(data)) {
      if (!totalKey.endsWith(TOTAL_SUFFIX) || typeof raw !== "number") continue;
      const deltaKey = totalKey.slice(0, -TOTAL_SUFFIX.length);
      out[deltaKey] = this.delta(deviceId, totalKey, raw);
    }
    return out;
  }

  private delta(deviceId: string, totalKey: string, raw: number): number {
    const id = `${deviceId}\0${totalKey}`;
    const baseline = this.ensureBaseline(id, deviceId, totalKey);
    this.baselines.set(id, raw);

    // Fresh device, or nothing persisted yet: anchor without crediting.
    if (baseline === undefined) return 0;

    if (raw < baseline) {
      this.logger.warn(
        { deviceId, key: totalKey, previous: baseline, current: raw },
        "Energy counter went backwards (reset) — re-anchoring, emitting 0",
      );
      return 0;
    }
    const deltaWh = raw - baseline;
    if (deltaWh > MAX_DELTA_WH) {
      this.logger.warn(
        { deviceId, key: totalKey, previous: baseline, current: raw, deltaWh },
        "Implausible energy jump — re-anchoring, emitting 0",
      );
      return 0;
    }
    return Math.round(deltaWh * WH_PRECISION) / WH_PRECISION;
  }

  /**
   * Hydrate the baseline from persisted device data the first time a counter
   * is seen in this process. Without it a plugin restart would credit the whole
   * counter as a single delta; with it, what was produced while Sowel was down
   * is credited exactly once.
   */
  private ensureBaseline(id: string, deviceId: string, totalKey: string): number | undefined {
    if (this.baselines.has(id)) return this.baselines.get(id);
    const persisted = this.deviceManager.getDeviceDataValue?.(this.integrationId, deviceId, totalKey);
    const baseline =
      typeof persisted === "number" && Number.isFinite(persisted) ? persisted : undefined;
    this.baselines.set(id, baseline);
    if (baseline !== undefined) {
      this.logger.info({ deviceId, key: totalKey, baseline }, "Energy counter baseline hydrated");
    }
    return baseline;
  }
}
