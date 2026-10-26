import https from "node:https";
import type { RequestOptions } from "node:https";
import type { IncomingMessage } from "node:http";
import { stub } from "@std/testing/mock";
import { tlsFixture } from "./tlsFixture.ts";

export function tlsHarness() {
  const trace: { path: string; sequence: string | null; port: number }[] = [];
  const holds = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<void>>
  >();
  const entered = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<void>>
  >();
  const controller = new AbortController();
  const server = Deno.serve({
    ...tlsFixture,
    hostname: "127.0.0.1",
    port: 0,
    signal: controller.signal,
    onListen: () => {},
  }, async (request, info) => {
    const path = new URL(request.url).pathname;
    const row = {
      path,
      sequence: request.headers.get("x-test-sequence"),
      port: info.remoteAddr.port,
    };
    trace.push(row);
    entered.get(path)?.resolve();
    await holds.get(path)?.promise;
    return Response.json(row);
  });
  const request = https.request;
  // Only route the fixed production port to an unprivileged ephemeral fixture.
  // The real ClientRequest, TLS and Agent (including its queue) are untouched.
  const routed = stub(
    https,
    "request",
    ((options: RequestOptions, callback: (response: IncomingMessage) => void) =>
      request(
        { ...options, port: server.addr.port },
        callback,
      )) as typeof https.request,
  );
  return {
    trace,
    hold(path: string) {
      holds.set(path, Promise.withResolvers<void>());
      const arrival = Promise.withResolvers<void>();
      entered.set(path, arrival);
      return arrival.promise;
    },
    release(path: string) {
      holds.get(path)?.resolve();
    },
    async close() {
      routed.restore();
      Array.from(holds.values()).map((gate) => gate.resolve());
      controller.abort();
      await server.finished;
    },
  };
}
