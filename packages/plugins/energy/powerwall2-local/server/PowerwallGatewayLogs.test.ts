import { EnergyPoller } from "../../../../server/src/services/EnergyPoller.ts";
import { TypedEventEmitter } from "../../../../server/src/services/TypedEventEmitter.ts";
import type { EnergyAdapterManager } from "@chargeha/server/services/EnergyAdapterManager";
import type { ChargingPointManager } from "@chargeha/server/services/ChargingPointManager";
import { throwingMock } from "../../../../server/src/test-helpers/throwingMock.ts";
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { pluginHarness } from "./test-helpers/pluginHarness.ts";
import {
  aggregates,
  FakePowerwallApi,
  NOW,
} from "./test-helpers/powerwallApi.ts";
import { PowerwallGatewayAdapter } from "./PowerwallGatewayAdapter.ts";
import { LogService } from "../../../../server/src/services/LogService.ts";

describe("Powerwall persisted plugin failures", () => {
  it("exposes safe connect/direct-poll failures to Logs, throttles repeats and skips cancellation", async () => {
    const { db, deps } = await pluginHarness();
    const clock = { now: NOW };
    const api = new FakePowerwallApi(
      new Error("body: password=synthetic-private"),
    );
    const adapter = new PowerwallGatewayAdapter(
      api,
      60,
      deps.log,
      () => clock.now,
      30,
      deps.dbLog,
    );
    try {
      await expect(adapter.connect()).rejects.toThrow("synthetic-private");
      await expect(adapter.getRealtimeData()).rejects.toThrow();
      const logs = new LogService(db);
      const initial = await logs.getPluginLogs({
        pluginId: "powerwall2_local",
      });
      expect(initial.total).toBe(1);
      expect(JSON.stringify(initial)).not.toContain("synthetic-private");
      clock.now += 300_000;
      await expect(adapter.getRealtimeData()).rejects.toThrow();
      expect((await logs.getPluginLogs({ pluginId: "powerwall2_local" })).total)
        .toBe(2);
      const controller = new AbortController();
      controller.abort(new Error("cancelled"));
      await expect(adapter.getRealtimeData(controller.signal)).rejects.toThrow(
        "cancelled",
      );
      expect((await logs.getPluginLogs({ pluginId: "powerwall2_local" })).total)
        .toBe(2);
      api.aggregateResponse = aggregates();
    } finally {
      await adapter.disconnect();
      db.close();
    }
  });
  it("writes one scheduled failure through the real poller, not duplicate adapter/core rows", async () => {
    const { db, deps } = await pluginHarness();
    const api = new FakePowerwallApi(new Error("offline"));
    const adapter = new PowerwallGatewayAdapter(
      api,
      60,
      deps.log,
      () => NOW,
      30,
      deps.dbLog,
    );
    const emitter = new TypedEventEmitter();
    const failed = Promise.withResolvers<void>();
    emitter.subscribe("energy_poll_failure", () => failed.resolve());
    const poller = new EnergyPoller(
      throwingMock<EnergyAdapterManager>("EnergyAdapterManager", {
        activePluginId: "powerwall2_local",
        ready: () => Promise.resolve(),
        isRelevantConfigKey: () => false,
        pollIntervalSeconds: () => 30,
        getRealtimeData: (_load, signal) => adapter.getRealtimeData(signal),
      }),
      throwingMock<ChargingPointManager>("ChargingPointManager", {
        getChargingLoadW: () => Promise.resolve({ meteredW: 0, unmeteredW: 0 }),
      }),
      emitter,
      db,
      deps.log,
    );
    try {
      await failed.promise;
      const logs = await new LogService(db).getPluginLogs({
        pluginId: "powerwall2_local",
      });
      expect(logs.total).toBe(1);
      expect(logs.logs[0].message).toContain("Poll failed");
    } finally {
      await poller.stop();
      await adapter.disconnect();
      db.close();
    }
  });
});
