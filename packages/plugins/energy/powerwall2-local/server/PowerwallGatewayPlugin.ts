import type { AnyRouter } from "@trpc/server";
import type { EnergySourceAdapter } from "@chargeha/shared";
import type { PluginDependencies } from "@chargeha/server/bootstrap/PluginDependencies";
import type { EnergyPlugin, PluginHealthCheck } from "@chargeha/shared/plugins";
import {
  parseMaxStalenessSeconds,
  parsePollIntervalSeconds,
  POWERWALL_GATEWAY_SECRET_KEYS,
  type PowerwallGatewayConfig,
  powerwallGatewayConfigDef,
} from "./config.ts";
import { PowerwallGatewayClient } from "./PowerwallGatewayClient.ts";
import { PowerwallGatewayAdapter } from "./PowerwallGatewayAdapter.ts";
import { createPowerwallGatewayRouter } from "./router.ts";

export class PowerwallGatewayPlugin implements EnergyPlugin {
  readonly id = "powerwall2_local";
  readonly displayName = "Tesla Powerwall 2 (Local)";
  readonly vendor = "Tesla";
  readonly settingsComponentKey = "powerwall2-local-config";
  readonly configDef = powerwallGatewayConfigDef;
  readonly secretKeys = POWERWALL_GATEWAY_SECRET_KEYS;

  constructor(private readonly deps: PluginDependencies) {
    deps.log.info("Tesla Powerwall 2 (Local) plugin initialized");
  }

  async createAdapter(
    input?: PowerwallGatewayConfig,
  ): Promise<EnergySourceAdapter> {
    const host = input?.host ?? await this.deps.getConfig("host");
    const email = input?.email ?? await this.deps.getConfig("email") ?? "";
    const password = input?.password ?? await this.deps.getSecret("password") ??
      "";
    const freshness = input?.maxStalenessSeconds ??
      await this.deps.getConfig("max_staleness_seconds");
    const interval = input?.pollIntervalSeconds ??
      await this.deps.getConfig("poll_interval_seconds");
    if (!host) throw new Error("Powerwall Gateway host is not configured");
    return new PowerwallGatewayAdapter(
      new PowerwallGatewayClient(host, email, password),
      parseMaxStalenessSeconds(freshness),
      this.deps.log,
      Date.now,
      parsePollIntervalSeconds(interval),
      this.deps.dbLog,
    );
  }

  async testConnection(input: PowerwallGatewayConfig) {
    const adapter = await this.createAdapter(input);
    try {
      await adapter.connect();
      const device = await adapter.getDeviceInfo();
      const realtime = await adapter.getRealtimeData();
      return { success: true as const, device, realtime };
    } catch (error) {
      return {
        success: false as const,
        error: error instanceof Error ? error.message : "Connection failed",
      };
    } finally {
      await adapter.disconnect();
    }
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  getRouter(): AnyRouter {
    return createPowerwallGatewayRouter(this.deps, this);
  }

  getHealthChecks(): PluginHealthCheck[] {
    return [];
  }
}
