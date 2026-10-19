import { useCallback, useState } from "react";
import { Spinner } from "../../../hostUi.ts";
import type { PluginStepDef, WizardNext } from "../../../hostUi.ts";
import { trpc } from "./trpc.ts";
import { PowerwallGatewayForm } from "./PowerwallGatewayForm.tsx";
import {
  type PowerwallGatewayValues,
  valuesFrom,
} from "./PowerwallGatewayFields.ts";

const nextState = (
  validated: PowerwallGatewayValues | null,
  save: (values: PowerwallGatewayValues) => Promise<void>,
): WizardNext => {
  if (!validated) {
    return {
      kind: "blocked",
      reason: "Test the Gateway connection to continue",
    };
  }
  return {
    kind: "ready",
    hint: "Next saves the tested Gateway connection",
    onNext: () => save(validated),
  };
};

export const powerwallGatewaySetupStep: PluginStepDef = {
  id: "powerwall2-local-setup",
  label: "Tesla Powerwall 2 (Local)",
  useStep: () => {
    const { data } = trpc.plugin.energy.powerwall2_local.getConfig.useQuery();
    const saveMutation = trpc.plugin.energy.powerwall2_local.setConfig
      .useMutation();
    const [validated, setValidated] = useState<PowerwallGatewayValues | null>(
      null,
    );
    const save = useCallback(
      async (values: PowerwallGatewayValues) => {
        await saveMutation.mutateAsync({ ...values });
      },
      [saveMutation],
    );
    if (!data) return { next: nextState(null, save), view: <Spinner /> };
    const initial = valuesFrom(data);
    return {
      next: nextState(validated, save),
      view: (
        <PowerwallGatewayForm
          initial={initial}
          onTestSuccess={setValidated}
        />
      ),
    };
  },
};
