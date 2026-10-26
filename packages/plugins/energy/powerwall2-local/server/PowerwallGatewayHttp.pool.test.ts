import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { makeNodeHttpsPowerwallHttp } from "./PowerwallGatewayClient.ts";
import { tlsHarness } from "./test-helpers/tlsHarness.ts";

describe("Powerwall HTTPS pool recovery (real TLS)", () => {
  it("retires a timed-out pool without replaying old work or losing healthy keepalive", async () => {
    const server = tlsHarness();
    const http = makeNodeHttpsPowerwallHttp();
    const read = (path: string, sequence: string) =>
      http.request("127.0.0.1", path, "GET", { "X-Test-Sequence": sequence });
    server.hold("/stall-2");
    try {
      expect((await read("/healthy-1", "1")).status).toBe(200);
      // Exercise the unchanged production ten-second wall-clock deadline.
      await expect(read("/stall-2", "2")).rejects.toThrow("10000ms");
      const recovered = await read("/healthy-3", "3");
      expect(JSON.parse(recovered.body)).toMatchObject({
        path: "/healthy-3",
        sequence: "3",
      });
      server.release("/stall-2");
      expect((await read("/healthy-4", "4")).status).toBe(200);
      expect(server.trace.map(({ path, sequence }) => [path, sequence]))
        .toEqual([
          ["/healthy-1", "1"],
          ["/stall-2", "2"],
          ["/healthy-3", "3"],
          ["/healthy-4", "4"],
        ]);
      expect(server.trace[0].port).toBe(server.trace[1].port);
      expect(server.trace[1].port).not.toBe(server.trace[2].port);
      expect(server.trace[2].port).toBe(server.trace[3].port);
    } finally {
      console.log("Synthetic TLS request trace:", JSON.stringify(server.trace));
      http.close?.();
      await server.close();
    }
  });
  it("rejects old queued requests on timeout without migrating or retrying them", async () => {
    const server = tlsHarness();
    const http = makeNodeHttpsPowerwallHttp(1000);
    const arrived = server.hold("/stalled");
    const first = http.request("127.0.0.1", "/stalled", "GET", {});
    const failed = expect(first).rejects.toThrow("1000ms");
    try {
      await arrived;
      const queued = expect(http.request("127.0.0.1", "/queued", "GET", {}))
        .rejects.toThrow("1000ms");
      await Promise.all([failed, queued]);
      expect(
        (await http.request("127.0.0.1", "/replacement", "GET", {})).status,
      )
        .toBe(200);
      server.release("/stalled");
      expect((await http.request("127.0.0.1", "/next", "GET", {})).status)
        .toBe(200);
      expect(server.trace.map((row) => row.path)).toEqual([
        "/stalled",
        "/replacement",
        "/next",
      ]);
    } finally {
      http.close?.();
      await server.close();
    }
  });

  ["abort", "close"].map((action) => {
    it(
      action + " settles active and queued work, then allows explicit reuse",
      async () => {
        const server = tlsHarness();
        const http = makeNodeHttpsPowerwallHttp();
        const controller = new AbortController();
        const arrived = server.hold("/active");
        const active = http.request(
          "127.0.0.1",
          "/active",
          "GET",
          {},
          undefined,
          controller.signal,
        );
        const activeRejected = expect(active).rejects.toThrow("cancelled");
        try {
          await arrived;
          const queuedRejected = expect(
            http.request("127.0.0.1", "/queued", "GET", {}),
          ).rejects.toThrow("cancelled");
          const preAborted = new AbortController();
          preAborted.abort();
          await expect(
            http.request(
              "127.0.0.1",
              "/pre-aborted",
              "GET",
              {},
              undefined,
              preAborted.signal,
            ),
          ).rejects.toThrow("cancelled");
          if (action === "abort") controller.abort();
          else {
            http.close?.();
            http.close?.();
          }
          await Promise.all([activeRejected, queuedRejected]);
          expect((await http.request("127.0.0.1", "/reused", "GET", {})).status)
            .toBe(200);
          server.release("/active");
          expect(
            (await http.request("127.0.0.1", "/after-release", "GET", {}))
              .status,
          ).toBe(200);
          expect(server.trace.map((row) => row.path)).toEqual([
            "/active",
            "/reused",
            "/after-release",
          ]);
        } finally {
          http.close?.();
          await server.close();
        }
      },
    );
  });
});
