import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Logger } from "@chargeha/server/lib/Logger";
import { PowerwallGatewayAdapter } from "./PowerwallGatewayAdapter.ts";
import { testPowerwallConnection } from "./testPowerwallConnection.ts";
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
    const result = await testPowerwallConnection(input, factory(api));
    expect(result.success).toBe(true);
    expect(api.clearCalls).toBe(1);
  });
  it("cleans up after a failed connection without returning fabricated telemetry", async () => {
    const api = new FakePowerwallApi(new Error("Connection refused"));
    expect(await testPowerwallConnection(input, factory(api))).toEqual({
      success: false,
      error: "Connection refused",
    });
    expect(api.clearCalls).toBe(1);
  });
});
