import { z } from "zod";
import { publicProcedure, router } from "../../../../server/src/trpc/trpc.ts";
import type { PluginDependencies } from "@chargeha/server/bootstrap/PluginDependencies";
import { createPluginConfigProcedures } from "../../../createPluginConfigProcedures.ts";
import {
  POWERWALL_GATEWAY_SECRET_KEYS,
  powerwallGatewayConfigDef,
} from "./config.ts";
import { testPowerwallConnection } from "./testPowerwallConnection.ts";
import {
  freshnessSchema,
  gatewayHostSchema,
  pollIntervalSchema,
} from "./config.ts";

const testConnectionInput = z.object({
  host: gatewayHostSchema,
  email: z.string(),
  password: z.string().min(1),
  maxStalenessSeconds: freshnessSchema,
  pollIntervalSeconds: pollIntervalSchema.default("30"),
});

export function createPowerwallGatewayRouter(deps: PluginDependencies) {
  return router({
    ...createPluginConfigProcedures(
      deps,
      powerwallGatewayConfigDef,
      POWERWALL_GATEWAY_SECRET_KEYS,
    ),

    testConnection: publicProcedure
      .input(testConnectionInput)
      .mutation(({ input }) => testPowerwallConnection(input)),
  });
}
