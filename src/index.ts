/**
 * Sowel Plugin: APsystems
 *
 * Read-only MQTT integration for APsystems micro-inverters (DS3/YC600/QS1) bridged
 * by the ESP32-ECU firmware. Discovers one device per micro-inverter and pushes
 * per-channel telemetry; the user binds a "Solar Panel" equipment per channel.
 */

import { MqttConnector } from "./mqtt-connector.js";
import { ApsystemsEngine } from "./apsystems-engine.js";
import type { DeviceManager, EventBus, Logger } from "./apsystems-engine.js";

interface SettingsManager {
  get(key: string): string | undefined;
}

interface Device {
  id: string;
  integrationId: string;
  sourceDeviceId: string;
  name: string;
}

interface PluginDeps {
  logger: Logger;
  eventBus: EventBus;
  settingsManager: SettingsManager;
  deviceManager: DeviceManager;
  pluginDir: string;
}

type IntegrationStatus = "connected" | "disconnected" | "not_configured" | "error";

interface IntegrationSettingDef {
  key: string;
  label: string;
  type: "text" | "password" | "number" | "boolean";
  required: boolean;
  placeholder?: string;
  defaultValue?: string;
}

interface IntegrationPlugin {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly icon: string;
  readonly apiVersion?: number;
  getStatus(): IntegrationStatus;
  isConfigured(): boolean;
  getSettingsSchema(): IntegrationSettingDef[];
  start(options?: { pollOffset?: number }): Promise<void>;
  stop(): Promise<void>;
  executeOrder(
    device: Device,
    orderKeyOrDispatchConfig: string | Record<string, unknown>,
    value: unknown,
  ): Promise<void>;
}

const INTEGRATION_ID = "apsystems";
const SETTINGS_PREFIX = `integration.${INTEGRATION_ID}.`;

class ApsystemsPlugin implements IntegrationPlugin {
  readonly id = INTEGRATION_ID;
  readonly name = "APsystems";
  readonly description = "APsystems micro-inverters (DS3/YC600/QS1) via the ESP32-ECU MQTT bridge";
  readonly icon = "Sun";
  readonly apiVersion = 2;

  private logger: Logger;
  private eventBus: EventBus;
  private settingsManager: SettingsManager;
  private deviceManager: DeviceManager;
  private mqtt: MqttConnector | null = null;
  private engine: ApsystemsEngine | null = null;
  private status: IntegrationStatus = "disconnected";

  constructor(deps: PluginDeps) {
    this.logger = deps.logger;
    this.eventBus = deps.eventBus;
    this.settingsManager = deps.settingsManager;
    this.deviceManager = deps.deviceManager;
  }

  getStatus(): IntegrationStatus {
    if (!this.isConfigured()) return "not_configured";
    if (this.status === "connected" && this.mqtt && !this.mqtt.isConnected()) return "error";
    return this.status;
  }

  isConfigured(): boolean {
    return this.getSetting("mqtt_url") !== undefined;
  }

  getSettingsSchema(): IntegrationSettingDef[] {
    return [
      {
        key: "mqtt_url",
        label: "MQTT Broker URL",
        type: "text",
        required: true,
        placeholder: "mqtt://localhost:1883",
      },
      { key: "mqtt_username", label: "MQTT Username", type: "text", required: false },
      { key: "mqtt_password", label: "MQTT Password", type: "password", required: false },
      {
        key: "mqtt_client_id",
        label: "MQTT Client ID",
        type: "text",
        required: false,
        defaultValue: "sowel-apsystems",
      },
      {
        key: "base_topic",
        label: "ESP32-ECU Topic Root",
        type: "text",
        required: false,
        defaultValue: "esp32ecu",
      },
    ];
  }

  async start(): Promise<void> {
    if (!this.isConfigured()) {
      this.status = "not_configured";
      return;
    }

    const mqttUrl = this.getSetting("mqtt_url")!;
    const mqttUsername = this.getSetting("mqtt_username") || undefined;
    const mqttPassword = this.getSetting("mqtt_password") || undefined;
    // Random suffix avoids client_id collisions across restarts.
    const baseClientId = this.getSetting("mqtt_client_id") ?? "sowel-apsystems";
    const mqttClientId = `${baseClientId}-${Math.random().toString(36).slice(2, 8)}`;
    const baseTopic = this.getSetting("base_topic") ?? "esp32ecu";

    try {
      const connector = new MqttConnector(
        mqttUrl,
        { username: mqttUsername, password: mqttPassword, clientId: mqttClientId },
        this.eventBus,
        this.logger,
        INTEGRATION_ID,
        // Keep `this.status` in sync with the real socket for the whole
        // lifetime of the plugin, not just the snapshot taken below: a broker
        // unreachable at boot connects for real seconds later, and the old
        // one-shot read froze the plugin on "disconnected" forever
        // (mchacher/sowel-plugin-zigbee2mqtt#19).
        (connected) => {
          // Ignore a connector this plugin no longer owns (a stop/start cycle
          // leaves the old client emitting for a while), and never resurrect a
          // start() that failed.
          if (this.mqtt !== connector || this.status === "error") return;
          this.status = connected ? "connected" : "disconnected";
        },
      );
      this.mqtt = connector;
      await this.mqtt.connect();

      this.engine = new ApsystemsEngine(
        INTEGRATION_ID,
        baseTopic,
        this.mqtt,
        this.deviceManager,
        this.eventBus,
        this.logger,
      );
      this.engine.start();

      // Best-effort snapshot for the log line below: the callback above is the
      // source of truth from here on and corrects it once the broker answers.
      this.status = this.mqtt.isConnected() ? "connected" : "disconnected";
      this.logger.info("APsystems plugin started");
    } catch (err) {
      this.status = "error";
      this.logger.error({ err } as Record<string, unknown>, "Failed to start APsystems plugin");
    }
  }

  async stop(): Promise<void> {
    if (this.mqtt) {
      await this.mqtt.disconnect();
      this.mqtt = null;
      this.engine = null;
      this.status = "disconnected";
      this.eventBus.emit({ type: "system.integration.disconnected", integrationId: this.id });
      this.logger.info("APsystems plugin stopped");
    }
  }

  async executeOrder(): Promise<void> {
    // Read-only bridge: the ESP32-ECU never subscribes to commands (see its
    // docs/mqtt-api.md). Power throttle is per-inverter and out of scope here.
    throw new Error("APsystems plugin is read-only and does not support orders");
  }

  private getSetting(key: string): string | undefined {
    return this.settingsManager.get(`${SETTINGS_PREFIX}${key}`);
  }
}

export function createPlugin(deps: PluginDeps): IntegrationPlugin {
  return new ApsystemsPlugin(deps);
}
