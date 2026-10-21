import {
  DEFAULT_POWERWALL_MAX_STALENESS_SECONDS,
  DEFAULT_POWERWALL_POLL_INTERVAL_SECONDS,
} from "../server/config.ts";
import { createElement } from "react";
import type { PluginConfigField } from "../../../hostUi.ts";
import { Powerwall2LocalPasswordHelp } from "./Powerwall2LocalPasswordHelp.tsx";

export const POWERWALL2_LOCAL_FIELDS: PluginConfigField[] = [
  {
    key: "host",
    label: "Gateway IP address",
    help:
      "LAN IP of the Tesla Gateway. Give it a DHCP reservation so this address stays fixed.",
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
      "Not your Tesla account password. Gateway 2 default: last five characters of the Password on the label behind its glass door (unless changed). Open the help below for details.",
    after: () => createElement(Powerwall2LocalPasswordHelp),
    secret: true,
    width: 160,
    required: true,
  },
  {
    key: "pollIntervalSeconds",
    label: "Polling interval (seconds)",
    help:
      "Wait between completed polls. Default 30 seconds; allowed range 10-60. Rate-limit/service responses trigger a local cooldown.",
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

export interface Powerwall2LocalValues {
  host: string;
  email: string;
  password: string;
  maxStalenessSeconds: string;
  pollIntervalSeconds: string;
}

export const valuesFrom = (
  values: Partial<Powerwall2LocalValues>,
): Powerwall2LocalValues => ({
  host: values.host ?? "",
  email: values.email ?? "",
  password: values.password ?? "",
  maxStalenessSeconds: values.maxStalenessSeconds ||
    String(DEFAULT_POWERWALL_MAX_STALENESS_SECONDS),
  pollIntervalSeconds: values.pollIntervalSeconds ||
    String(DEFAULT_POWERWALL_POLL_INTERVAL_SECONDS),
});
