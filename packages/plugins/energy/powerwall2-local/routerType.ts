import type { createAppRouter } from "../../../server/src/trpc/root.ts";
import type { createPowerwallGatewayRouter } from "./server/router.ts";

export type PowerwallGatewayAppRouter = ReturnType<
  typeof createAppRouter<
    Record<string, never>,
    { powerwall2_local: ReturnType<typeof createPowerwallGatewayRouter> },
    Record<string, never>
  >
>;
