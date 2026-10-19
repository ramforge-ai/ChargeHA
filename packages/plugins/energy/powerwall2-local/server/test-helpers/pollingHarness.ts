import { Logger } from "@chargeha/server/lib/Logger";
import { EnergyPoller } from "../../../../../server/src/services/EnergyPoller.ts";
import type { EnergyAdapterManager } from "@chargeha/server/services/EnergyAdapterManager";
import { ChargeController } from "../../../../../server/src/services/ChargeController.ts";
import { ConfigService } from "../../../../../server/src/services/ConfigService.ts";
import { setupController } from "../../../../../server/src/test-helpers/ChargeControllerHarness.ts";
import { throwingMock } from "../../../../../server/src/test-helpers/throwingMock.ts";
import { testable } from "../../../../../server/src/test-helpers/Testable.ts";
import { PowerwallGatewayAdapter } from "../PowerwallGatewayAdapter.ts";
import { aggregates, FakePowerwallApi, meter, NOW } from "./powerwallApi.ts";

export const solarAggregates = (overrides: Record<string, unknown> = {}) =>
  aggregates({ site: meter(-3500), battery: meter(0), ...overrides });

export async function pollingHarness() {
  const ctx = await setupController({}, "auto", null, {
    min_solar_generation_kw: "0.1",
    solar_tracking_mode: "solar_only",
  });
  const api = new FakePowerwallApi(solarAggregates());
  const log = new Logger("PowerwallIntegration", "error");
  const adapter = new PowerwallGatewayAdapter(api, 60, log, () => NOW);
  const manager = throwingMock<EnergyAdapterManager>("EnergyAdapterManager", {
    activePluginId: "powerwall2_local",
    ready: () => Promise.resolve(),
    isRelevantConfigKey: () => false,
    pollIntervalSeconds: () => 10,
    getRealtimeData: () => adapter.getRealtimeData(),
  });
  const poller = new EnergyPoller(
    manager,
    ctx.chargingPointManager,
    ctx.trackingEmitter,
    ctx.db,
    log,
  );
  await poller.stop();
  const controller = new ChargeController(
    ctx.manager,
    ctx.chargingPointManager,
    poller,
    ctx.db,
    new ConfigService(ctx.db, manager, null, log),
    ctx.trackingEmitter,
    log,
  );
  controller.stop();
  return {
    ...ctx,
    api,
    poller,
    controller,
    tick: async () => {
      await testable(poller).poll();
      await controller.runOnce();
    },
    close: async () => {
      controller.stop();
      await poller.stop();
      await adapter.disconnect();
      ctx.db.close();
    },
  };
}
