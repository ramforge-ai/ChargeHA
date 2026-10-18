import type { PluginConfigField } from "../../../hostUi.ts";

export const POWERWALL_GATEWAY_FIELDS: PluginConfigField[] = [
  {
    key: "host",
    label: "Gateway IP address",
    help:
      "LAN IP of the Tesla Energy Gateway. Give it a DHCP reservation so this address stays fixed.",
    placeholder: "192.0.2.10",
    width: 160,
    required: true,
  },
  {
    key: "email",
    label: "Tesla account email",
    help:
      "Email used by the Gateway's local customer login; no Tesla cloud login is performed.",
    placeholder: "you@example.com",
    width: 160,
  },
  {
    key: "password",
    label: "Gateway customer password",
    help:
      "Local customer password, not your Tesla account password. Gateway 2 default: last five characters of its label Password (unless changed).",
    secret: true,
    width: 160,
    required: true,
  },
  {
    key: "pollIntervalSeconds",
    label: "Polling interval (seconds)",
    help:
      "Wait between completed polls. Default 30 seconds; allowed range 10-60. Failed requests automatically back off.",
    width: 90,
    advanced: true,
    required: true,
  },
  {
    key: "maxStalenessSeconds",
    label: "Maximum telemetry age (seconds)",
    help:
      "Reject meter readings older than this. A failed poll is passed to ChargeHA's controller. Allowed range: 10-300 seconds.",
    width: 90,
    advanced: true,
    required: true,
  },
];

export interface PowerwallGatewayValues {
  [key: string]: string;
  host: string;
  email: string;
  password: string;
  maxStalenessSeconds: string;
  pollIntervalSeconds: string;
}

export const valuesFrom = (
  values: Record<string, string>,
): PowerwallGatewayValues => ({
  host: values.host ?? "",
  email: values.email ?? "",
  password: values.password ?? "",
  maxStalenessSeconds: values.maxStalenessSeconds || "60",
  pollIntervalSeconds: values.pollIntervalSeconds || "30",
});
