import type { AnyRouter } from "@trpc/server";
import type { EnergySourceAdapter } from "@chargeha/shared";
import type { PluginDependencies } from "@chargeha/server/bootstrap/PluginDependencies";
import type { EnergyPlugin, PluginHealthCheck } from "@chargeha/shared/plugins";
import {
  parseMaxStalenessSeconds,
  parsePollIntervalSeconds,
  POWERWALL_GATEWAY_SECRET_KEYS,
  powerwallGatewayConfigDef,
} from "./config.ts";
import { PowerwallGatewayClient } from "./PowerwallGatewayClient.ts";
import { PowerwallGatewayAdapter } from "./PowerwallGatewayAdapter.ts";
import { createPowerwallGatewayRouter } from "./router.ts";

export class PowerwallGatewayPlugin implements EnergyPlugin {
  readonly id = "powerwall_gateway";
  readonly displayName = "Tesla Powerwall Gateway";
  readonly vendor = "Tesla";
  readonly settingsComponentKey = "powerwall-gateway-config";
  readonly configDef = powerwallGatewayConfigDef;
  readonly secretKeys = POWERWALL_GATEWAY_SECRET_KEYS;

  constructor(private readonly deps: PluginDependencies) {
    deps.log.info("Tesla Powerwall Gateway plugin initialized");
  }

  async createAdapter(): Promise<EnergySourceAdapter> {
    const host = await this.deps.getConfig("host");
    const email = (await this.deps.getConfig("email")) ?? "";
    const password = (await this.deps.getSecret("password")) ?? "";
    const maxStalenessSeconds = parseMaxStalenessSeconds(
      await this.deps.getConfig("max_staleness_seconds"),
    );
    if (!host) throw new Error("Powerwall Gateway host is not configured");
    return new PowerwallGatewayAdapter(
      new PowerwallGatewayClient(host, email, password),
      maxStalenessSeconds,
      this.deps.log,
      Date.now,
      parsePollIntervalSeconds(
        await this.deps.getConfig("poll_interval_seconds"),
      ),
    );
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  getRouter(): AnyRouter {
    return createPowerwallGatewayRouter(this.deps);
  }

  getHealthChecks(): PluginHealthCheck[] {
    return [];
  }
}
