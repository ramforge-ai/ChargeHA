import { describe, it } from "@std/testing/bdd";
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
      ).rejects.toThrow("ECONNREFUSED");
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
});
