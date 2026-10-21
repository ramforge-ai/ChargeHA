import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Logger } from "@chargeha/server/lib/Logger";
import { Powerwall2LocalAdapter } from "./Powerwall2LocalAdapter.ts";
import {
  aggregates,
  FakePowerwallApi,
  meter,
  NOW,
} from "./test-helpers/powerwallApi.ts";

describe("Powerwall Gateway usable battery percentage", () => {
  const read = (percentage: unknown, batteryPower = 0) => {
    const api = new FakePowerwallApi(
      aggregates({ battery: meter(batteryPower) }),
    );
    api.soeResponse = { percentage };
    return new Powerwall2LocalAdapter(
      api,
      60,
      new Logger("test", "error"),
      () => NOW,
    ).getRealtimeData();
  };

  it("reports 20% usable capacity for the 24% raw reserve observation", async () => {
    await expect(read(24)).resolves.toMatchObject({
      batterySoc: 20,
      batteryPowerW: 0,
    });
  });

  [0, 2.5, 5].forEach((raw) => {
    it(`reports zero usable capacity at raw ${raw}%`, async () => {
      expect((await read(raw)).batterySoc).toBe(0);
    });
  });

  [[5.95, 1], [52.5, 50], [99.05, 99], [100, 100]].forEach(
    ([raw, usable]) => {
      it(`maps raw ${raw}% to usable ${usable}%`, async () => {
        expect((await read(raw)).batterySoc).toBeCloseTo(usable, 10);
      });
    },
  );

  it("retains fractional precision instead of rounding telemetry", async () => {
    expect((await read(82.4)).batterySoc).toBeCloseTo(81.47368421052632, 10);
  });

  [-4100, 1500].forEach((power) => {
    it(`does not infer or suppress signed battery power ${power}W from SOC`, async () => {
      await expect(read(24, power)).resolves.toMatchObject({
        batterySoc: 20,
        batteryPowerW: power,
      });
    });
  });

  [-1, 100.01, NaN, Infinity, -Infinity, "24", null, undefined].forEach(
    (raw) => {
      it(`rejects invalid raw SOC ${String(raw)} before scaling`, async () => {
        await expect(read(raw)).rejects.toThrow("invalid battery");
      });
    },
  );
});
