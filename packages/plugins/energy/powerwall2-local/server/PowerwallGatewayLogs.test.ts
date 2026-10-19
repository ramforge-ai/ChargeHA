import { FakeTime } from "@std/testing/time";
import { testable } from "../../../../server/src/test-helpers/Testable.ts";
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
      await expect(adapter.connect()).rejects.toThrow("connection failed");
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
  it("bounds startup to connection and poll breadcrumbs; repeated scheduled failure is throttled", async () => {
    const { db, deps } = await pluginHarness();
    const api = new FakePowerwallApi(new Error("SYNTHETIC_PRIVATE_MARKER"));
    const adapter = new PowerwallGatewayAdapter(
      api,
      60,
      deps.log,
      () => NOW,
      30,
      deps.dbLog,
    );
    await expect(adapter.connect()).rejects.toThrow("connection failed");
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
      expect(logs.total).toBe(2);
      expect(JSON.stringify(logs)).not.toContain("SYNTHETIC_PRIVATE_MARKER");
      expect(JSON.stringify(poller.getRealtimeSnapshot())).not.toContain(
        "SYNTHETIC_PRIVATE_MARKER",
      );
      expect(logs.logs.some((row) => row.message.includes("Poll failed"))).toBe(
        true,
      );
      expect(
        logs.logs.some((row) =>
          row.message.includes("Powerwall connection failed")
        ),
      ).toBe(true);
      await testable(poller).poll(new AbortController().signal);
      expect(
        (await new LogService(db).getPluginLogs({
          pluginId: "powerwall2_local",
        })).total,
      ).toBe(2);
    } finally {
      await poller.stop();
      await adapter.disconnect();
      db.close();
    }
  });
  it("stop in success delivery suppresses the later recovery log", async () => {
    const { db, deps } = await pluginHarness();
    using time = new FakeTime();
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
    const stopped = Promise.withResolvers<void>();
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
    emitter.subscribe("energy_poll_success", () => {
      void poller.stop().then(stopped.resolve, stopped.reject);
    });
    try {
      await failed.promise;
      await testable(poller).polling;
      api.aggregateResponse = aggregates();
      time.tick(30000);
      await stopped.promise;
      const logs = await new LogService(db).getPluginLogs({
        pluginId: "powerwall2_local",
      });
      expect(logs.total).toBe(1);
      expect(JSON.stringify(logs)).not.toContain("recovered");
    } finally {
      await poller.stop();
      await adapter.disconnect();
      db.close();
    }
  });
});
