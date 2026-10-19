import type { PluginStepDef } from "../../../hostUi.ts";
import type { EnergyPluginOption } from "../../../pluginOptions.ts";
import { powerwallGatewaySetupStep } from "./PowerwallGatewaySetupStep.tsx";

export const powerwallGatewayWizardSteps: PluginStepDef[] = [
  powerwallGatewaySetupStep,
];

export const powerwallGatewayOption: EnergyPluginOption = {
  id: "powerwall2_local",
  label: "Tesla Powerwall 2 (Local)",
  description:
    "Powerwall 2 with Backup Gateway 2 (tested). Gateway 1 untested. Powerwall 3 not supported. Read-only local solar, grid, home and battery telemetry.",
  iconKey: "server",
};
