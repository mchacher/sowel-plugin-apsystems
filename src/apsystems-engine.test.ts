import { describe, it, expect, vi } from "vitest";
import { ApsystemsEngine, type DeviceManager, type EventBus, type Logger } from "./apsystems-engine.js";

function inverter(power = 100): Record<string, unknown> {
  return {
    Power: power,
    Energy: 1000,
    Ch1Voltage: 36,
    Ch1Current: 1.5,
    Ch1Power: power,
    Ch1Energy: 800,
  };
}

function mkEngine() {
  const deviceManager = {
    upsertFromDiscovery: vi.fn(),
    updateDeviceData: vi.fn(),
    updateDeviceStatus: vi.fn(),
  } satisfies DeviceManager;
  const eventBus = { emit: vi.fn() } satisfies EventBus;
  const logger: Logger = {
    child: () => logger,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const mqtt = { subscribe: vi.fn() } as unknown as import("./mqtt-connector.js").MqttConnector;
  const engine = new ApsystemsEngine("apsystems", "esp32ecu", mqtt, deviceManager, eventBus, logger);
  return { engine, deviceManager, eventBus };
}

describe("ApsystemsEngine.handleSensor", () => {
  it("discovers + marks online each present inverter", () => {
    const { engine, deviceManager } = mkEngine();
    engine.handleSensor({ A: inverter(), B: inverter(50) });

    expect(deviceManager.upsertFromDiscovery).toHaveBeenCalledTimes(2);
    expect(deviceManager.updateDeviceData).toHaveBeenCalledWith(
      "apsystems",
      "A",
      expect.objectContaining({ power: 100 }),
    );
    expect(deviceManager.updateDeviceStatus).toHaveBeenCalledWith("apsystems", "A", "online");
    expect(deviceManager.updateDeviceStatus).toHaveBeenCalledWith("apsystems", "B", "online");
  });

  it("flips a previously-seen but now-absent inverter offline", () => {
    const { engine, deviceManager } = mkEngine();
    engine.handleSensor({ A: inverter(), B: inverter() }); // both seen
    deviceManager.updateDeviceStatus.mockClear();

    engine.handleSensor({ A: inverter() }); // B absent this cycle

    expect(deviceManager.updateDeviceStatus).toHaveBeenCalledWith("apsystems", "A", "online");
    expect(deviceManager.updateDeviceStatus).toHaveBeenCalledWith("apsystems", "B", "offline");
  });

  it("never throws on malformed payload", () => {
    const { engine, deviceManager } = mkEngine();
    expect(() => engine.handleSensor("garbage")).not.toThrow();
    expect(deviceManager.upsertFromDiscovery).not.toHaveBeenCalled();
  });
});

describe("ApsystemsEngine.handleLwt", () => {
  it("Offline → all known inverters offline + integration disconnected", () => {
    const { engine, deviceManager, eventBus } = mkEngine();
    engine.handleSensor({ A: inverter(), B: inverter() }); // know A, B
    deviceManager.updateDeviceStatus.mockClear();

    engine.handleLwt("Offline");

    expect(deviceManager.updateDeviceStatus).toHaveBeenCalledWith("apsystems", "A", "offline");
    expect(deviceManager.updateDeviceStatus).toHaveBeenCalledWith("apsystems", "B", "offline");
    expect(eventBus.emit).toHaveBeenCalledWith({
      type: "system.integration.disconnected",
      integrationId: "apsystems",
    });
  });

  it("Online → integration connected", () => {
    const { engine, eventBus } = mkEngine();
    engine.handleLwt("Online");
    expect(eventBus.emit).toHaveBeenCalledWith({
      type: "system.integration.connected",
      integrationId: "apsystems",
    });
  });
});
