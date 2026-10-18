import { Badge, Text } from "@radix-ui/themes";
import { CheckCircle } from "lucide-react";
import type { inferRouterOutputs } from "@trpc/server";
import type { PowerwallGatewayAppRouter } from "../routerType.ts";
import {
  FormError,
  PluginFieldInputs,
  PluginTestRow,
  stepStyles,
} from "../../../hostUi.ts";
import {
  POWERWALL_GATEWAY_FIELDS,
  type PowerwallGatewayValues,
} from "./PowerwallGatewayFields.ts";

type Result = inferRouterOutputs<
  PowerwallGatewayAppRouter
>["plugin"]["energy"]["powerwall_gateway"]["testConnection"];

export interface PowerwallTestProps {
  result?: Result;
  error?: string;
  pending: boolean;
  disabled: boolean;
  onTest: () => void;
}

export function PowerwallGatewayTestResult(props: PowerwallTestProps) {
  const success = props.result?.success ? props.result : null;
  const error = props.error ??
    (props.result?.success === false ? props.result.error : undefined);
  const kw = (watts: number | null) =>
    watts === null ? "—" : (watts / 1000).toFixed(1);
  return (
    <>
      <PluginTestRow
        pending={props.pending}
        disabled={props.disabled}
        onTest={props.onTest}
        status={success && (
          <Badge color="green" variant="soft" size="2">
            <CheckCircle size={12} />Connected — {success.device.model}
          </Badge>
        )}
      />
      <FormError message={error} />
      {success && (
        <Text size="1" color="gray">
          Solar {kw(success.realtime.solarProductionW)} kW · Home{" "}
          {kw(success.realtime.homeConsumptionW)} kW · Grid{" "}
          {kw(success.realtime.gridPowerW)} kW · Battery{" "}
          {kw(success.realtime.batteryPowerW)} kW /{" "}
          {success.realtime.batterySoc?.toFixed(0) ?? "—"}%
        </Text>
      )}
    </>
  );
}

/** Pure view shared by setup and the static component gallery. */
export function PowerwallGatewayView(
  { values, onChange, ...test }: PowerwallTestProps & {
    values: PowerwallGatewayValues;
    onChange: (key: string, value: string) => void;
  },
) {
  return (
    <div className={stepStyles.stepContainer}>
      <Text as="p" size="3" color="gray">
        Connect ChargeHA to the local Tesla Energy Gateway. This reads solar,
        grid, house and Powerwall flow; it does not change any Powerwall
        settings.
      </Text>
      <Text as="p" size="1" color="gray">
        Use the Gateway customer password, not your Tesla account password.
        Credentials are sent to the configured Gateway over HTTPS.
      </Text>
      <PluginFieldInputs
        fields={POWERWALL_GATEWAY_FIELDS}
        values={values}
        onChange={onChange}
        autoFocus
      />
      <PowerwallGatewayTestResult {...test} />
    </div>
  );
}
