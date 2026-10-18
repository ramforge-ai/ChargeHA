import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FakeTime } from "@std/testing/time";
import { stub } from "@std/testing/mock";
import {
  flushPoller,
  guardedPollerHarness,
  guardedSample,
} from "../test-helpers/GuardedPollerHarness.ts";

describe("Energy retry interval floor", () => {
  [60, 600].forEach((intervalSeconds) => {
    it(`never retries faster than a ${intervalSeconds}s adapter, including after recovery`, async () => {
      const time = new FakeTime();
      const random = stub(Math, "random", () => 0);
      const ctx = guardedPollerHarness(Promise.resolve(), intervalSeconds);
      try {
        await flushPoller();
        ctx.reads[0].reject(new Error("offline"));
        await flushPoller();
        expect(ctx.poller.getRealtimeSnapshot().realtime.pollFailed).toBe(true);
        time.tick(intervalSeconds * 1000 - 1);
        await flushPoller();
        expect(ctx.reads).toHaveLength(1);
        time.tick(1);
        await flushPoller();
        expect(ctx.reads).toHaveLength(2);
        ctx.reads[1].resolve(guardedSample());
        await flushPoller();
        expect(ctx.poller.getRealtimeSnapshot().realtime.pollFailed)
          .toBeUndefined();
        time.tick(intervalSeconds * 1000);
        await flushPoller();
        expect(ctx.reads).toHaveLength(3);
        ctx.reads[2].reject(new Error("new outage"));
        await flushPoller();
        time.tick(intervalSeconds * 1000 - 1);
        await flushPoller();
        expect(ctx.reads).toHaveLength(3);
        time.tick(1);
        await flushPoller();
        expect(ctx.reads).toHaveLength(4);
      } finally {
        const stopping = ctx.poller.stop();
        ctx.reads.forEach((read) => read.resolve(guardedSample()));
        await stopping;
        random.restore();
        time.restore();
      }
    });
  });
  it("applies the interval floor even when publishing a failure throws", async () => {
    const time = new FakeTime();
    const ctx = guardedPollerHarness(Promise.resolve(), 60);
    const emit = stub(ctx.emitter, "emit", () => {
      throw new Error("subscriber failed");
    });
    try {
      await flushPoller();
      ctx.reads[0].reject(new Error("offline"));
      await flushPoller();
      time.tick(59_999);
      await flushPoller();
      expect(ctx.reads).toHaveLength(1);
      time.tick(1);
      await flushPoller();
      expect(ctx.reads).toHaveLength(2);
    } finally {
      const stopping = ctx.poller.stop();
      ctx.reads.forEach((read) => read.resolve(guardedSample()));
      await stopping;
      emit.restore();
      time.restore();
    }
  });
  [
    { hintMs: 5000, expectedMs: 60_000 },
    { hintMs: 600_000, expectedMs: 600_000 },
  ].forEach(({ hintMs, expectedMs }) => {
    it(`combines a ${hintMs}ms server hint with a 60s adapter interval`, async () => {
      const time = new FakeTime();
      const random = stub(Math, "random", () => 0);
      const ctx = guardedPollerHarness(Promise.resolve(), 60);
      try {
        await flushPoller();
        ctx.reads[0].reject(
          Object.assign(new Error("rate limited"), { retryAfterMs: hintMs }),
        );
        await flushPoller();
        time.tick(expectedMs - 1);
        await flushPoller();
        expect(ctx.reads).toHaveLength(1);
        time.tick(1);
        await flushPoller();
        expect(ctx.reads).toHaveLength(2);
      } finally {
        const stopping = ctx.poller.stop();
        ctx.reads.forEach((read) => read.resolve(guardedSample()));
        await stopping;
        random.restore();
        time.restore();
      }
    });
  });
});
