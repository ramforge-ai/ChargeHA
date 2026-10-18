import type {
  DeviceInfo,
  EnergyData,
  EnergySourceAdapter,
} from "@chargeha/shared";
import type { Logger } from "@chargeha/server/lib/Logger";
import {
  type PowerwallGatewayApi,
  PowerwallGatewayConnectionError,
} from "./PowerwallGatewayClient.ts";

const AGGREGATES_PATH = "/api/meters/aggregates";
const SOE_PATH = "/api/system_status/soe";

type JsonRecord = Record<string, unknown>;

const recordAt = (value: unknown, label: string): JsonRecord => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonRecord;
  }
  throw new Error(`Powerwall telemetry is missing ${label}`);
};

const numberAt = (value: unknown, label: string): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`Powerwall telemetry has invalid ${label}`);
};

const optionalNumberAt = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const powerAt = (meter: JsonRecord, label: string): number =>
  numberAt(
    meter.instant_power ?? meter.instantaneous_power,
    `${label}.instant_power`,
  );

const timestampAt = (meter: JsonRecord, label: string): number => {
  const raw = meter.last_communication_time;
  const parsed = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new Error(`Powerwall telemetry has invalid ${label} timestamp`);
  }
  return parsed;
};

const usableSoc = (value: number): number => {
  if (value < 0 || value > 100) {
    throw new Error("Powerwall telemetry has invalid battery state of charge");
  }
  // The local SOE includes Tesla's 5% buffer, unlike the app's usable SOC.
  // This buffer is separate from the owner's configurable backup reserve.
  return Math.max(0, Math.min(100, (value - 5) / 0.95));
};

interface MeterSet {
  site: JsonRecord;
  solar: JsonRecord;
  load: JsonRecord;
  battery: JsonRecord;
}

const metersFrom = (raw: unknown): MeterSet => {
  const aggregates = recordAt(raw, "meter aggregates");
  return {
    site: recordAt(aggregates.site, "site meter"),
    solar: recordAt(aggregates.solar, "solar meter"),
    load: recordAt(aggregates.load, "load meter"),
    battery: recordAt(aggregates.battery, "battery meter"),
  };
};

const assertFresh = (
  meters: MeterSet,
  nowMs: number,
  maxStalenessSeconds: number,
): void => {
  const timestamps = [
    timestampAt(meters.site, "site"),
    timestampAt(meters.solar, "solar"),
    timestampAt(meters.load, "load"),
    timestampAt(meters.battery, "battery"),
  ];
  if (Math.max(...timestamps) > nowMs + 5_000) {
    throw new Error(
      "Powerwall telemetry timestamp is in the future; check Gateway and server clocks",
    );
  }
  const oldest = Math.min(...timestamps);
  const ageSeconds = Math.max(0, nowMs - oldest) / 1000;
  if (ageSeconds > maxStalenessSeconds) {
    throw new Error(
      `Powerwall telemetry is stale (${
        Math.round(ageSeconds)
      }s old; limit ${maxStalenessSeconds}s)`,
    );
  }
};

const batterySocFrom = (raw: unknown): number => {
  const soe = recordAt(raw, "battery state of charge");
  return usableSoc(numberAt(soe.percentage, "battery percentage"));
};

const gridVoltageFrom = (site: JsonRecord): number | null =>
  optionalNumberAt(
    site.instant_average_voltage ?? site.instantaneous_average_voltage,
  );

export class PowerwallGatewayAdapter implements EnergySourceAdapter {
  private inFlight: Promise<EnergyData> | null = null;
  private controller: AbortController | null = null;
  constructor(
    private readonly client: PowerwallGatewayApi,
    private readonly maxStalenessSeconds: number,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
    private readonly intervalSeconds = 30,
    private readonly cycleTimeoutMs = 20_000,
  ) {}

  pollIntervalSeconds(): number {
    return this.intervalSeconds;
  }

  async connect(): Promise<void> {
    const device = await this.getDeviceInfo();
    await this.getRealtimeData();
    this.logger.info(
      `Connected to ${device.name} at ${this.client.host} (${device.model})`,
    );
  }

  async disconnect(): Promise<void> {
    this.controller?.abort(new Error("Powerwall adapter disconnected"));
    try {
      await this.inFlight;
    } catch (error) {
      this.logger.debug(
        `Powerwall pending read ended during disconnect: ${
          error instanceof Error ? error.name : "error"
        }`,
      );
    }
    this.client.clearSession();
  }

  getRealtimeData(signal?: AbortSignal): Promise<EnergyData> {
    if (this.inFlight) return this.inFlight;
    const pending = this.readCycle(signal).finally(() => {
      this.inFlight = null;
      this.controller = null;
    });
    this.inFlight = pending;
    return pending;
  }

  private async readCycle(externalSignal?: AbortSignal): Promise<EnergyData> {
    const started = this.now();
    const controller = new AbortController();
    this.controller = controller;
    const signal = externalSignal
      ? AbortSignal.any([externalSignal, controller.signal])
      : controller.signal;
    const deadline = setTimeout(() =>
      controller.abort(
        new PowerwallGatewayConnectionError(
          `Powerwall poll exceeded ${this.cycleTimeoutMs}ms deadline`,
        ),
      ), this.cycleTimeoutMs);
    try {
      const data = await this.readTelemetry(signal);
      this.logger.debug(
        `Powerwall poll succeeded in ${this.now() - started}ms; in-flight=1`,
      );
      return data;
    } catch (error) {
      const failure = signal.aborted ? signal.reason : error;
      this.logger.debug(
        `Powerwall poll failed in ${this.now() - started}ms; category=${
          failure instanceof Error ? failure.name : "unknown"
        }`,
      );
      throw failure;
    } finally {
      clearTimeout(deadline);
    }
  }

  private async readTelemetry(signal: AbortSignal): Promise<EnergyData> {
    signal.throwIfAborted();
    const aggregates = await this.client.getJson(AGGREGATES_PATH, signal);
    signal.throwIfAborted();
    const soe = await this.client.getJson(SOE_PATH, signal);
    signal.throwIfAborted();
    const meters = metersFrom(aggregates);
    const nowMs = this.now();
    assertFresh(meters, nowMs, this.maxStalenessSeconds);

    return {
      solarProductionW: Math.max(0, Math.round(powerAt(meters.solar, "solar"))),
      gridPowerW: Math.round(powerAt(meters.site, "site")),
      homeConsumptionW: Math.max(0, Math.round(powerAt(meters.load, "load"))),
      batteryPowerW: Math.round(powerAt(meters.battery, "battery")),
      batterySoc: batterySocFrom(soe),
      gridVoltageV: gridVoltageFrom(meters.site),
      lastUpdated: new Date(nowMs).toISOString(),
    };
  }

  async getDeviceInfo(): Promise<DeviceInfo> {
    const status = recordAt(await this.client.getStatus(), "gateway status");
    const din = typeof status.din === "string" ? status.din : this.client.host;
    const version = typeof status.version === "string"
      ? status.version
      : "Unknown firmware";
    return {
      id: din,
      name: "Tesla Energy Gateway",
      manufacturer: "Tesla",
      model: version,
    };
  }
}
