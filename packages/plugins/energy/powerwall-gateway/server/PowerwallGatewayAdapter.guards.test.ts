import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FakeTime } from "@std/testing/time";
import { Logger } from "@chargeha/server/lib/Logger";
import { PowerwallGatewayAdapter } from "./PowerwallGatewayAdapter.ts";
import {
  aggregates,
  FakePowerwallApi,
  NOW,
} from "./test-helpers/powerwallApi.ts";

class DeferredApi extends FakePowerwallApi {
  readonly requests: {
    path: string;
    signal?: AbortSignal;
    resolve: (data: unknown) => void;
    reject: (error: Error) => void;
  }[] = [];
  override getJson(path: string, signal?: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      this.requests.push({
        path,
        signal,
        resolve: (data) => {
          signal?.removeEventListener("abort", abort);
          resolve(data);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      });
    });
  }
}

describe("Powerwall poll containment", () => {
  const flush = () =>
    Array.from({ length: 10 }).reduce<Promise<void>>(
      (previous) => previous.then(() => {}),
      Promise.resolve(),
    );
  let time: FakeTime;
  let api: DeferredApi;
  let adapter: PowerwallGatewayAdapter;
  beforeEach(() => {
    time = new FakeTime(NOW);
    api = new DeferredApi(aggregates());
    adapter = new PowerwallGatewayAdapter(
      api,
      60,
      new Logger("PowerwallGuardTest", "error"),
    );
  });
  afterEach(async () => {
    await adapter.disconnect();
    time.restore();
  });

  it("shares an in-flight cycle and reads endpoints sequentially", async () => {
    const first = adapter.getRealtimeData();
    const second = adapter.getRealtimeData();
    expect(second).toBe(first);
    expect(api.requests.map((request) => request.path)).toEqual([
      "/api/meters/aggregates",
    ]);
    api.requests[0].resolve(aggregates());
    await flush();
    expect(api.requests.map((request) => request.path)).toEqual([
      "/api/meters/aggregates",
      "/api/system_status/soe",
    ]);
    api.requests[1].resolve({ percentage: 50 });
    expect((await first).batterySoc).toBeCloseTo(47.36842105263158, 10);
    await second;
  });
  it("does not launch a sibling after a failed aggregate read", async () => {
    const result = adapter.getRealtimeData();
    const rejected = expect(result).rejects.toThrow("offline");
    api.requests[0].reject(new Error("offline"));
    await rejected;
    expect(api.requests).toHaveLength(1);
  });
  it("enforces one deadline across both reads, not a fresh timeout for each", async () => {
    const result = adapter.getRealtimeData();
    const rejected = expect(result).rejects.toThrow("20000ms deadline");
    time.tick(15_000);
    api.requests[0].resolve(aggregates());
    await flush();
    expect(api.requests).toHaveLength(2);
    time.tick(5000);
    await rejected;
    expect(api.requests[1].signal?.aborted).toBe(true);
  });
  it("aborts the actual read on disconnect and drains it", async () => {
    const result = adapter.getRealtimeData();
    const rejected = expect(result).rejects.toThrow("disconnected");
    await adapter.disconnect();
    await rejected;
    expect(api.requests[0].signal?.aborted).toBe(true);
    expect(api.clearCalls).toBe(1);
  });
  it("propagates the poller's cancellation without starting another read", async () => {
    const controller = new AbortController();
    const result = adapter.getRealtimeData(controller.signal);
    const rejected = expect(result).rejects.toThrow("reconfigured");
    controller.abort(new Error("reconfigured"));
    await rejected;
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0].signal?.aborted).toBe(true);
  });
});
