/**
 * APsystems engine — subscribes to the ESP32-ECU MQTT telemetry, discovers one
 * device per micro-inverter, pushes per-channel data, and keeps per-inverter
 * online/offline status truthful.
 *
 * Topics (root configurable, default `esp32ecu`):
 *   tele/<root>/SENSOR  retained JSON keyed by serial — one object per producing inverter
 *   tele/<root>/LWT     retained Online/Offline + will — the bridge presence
 */

import type { MqttConnector } from "./mqtt-connector.js";
import { parseJson, parseSensorPayload } from "./apsystems-parser.js";

export interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  info(obj: Record<string, unknown>, msg: string): void;
  info(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

export interface EventBus {
  emit(event: unknown): void;
}

export interface DeviceManager {
  upsertFromDiscovery(integrationId: string, source: string, discovered: unknown): void;
  updateDeviceData(
    integrationId: string,
    sourceDeviceId: string,
    payload: Record<string, unknown>,
  ): void;
  updateDeviceStatus(integrationId: string, sourceDeviceId: string, status: string): void;
}

export class ApsystemsEngine {
  private readonly integrationId: string;
  private readonly root: string;
  private readonly mqtt: MqttConnector;
  private readonly deviceManager: DeviceManager;
  private readonly eventBus: EventBus;
  private readonly logger: Logger;

  /** Device ids (Name, or serial when unnamed) discovered at least once — used
   * to flip absent inverters offline. */
  private readonly known = new Set<string>();

  constructor(
    integrationId: string,
    root: string,
    mqtt: MqttConnector,
    deviceManager: DeviceManager,
    eventBus: EventBus,
    logger: Logger,
  ) {
    this.integrationId = integrationId;
    this.root = root;
    this.mqtt = mqtt;
    this.deviceManager = deviceManager;
    this.eventBus = eventBus;
    this.logger = logger;
  }

  start(): void {
    this.mqtt.subscribe(`tele/${this.root}/SENSOR`, (_topic, payload) =>
      this.handleSensor(parseJson(payload)),
    );
    this.mqtt.subscribe(`tele/${this.root}/LWT`, (_topic, payload) =>
      this.handleLwt(payload.toString("utf-8").trim()),
    );
    this.logger.info({ root: this.root }, "APsystems subscriptions installed");
  }

  /**
   * Apply one decoded SENSOR payload: discover/refresh present inverters, then
   * flip any previously-seen-but-now-absent inverter offline.
   */
  handleSensor(json: unknown): void {
    try {
      const samples = parseSensorPayload(json);
      const present = new Set<string>();

      for (const s of samples) {
        present.add(s.id);
        this.known.add(s.id);
        this.deviceManager.upsertFromDiscovery(this.integrationId, this.integrationId, s.discovered);
        this.deviceManager.updateDeviceData(this.integrationId, s.id, s.data);
        this.deviceManager.updateDeviceStatus(this.integrationId, s.id, "online");
      }

      // Inverters that have produced before but are absent this cycle are offline
      // (out of range, or night — DS3 are panel-powered). updateDeviceStatus is
      // idempotent, so re-asserting offline each cycle is cheap.
      for (const id of this.known) {
        if (!present.has(id)) {
          this.deviceManager.updateDeviceStatus(this.integrationId, id, "offline");
        }
      }

      if (samples.length > 0) {
        this.logger.debug({ inverters: samples.length }, "SENSOR processed");
      }
    } catch (err) {
      this.logger.error({ err } as Record<string, unknown>, "SENSOR handler error");
    }
  }

  /** Bridge LWT: Online → integration connected; Offline → all inverters offline. */
  handleLwt(value: string): void {
    try {
      if (value === "Online") {
        this.eventBus.emit({ type: "system.integration.connected", integrationId: this.integrationId });
        this.logger.info("ESP32-ECU bridge online");
      } else if (value === "Offline") {
        for (const id of this.known) {
          this.deviceManager.updateDeviceStatus(this.integrationId, id, "offline");
        }
        this.eventBus.emit({
          type: "system.integration.disconnected",
          integrationId: this.integrationId,
        });
        this.logger.warn("ESP32-ECU bridge offline — all inverters marked offline");
      }
    } catch (err) {
      this.logger.error({ err } as Record<string, unknown>, "LWT handler error");
    }
  }
}
