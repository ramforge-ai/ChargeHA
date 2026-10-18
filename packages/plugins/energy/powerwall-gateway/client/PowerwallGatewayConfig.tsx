import { PluginConfigForm } from "../../../hostUi.ts";
import { trpc } from "./trpc.ts";
import {
  POWERWALL_GATEWAY_FIELDS,
  valuesFrom,
} from "./PowerwallGatewayFields.ts";
import { PowerwallGatewayTestResult } from "./PowerwallGatewayView.tsx";

function ConnectionTest({ values }: { values: Record<string, string> }) {
  const input = valuesFrom(values);
  const test = trpc.plugin.energy.powerwall_gateway.testConnection
    .useMutation();
  const tested: Record<string, string> | undefined = test.variables;
  const current = Object.entries(input).every(([key, value]) =>
    tested?.[key] === value
  );
  return (
    <PowerwallGatewayTestResult
      pending={test.isPending}
      disabled={!input.host || !input.password}
      onTest={() => test.mutate(input)}
      result={current && test.isSuccess ? test.data : undefined}
      error={current && test.isError ? test.error.message : undefined}
    />
  );
}

export function PowerwallGatewayConfig(): JSX.Element {
  const { data } = trpc.plugin.energy.powerwall_gateway.getConfig.useQuery();
  const utils = trpc.useUtils();
  const { mutate } = trpc.plugin.energy.powerwall_gateway.setConfig.useMutation(
    {
      onSuccess: () =>
        utils.plugin.energy.powerwall_gateway.getConfig.invalidate(),
    },
  );
  return (
    <PluginConfigForm
      data={data}
      fields={POWERWALL_GATEWAY_FIELDS}
      onSave={mutate}
      renderFooter={(values) => <ConnectionTest values={values} />}
    />
  );
}
