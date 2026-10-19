import { PowerwallGatewayAuthError } from "./errors.ts";
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Logger } from "@chargeha/server/lib/Logger";
import { PowerwallGatewayAdapter } from "./PowerwallGatewayAdapter.ts";
import { stub } from "@std/testing/mock";
import { pluginHarness } from "./test-helpers/pluginHarness.ts";
import {
  aggregates,
  FakePowerwallApi,
  NOW,
} from "./test-helpers/powerwallApi.ts";

describe("Powerwall connection test lifecycle", () => {
  const input = {
    host: "192.0.2.10",
    email: "",
    password: "example",
    maxStalenessSeconds: "60",
    pollIntervalSeconds: "30",
  };
  const factory = (api: FakePowerwallApi) => () =>
    new PowerwallGatewayAdapter(
      api,
      60,
      new Logger("test", "error"),
      () => NOW,
    );

  it("returns device and telemetry and clears the temporary session", async () => {
    const api = new FakePowerwallApi(aggregates());
    api.soeResponse = { percentage: 24 };
    const ctx = await pluginHarness();
    using mocked = stub(
      ctx.plugin,
      "createAdapter",
      () => Promise.resolve(factory(api)()),
    );
    const result = await ctx.plugin.testConnection(input);
    ctx.db.close();
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("Expected successful connection");
    expect(result.realtime.batterySoc).toBe(20);
    expect(api.clearCalls).toBe(1);
    expect(mocked.calls).toHaveLength(1);
  });
  it("cleans up after a failed connection without returning fabricated telemetry", async () => {
    const api = new FakePowerwallApi(new Error("Connection refused"));
    const ctx = await pluginHarness();
    using mocked = stub(
      ctx.plugin,
      "createAdapter",
      () => Promise.resolve(factory(api)()),
    );
    expect(await ctx.plugin.testConnection(input)).toEqual({
      success: false,
      error:
        "Powerwall connection failed; check Gateway availability and credentials",
    });
    expect(api.clearCalls).toBe(1);
    expect(mocked.calls).toHaveLength(1);
    ctx.db.close();
  });
  it("returns a safe structured factory failure", async () => {
    const ctx = await pluginHarness();
    using mocked = stub(
      ctx.plugin,
      "createAdapter",
      () => Promise.reject(new Error("PRIVATE_FACTORY_MARKER")),
    );
    try {
      expect(await ctx.plugin.testConnection(input)).toEqual({
        success: false,
        error:
          "Powerwall connection failed; check Gateway availability and credentials",
      });
      expect(mocked.calls).toHaveLength(1);
    } finally {
      ctx.db.close();
    }
  });
  [true, false].forEach((connectFails) => {
    it(`cleanup failure preserves primary result (connectFails=${connectFails})`, async () => {
      const ctx = await pluginHarness();
      const api = new FakePowerwallApi(aggregates());
      const adapter = factory(api)();
      using mocked = stub(
        ctx.plugin,
        "createAdapter",
        () => Promise.resolve(adapter),
      );
      using connect = stub(
        adapter,
        "connect",
        () => {
          if (connectFails) {
            return Promise.reject(
              new PowerwallGatewayAuthError(
                "Powerwall Gateway rejected the configured customer credentials",
              ),
            );
          }
          return Promise.resolve();
        },
      );
      using disconnect = stub(
        adapter,
        "disconnect",
        () => Promise.reject(new Error("PRIVATE_CLEANUP_MARKER")),
      );
      try {
        const result = await ctx.plugin.testConnection(input);
        expect(result).toEqual({
          success: false,
          error: connectFails
            ? "Powerwall Gateway rejected the configured customer credentials"
            : "Powerwall connection-test cleanup failed",
        });
        expect(mocked.calls).toHaveLength(1);
        expect(connect.calls).toHaveLength(1);
        expect(disconnect.calls).toHaveLength(1);
      } finally {
        ctx.db.close();
      }
    });
  });
});
