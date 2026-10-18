import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FakeTime } from "@std/testing/time";
import { stub } from "@std/testing/mock";
import {
  flushPoller,
  guardedPollerHarness,
  guardedSample,
} from "../test-helpers/GuardedPollerHarness.ts";
import { energyRetryDelayMs } from "./energyRetryDelayMs.ts";

describe("Energy poll scheduling guards", () => {
  let time: FakeTime;
  let ctx: ReturnType<typeof guardedPollerHarness>;
  beforeEach(async () => {
    time = new FakeTime();
    ctx = guardedPollerHarness();
    await flushPoller();
  });
  afterEach(async () => {
    const stopping = ctx.poller.stop();
    ctx.reads.forEach((read) => read.resolve(guardedSample()));
    await stopping;
    time.restore();
  });
  it("never overlaps a slow poll and waits a full interval after completion", async () => {
    time.tick(120_000);
    await flushPoller();
    expect(ctx.reads).toHaveLength(1);
    ctx.reads[0].resolve(guardedSample());
    await flushPoller();
    time.tick(9999);
    await flushPoller();
    expect(ctx.reads).toHaveLength(1);
    time.tick(1);
    await flushPoller();
    expect(ctx.reads).toHaveLength(2);
  });
  it("cancels and drains a poll before stop returns; stale results cannot publish", async () => {
    const stopping = ctx.poller.stop();
    expect(ctx.reads[0].signal?.aborted).toBe(true);
    ctx.reads[0].resolve(guardedSample());
    await stopping;
    expect(ctx.poller.tryGetRealtimeSnapshot()).toBeNull();
    expect(ctx.emitter.events).toHaveLength(0);
    time.tick(300_000);
    await flushPoller();
    expect(ctx.reads).toHaveLength(1);
  });
  it("serializes simultaneous restarts without starting duplicate loops", async () => {
    const first = ctx.poller.restart();
    const second = ctx.poller.restart();
    ctx.reads[0].resolve(guardedSample());
    await Promise.all([first, second]);
    await flushPoller();
    expect(ctx.reads).toHaveLength(2);
    expect(ctx.emitter.events).toHaveLength(0);
  });
  it("waits for the old poll before rebuilding a configured adapter", async () => {
    ctx.emitter.emit("config_changed", { key: "test.host" });
    await flushPoller();
    expect(ctx.reads[0].signal?.aborted).toBe(true);
    expect(ctx.reconfigurations).toHaveLength(0);
    ctx.reads[0].reject(new Error("cancelled old adapter"));
    await flushPoller();
    expect(ctx.reconfigurations).toEqual([1]);
    expect(ctx.reads).toHaveLength(2);
    expect(ctx.emitter.events.filter((event) => event.type === "energy_update"))
      .toHaveLength(0);
  });
  it("does not let a queued config change restart a stopped poller", async () => {
    ctx.emitter.emit("config_changed", { key: "test.host" });
    const stopping = ctx.poller.stop();
    ctx.reads[0].resolve(guardedSample());
    await stopping;
    await flushPoller();
    expect(ctx.reconfigurations).toHaveLength(0);
    expect(ctx.reads).toHaveLength(1);
    time.tick(300_000);
    await flushPoller();
    expect(ctx.reads).toHaveLength(1);
  });
  it("backs off failed polls, exposes failure during cooldown, resets on recovery", async () => {
    const random = stub(Math, "random", () => 0);
    try {
      await [30_000, 60_000, 120_000, 300_000].reduce<Promise<void>>(
        async (previous, delay, index) => {
          await previous;
          ctx.reads[index].reject(new Error("offline"));
          await flushPoller();
          expect(ctx.poller.getRealtimeSnapshot().realtime.pollFailed).toBe(
            true,
          );
          time.tick(delay - 1);
          await flushPoller();
          expect(ctx.reads).toHaveLength(index + 1);
          time.tick(1);
          await flushPoller();
          expect(ctx.reads).toHaveLength(index + 2);
        },
        Promise.resolve(),
      );
      ctx.reads[4].resolve(guardedSample());
      await flushPoller();
      expect(ctx.poller.getRealtimeSnapshot().realtime.pollFailed)
        .toBeUndefined();
      time.tick(10_000);
      await flushPoller();
      expect(ctx.reads).toHaveLength(6);
      ctx.reads[5].reject(new Error("new outage"));
      await flushPoller();
      time.tick(30_000);
      await flushPoller();
      expect(ctx.reads).toHaveLength(7);
    } finally {
      random.restore();
    }
  });
  it("bounds jitter and server hints without retrying before the hint", () => {
    const limited = Object.assign(new Error("rate limited"), {
      retryAfterMs: 600_000,
    });
    expect(energyRetryDelayMs(limited, 1, () => 0)).toBe(600_000);
    expect(energyRetryDelayMs(new Error(), 1, () => 1)).toBe(33_000);
    expect(energyRetryDelayMs(new Error(), 9, () => 1)).toBe(300_000);
    expect(
      energyRetryDelayMs(
        Object.assign(new Error(), { retryAfterMs: Infinity }),
        1,
        () => 0,
      ),
    ).toBe(30_000);
  });
});
