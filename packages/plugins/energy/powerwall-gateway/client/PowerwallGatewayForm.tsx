import { useRef, useState } from "react";
import { trpc } from "./trpc.ts";
import {
  type PowerwallGatewayValues,
  valuesFrom,
} from "./PowerwallGatewayFields.ts";
import { PowerwallGatewayView } from "./PowerwallGatewayView.tsx";

export function PowerwallGatewayForm(
  { initial, onTestSuccess }: {
    initial: PowerwallGatewayValues;
    onTestSuccess: (values: PowerwallGatewayValues | null) => void;
  },
): JSX.Element {
  const [values, setValues] = useState(initial);
  const revision = useRef(0);
  const test = trpc.plugin.energy.powerwall_gateway.testConnection
    .useMutation();
  const input = valuesFrom(values);
  const onChange = (key: string, value: string) => {
    revision.current++;
    setValues((current) => ({ ...current, [key]: value }));
    test.reset();
    onTestSuccess(null);
  };
  const onTest = () => {
    const testedRevision = revision.current;
    onTestSuccess(null);
    test.mutate(input, {
      onSuccess: (result) => {
        if (
          result.success && revision.current === testedRevision
        ) onTestSuccess(input);
      },
    });
  };
  return (
    <PowerwallGatewayView
      values={input}
      onChange={onChange}
      onTest={onTest}
      pending={test.isPending}
      disabled={!input.host || !input.password}
      result={test.isSuccess ? test.data : undefined}
      error={test.isError ? test.error.message : undefined}
    />
  );
}
