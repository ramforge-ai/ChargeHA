import type { EnergyData } from "@chargeha/shared";
import type { AppDatabase } from "../db/AppDatabase.ts";
import type { EnergyAdapterManager } from "../services/EnergyAdapterManager.ts";
import type { ChargingPointManager } from "../services/ChargingPointManager.ts";
import type { TypedEventEmitter } from "../services/TypedEventEmitter.ts";
import { EnergyPoller } from "../services/EnergyPoller.ts";
import { Logger } from "../lib/Logger.ts";
import { throwingMock } from "./throwingMock.ts";
import { MockEventEmitter } from "./MockEventEmitter.ts";

export const guardedSample = (): EnergyData => ({
  solarProductionW: 5000,
  gridPowerW: -2000,
  homeConsumptionW: 3000,
  batteryPowerW: 0,
  batterySoc: 50,
  gridVoltageV: 240,
  lastUpdated: new Date().toISOString(),
});

export async function flushPoller(): Promise<void> {
  await Array.from({ length: 30 }).reduce<Promise<void>>(
    (previous) => previous.then(() => {}),
    Promise.resolve(),
  );
}

export function guardedPollerHarness(
  ready = Promise.resolve(),
  pollIntervalSeconds = 10,
) {
  const reads: {
    signal?: AbortSignal;
    resolve: (data: EnergyData) => void;
    reject: (error: Error) => void;
  }[] = [];
  const reconfigurations: number[] = [];
  const manager = throwingMock<EnergyAdapterManager>("EnergyAdapterManager", {
    activePluginId: "test",
    ready: () => ready,
    isRelevantConfigKey: () => true,
    reconfigure: () => {
      reconfigurations.push(reads.length);
      return Promise.resolve();
    },
    pollIntervalSeconds: () => pollIntervalSeconds,
    getRealtimeData: (_load, signal) =>
      new Promise((resolve, reject) => reads.push({ signal, resolve, reject })),
  });
  const db = throwingMock<AppDatabase>("AppDatabase", {
    getConfig: () => Promise.resolve("Australia/Brisbane"),
    getTodayEnergySummary: () =>
      Promise.resolve({ solarWh: 0, gridImportWh: 0, gridExportWh: 0 }),
    insertPluginLog: () => Promise.resolve(),
  });
  const emitter = new MockEventEmitter();
  const poller = new EnergyPoller(
    manager,
    throwingMock<ChargingPointManager>("ChargingPointManager", {
      getChargingLoadW: () => Promise.resolve({ meteredW: 0, unmeteredW: 0 }),
    }),
    emitter as unknown as TypedEventEmitter,
    db,
    new Logger("GuardedPollerTest", "error"),
  );
  return { poller, reads, emitter, reconfigurations };
}
