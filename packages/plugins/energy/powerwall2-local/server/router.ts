import { z } from "zod";
import { publicProcedure, router } from "../../../../server/src/trpc/trpc.ts";
import type { PluginDependencies } from "@chargeha/server/bootstrap/PluginDependencies";
import { createPluginConfigProcedures } from "../../../createPluginConfigProcedures.ts";
import {
  DEFAULT_POWERWALL_POLL_INTERVAL_SECONDS,
  freshnessSchema,
  gatewayHostSchema,
  pollIntervalSchema,
  POWERWALL_GATEWAY_SECRET_KEYS,
  powerwallGatewayConfigDef,
} from "./config.ts";

import type { PowerwallGatewayPlugin } from "./PowerwallGatewayPlugin.ts";

const testConnectionInput = z.object({
  host: gatewayHostSchema,
  email: z.string(),
  password: z.string().min(1),
  maxStalenessSeconds: freshnessSchema,
  pollIntervalSeconds: pollIntervalSchema.default(
    String(DEFAULT_POWERWALL_POLL_INTERVAL_SECONDS),
  ),
});

export function createPowerwallGatewayRouter(
  deps: PluginDependencies,
  plugin: Pick<PowerwallGatewayPlugin, "testConnection">,
) {
  return router({
    ...createPluginConfigProcedures(
      deps,
      powerwallGatewayConfigDef,
      POWERWALL_GATEWAY_SECRET_KEYS,
    ),

    testConnection: publicProcedure
      .input(testConnectionInput)
      .mutation(({ input }) => plugin.testConnection(input)),
  });
}
