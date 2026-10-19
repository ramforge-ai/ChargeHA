import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  pollingHarness,
  solarAggregates,
} from "./test-helpers/pollingHarness.ts";
import { meter, NOW } from "./test-helpers/powerwallApi.ts";

describe("Powerwall telemetry through poller and charging controller", () => {
  let ctx: Awaited<ReturnType<typeof pollingHarness>>;
  beforeEach(async () => {
    ctx = await pollingHarness();
  });
  afterEach(async () => {
    await ctx.close();
  });
  it("stops solar charging on stale telemetry and recovers on fresh data", async () => {
    await ctx.tick();
    expect(ctx.adapter.commands).toContainEqual({ cmd: "start" });
    ctx.adapter.commands = [];
    ctx.api.aggregateResponse = solarAggregates({
      solar: meter(7500, new Date(NOW - 61_000).toISOString()),
    });
    await ctx.tick();
    expect(ctx.poller.getRealtimeSnapshot().realtime).toMatchObject({
      pollFailed: true,
      solarProductionW: 0,
    });
    expect(ctx.adapter.commands).toContainEqual({ cmd: "stop" });
    ctx.adapter.commands = [];
    ctx.api.aggregateResponse = solarAggregates();
    await ctx.tick();
    expect(ctx.poller.getRealtimeSnapshot().realtime.pollFailed)
      .toBeUndefined();
    expect(ctx.adapter.commands).toContainEqual({ cmd: "start" });
  });
  it("does not start solar charging during a Gateway outage", async () => {
    ctx.api.aggregateResponse = new Error("Gateway unavailable");
    await ctx.tick();
    expect(ctx.adapter.commands).not.toContainEqual({ cmd: "start" });
    expect(ctx.poller.getRealtimeSnapshot().realtime.pollFailed).toBe(true);
    ctx.api.aggregateResponse = solarAggregates();
    await ctx.tick();
    expect(ctx.adapter.commands).toContainEqual({ cmd: "start" });
  });
  it("leaves explicit Charge Now independent of failed solar telemetry", async () => {
    await ctx.setMode("charge_now");
    ctx.api.aggregateResponse = new Error("Gateway unavailable");
    await ctx.tick();
    expect(ctx.poller.getRealtimeSnapshot().realtime.pollFailed).toBe(true);
    expect(ctx.adapter.commands).toContainEqual({ cmd: "start" });
  });
});
