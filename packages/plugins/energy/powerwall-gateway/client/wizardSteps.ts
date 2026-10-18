import type { PluginStepDef } from "../../../hostUi.ts";
import type { EnergyPluginOption } from "../../../pluginOptions.ts";
import { powerwallGatewaySetupStep } from "./PowerwallGatewaySetupStep.tsx";

export const powerwallGatewayWizardSteps: PluginStepDef[] = [
  powerwallGatewaySetupStep,
];

export const powerwallGatewayOption: EnergyPluginOption = {
  id: "powerwall_gateway",
  label: "Tesla Powerwall Gateway",
  description:
    "Read aggregate solar, grid, household load and battery state directly from a Tesla Energy Gateway on your LAN.",
  iconKey: "server",
};
