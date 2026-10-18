import type { EnergySourceAdapter } from "@chargeha/shared";
import { Logger } from "@chargeha/server/lib/Logger";
import {
  parseMaxStalenessSeconds,
  parsePollIntervalSeconds,
  type PowerwallGatewayConfig,
} from "./config.ts";
import { PowerwallGatewayClient } from "./PowerwallGatewayClient.ts";
import { PowerwallGatewayAdapter } from "./PowerwallGatewayAdapter.ts";

const createAdapter = (input: PowerwallGatewayConfig): EnergySourceAdapter =>
  new PowerwallGatewayAdapter(
    new PowerwallGatewayClient(input.host, input.email, input.password),
    parseMaxStalenessSeconds(input.maxStalenessSeconds),
    new Logger("PowerwallGateway", "error"),
    Date.now,
    parsePollIntervalSeconds(input.pollIntervalSeconds),
  );

export async function testPowerwallConnection(
  input: PowerwallGatewayConfig,
  factory: (input: PowerwallGatewayConfig) => EnergySourceAdapter =
    createAdapter,
) {
  const adapter = factory(input);
  try {
    await adapter.connect();
    const device = await adapter.getDeviceInfo();
    const realtime = await adapter.getRealtimeData();
    return { success: true as const, device, realtime };
  } catch (err) {
    return {
      success: false as const,
      error: err instanceof Error ? err.message : "Connection failed",
    };
  } finally {
    await adapter.disconnect();
  }
}
