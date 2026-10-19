import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assertExists } from "@std/assert";
import { pluginHarness } from "./test-helpers/pluginHarness.ts";

describe("documented offline Powerwall ID migration", () => {
  const migrationSql = async () => {
    const doc = await Deno.readTextFile(
      new URL("../../../../../docs/powerwall2-local.md", import.meta.url),
    );
    const match = doc.match(/```sql\n([\s\S]*?)```/);
    assertExists(match);
    return match[1];
  };

  it("preserves encrypted bytes, all settings, selection and wizard progress; is idempotent", async () => {
    const { db, deps } = await pluginHarness();
    try {
      await db.setPluginConfig("powerwall_gateway.host", "192.0.2.10");
      await db.setPluginConfig("powerwall_gateway.email", "owner@example.com");
      await db.setPluginConfig("powerwall_gateway.max_staleness_seconds", "90");
      await db.setPluginConfig("powerwall_gateway.poll_interval_seconds", "45");
      await db.storeSecret("powerwall_gateway.password", "synthetic-secret");
      await db.setConfig("energy_adapter_type", "powerwall_gateway");
      await db.setConfig("wizard_energy_type", "powerwall_gateway");
      await db.setConfig("wizard_step", "powerwall-gateway-setup");
      const encrypted = await db.config.getSecret("powerwall_gateway.password");
      const sql = await migrationSql();
      db.getDriver().exec(sql);
      db.getDriver().exec(sql);
      expect(await deps.getConfig("host")).toBe("192.0.2.10");
      expect(await deps.getConfig("email")).toBe("owner@example.com");
      expect(await deps.getConfig("max_staleness_seconds")).toBe("90");
      expect(await deps.getConfig("poll_interval_seconds")).toBe("45");
      expect(await deps.getSecret("password")).toBe("synthetic-secret");
      expect(await db.config.getSecret("powerwall2_local.password")).toEqual(
        encrypted,
      );
      expect(await db.getConfig("energy_adapter_type")).toBe(
        "powerwall2_local",
      );
      expect(await db.getConfig("wizard_energy_type")).toBe("powerwall2_local");
      expect(await db.getConfig("wizard_step")).toBe("powerwall2-local-setup");
      expect(await db.getPluginConfig("powerwall_gateway.host")).toBeNull();
    } finally {
      db.close();
    }
  });
  it("fails on collisions and permits complete rollback without overwriting either value", async () => {
    const { db, deps } = await pluginHarness();
    try {
      await db.setPluginConfig("powerwall_gateway.host", "192.0.2.10");
      await deps.setConfig("host", "192.0.2.20");
      const sql = await migrationSql();
      expect(() => db.getDriver().exec(sql)).toThrow();
      db.getDriver().exec("ROLLBACK");
      expect(await deps.getConfig("host")).toBe("192.0.2.20");
      expect(await db.getPluginConfig("powerwall_gateway.host")).toBe(
        "192.0.2.10",
      );
    } finally {
      db.close();
    }
  });
});
