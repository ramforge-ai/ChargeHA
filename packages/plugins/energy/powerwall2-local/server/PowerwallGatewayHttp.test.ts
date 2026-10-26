import { describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { expect } from "@std/expect";
import { makeNodeHttpsPowerwallHttp } from "./PowerwallGatewayClient.ts";
import { httpsHarness } from "./test-helpers/httpsHarness.ts";

describe("Powerwall HTTPS transport", () => {
  it("uses scoped self-signed TLS and combines response chunks", async () => {
    const harness = httpsHarness("success");
    try {
      const response = await makeNodeHttpsPowerwallHttp().request(
        "192.0.2.10",
        "/test",
        "POST",
        { "Content-Type": "application/json" },
        "{}",
      );
      expect(response).toEqual({
        status: 200,
        body: '{"ok":true}',
        setCookies: ["AuthCookie=test; Path=/"],
      });
      expect(harness.options[0]).toMatchObject({
        hostname: "192.0.2.10",
        port: 443,
        rejectUnauthorized: false,
        timeout: 10_000,
      });
      expect(harness.writes).toEqual(["{}"]);
      expect(harness.options[0].agent).toMatchObject({
        keepAlive: true,
        maxSockets: 1,
        maxTotalSockets: 1,
        maxFreeSockets: 1,
      });
    } finally {
      harness.restore();
    }
  });
  it("destroys timed-out requests and rejects with a bounded error", async () => {
    const harness = httpsHarness("timeout");
    try {
      await expect(
        makeNodeHttpsPowerwallHttp(20).request(
          "192.0.2.10",
          "/test",
          "GET",
          {},
        ),
      ).rejects.toThrow("timed out after 20ms");
      expect(harness.state.destroyed).toBe(true);
    } finally {
      harness.restore();
    }
  });
  it("rejects connection errors", async () => {
    const harness = httpsHarness("error");
    try {
      await expect(
        makeNodeHttpsPowerwallHttp().request("192.0.2.10", "/test", "GET", {}),
      ).rejects.toThrow("transport connection failed");
    } finally {
      harness.restore();
    }
  });
  it("rejects an interrupted response instead of leaving a pending promise", async () => {
    const harness = httpsHarness("interrupted");
    try {
      await expect(
        makeNodeHttpsPowerwallHttp().request("192.0.2.10", "/test", "GET", {}),
      ).rejects.toThrow("response interrupted");
    } finally {
      harness.restore();
    }
  });
  it("aborts a request and clears its wall-clock timer", async () => {
    const harness = httpsHarness("hang");
    const controller = new AbortController();
    try {
      const result = makeNodeHttpsPowerwallHttp().request(
        "192.0.2.10",
        "/test",
        "GET",
        {},
        undefined,
        controller.signal,
      );
      const rejected = expect(result).rejects.toThrow("cancelled");
      controller.abort();
      await rejected;
      expect(harness.state.destroyed).toBe(true);
    } finally {
      harness.restore();
    }
  });
  it("times out a stalled request even when no socket timeout event arrives", async () => {
    const time = new FakeTime();
    const harness = httpsHarness("hang");
    try {
      const result = makeNodeHttpsPowerwallHttp(100).request(
        "192.0.2.10",
        "/test",
        "GET",
        {},
      );
      const rejected = expect(result).rejects.toThrow("100ms");
      time.tick(100);
      await rejected;
      expect(harness.state.destroyed).toBe(true);
    } finally {
      harness.restore();
      time.restore();
    }
  });
  it("ignores retired request/response events while a replacement is active", async () => {
    const harness = httpsHarness("hang");
    const http = makeNodeHttpsPowerwallHttp();
    const read = () => http.request("192.0.2.10", "/test", "GET", {});
    try {
      const failed = expect(read()).rejects.toThrow("10000ms");
      const retired = harness.exchanges[0];
      retired.request.emit("timeout");
      await failed;
      const replacement = read();
      expect(harness.options[1].agent).not.toBe(harness.options[0].agent);
      retired.request.emit("error", new Error("late transport error"));
      retired.request.emit("timeout");
      retired.reply();
      retired.response.emit("aborted");
      retired.response.emit("end");
      expect(retired.destroyed).toEqual({ requests: 1, responses: 1 });
      expect(harness.exchanges[1].destroyed.requests).toBe(0);
      harness.exchanges[1].finish();
      expect((await replacement).status).toBe(200);
      const next = read();
      expect(harness.options[2].agent).toBe(harness.options[1].agent);
      harness.exchanges[2].finish();
      expect((await next).status).toBe(200);
      expect(harness.exchanges).toHaveLength(3);
    } finally {
      http.close?.();
      harness.restore();
    }
  });

  it("issues nothing on pre-abort and does not recreate pools from close callbacks", async () => {
    const time = new FakeTime();
    const harness = httpsHarness("hang");
    const http = makeNodeHttpsPowerwallHttp();
    const controller = new AbortController();
    controller.abort();
    try {
      http.close?.();
      await expect(
        http.request(
          "192.0.2.10",
          "/test",
          "GET",
          {},
          undefined,
          controller.signal,
        ),
      ).rejects.toThrow("cancelled");
      expect(harness.options).toHaveLength(0);
      const active = expect(http.request("192.0.2.10", "/active", "GET", {}))
        .rejects.toThrow("cancelled");
      const queued = expect(http.request("192.0.2.10", "/queued", "GET", {}))
        .rejects.toThrow("cancelled");
      http.close?.();
      http.close?.();
      await Promise.all([active, queued]);
      harness.exchanges.map((exchange) => {
        exchange.request.emit("timeout");
        exchange.reply();
        expect(exchange.destroyed).toEqual({ requests: 1, responses: 1 });
      });
      time.tick(20_000);
      expect(harness.options).toHaveLength(2);
      const reused = http.request("192.0.2.10", "/reused", "GET", {});
      expect(harness.options[2].agent).not.toBe(harness.options[0].agent);
      harness.exchanges[2].finish();
      expect((await reused).status).toBe(200);
    } finally {
      http.close?.();
      harness.restore();
      time.restore();
    }
  });
});
