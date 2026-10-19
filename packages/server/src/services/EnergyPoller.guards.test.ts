import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FakeTime } from "@std/testing/time";
import { buildEnergyData } from "@chargeha/shared/test-factories";
import type { AppDatabase } from "../db/AppDatabase.ts";
import type { ChargingPointManager } from "./ChargingPointManager.ts";
import { EnergyPoller } from "./EnergyPoller.ts";
import { TypedEventEmitter } from "./TypedEventEmitter.ts";
import { Logger } from "../lib/Logger.ts";
import { MockEnergyPollerAdapter } from "../test-helpers/MockEnergyPollerAdapter.ts";
import { throwingMock } from "../test-helpers/throwingMock.ts";
import { testable } from "../test-helpers/Testable.ts";

describe("Energy poll scheduling guards", () => {
  let time: FakeTime;
  let adapter: MockEnergyPollerAdapter;
  let emitter: TypedEventEmitter;
  let poller: EnergyPoller;
  let events: string[];
  const sample = () => buildEnergyData();
  const create = () =>
    new EnergyPoller(
      adapter.asManager(),
      throwingMock<ChargingPointManager>("ChargingPointManager", {
        getChargingLoadW: () => Promise.resolve({ meteredW: 0, unmeteredW: 0 }),
      }),
      emitter,
      throwingMock<AppDatabase>("AppDatabase", {
        getConfig: () => Promise.resolve("UTC"),
        getTodayEnergySummary: () =>
          Promise.resolve({ solarWh: 0, gridImportWh: 0, gridExportWh: 0 }),
      }),
      new Logger("PollerGuards", "error"),
    );
  beforeEach(async () => {
    time = new FakeTime();
    adapter = new MockEnergyPollerAdapter(sample());
    adapter.deferred = true;
    emitter = new TypedEventEmitter();
    events = [];
    emitter.subscribe("energy_update", () => events.push("update"));
    emitter.subscribe("energy_poll_success", () => events.push("success"));
    emitter.subscribe("energy_poll_failure", () => events.push("failure"));
    poller = create();
    await adapter.waitForRead(1);
  });
  afterEach(async () => {
    const stopping = poller.stop();
    adapter.reads.forEach((read) => read.resolve(sample()));
    await stopping;
    time.restore();
  });
  it("never overlaps and waits a full ordinary interval after success or failure", async () => {
    time.tick(120_000);
    expect(adapter.reads).toHaveLength(1);
    const first = testable(poller).polling;
    adapter.reads[0].reject(new Error("offline"));
    await first;
    expect(poller.getRealtimeSnapshot().realtime.pollFailed).toBe(true);
    time.tick(9999);
    expect(adapter.reads).toHaveLength(1);
    time.tick(1);
    await adapter.waitForRead(2);
    const second = testable(poller).polling;
    adapter.reads[1].resolve(sample());
    await second;
    time.tick(9999);
    expect(adapter.reads).toHaveLength(2);
    time.tick(1);
    await adapter.waitForRead(3);
    expect(adapter.reads[2].signal).toBe(adapter.reads[1].signal);
  });
  it("cancels and drains late success without publishing or rescheduling", async () => {
    const stopping = poller.stop();
    expect(adapter.reads[0].signal?.aborted).toBe(true);
    adapter.reads[0].resolve(sample());
    await stopping;
    expect(poller.tryGetRealtimeSnapshot()).toBeNull();
    expect(events).toEqual([]);
    time.tick(300_000);
    expect(adapter.reads).toHaveLength(1);
  });
  it("serializes simultaneous restarts and drains each old loop", async () => {
    const first = poller.restart();
    const second = poller.restart();
    adapter.reads[0].resolve(sample());
    await first;
    // The second restart may have entered a read before its queued drain.
    adapter.reads.slice(1).forEach((read) => read.resolve(sample()));
    await second;
    await adapter.waitForRead(adapter.reads.length);
    expect(events).toEqual([]);
    expect(adapter.reads.filter((read) => !read.signal?.aborted)).toHaveLength(
      1,
    );
  });
  it("drains late failure before config rebuild and coalesces one save", async () => {
    emitter.emit("config_changed", { key: "test.host" });
    emitter.emit("config_changed", { key: "test.password" });
    await Promise.resolve(); // The documented config coalescing microtask.
    expect(adapter.reads[0].signal?.aborted).toBe(true);
    expect(adapter.reconfigurations).toEqual([]);
    adapter.reads[0].reject(new Error("late failure"));
    await adapter.waitForRead(2);
    expect(adapter.reconfigurations).toEqual([1]);
    expect(events).toEqual([]);
  });
  it("stop dominates config queued before its microtask", async () => {
    emitter.emit("config_changed", { key: "test.host" });
    const stopping = poller.stop();
    adapter.reads[0].resolve(sample());
    await stopping;
    await poller.restart();
    expect(adapter.reconfigurations).toEqual([]);
    expect(adapter.reads).toHaveLength(1);
  });
  it("stop dominates in-progress reconfigure and queued restart", async () => {
    const gate = Promise.withResolvers<void>();
    adapter.reconfigureGate = gate.promise;
    const restarting = poller.restart(() => adapter.reconfigure());
    adapter.reads[0].resolve(sample());
    await adapter.reconfigureEntered.promise;
    const queued = poller.restart(() => adapter.reconfigure());
    const stopping = poller.stop();
    gate.resolve();
    await Promise.all([restarting, queued, stopping]);
    expect(adapter.reconfigurations).toEqual([1]);
    expect(adapter.reads).toHaveLength(1);
    expect(events).toEqual([]);
  });
  it("stop dominates startup readiness", async () => {
    const stopping = poller.stop();
    adapter.reads[0].resolve(sample());
    await stopping;
    adapter = new MockEnergyPollerAdapter(sample());
    adapter.deferred = true;
    const gate = Promise.withResolvers<void>();
    adapter.readyGate = gate.promise;
    poller = create();
    await adapter.readyEntered.promise;
    const stopped = poller.stop();
    gate.resolve();
    await stopped;
    expect(adapter.reads).toHaveLength(0);
    expect(events).toEqual([]);
  });
});
