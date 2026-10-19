import { widenTrpc } from "../../../hostUi.ts";
import type { PowerwallGatewayAppRouter } from "../routerType.ts";

export const trpc = widenTrpc<PowerwallGatewayAppRouter>();
