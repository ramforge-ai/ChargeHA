import https from "node:https";
import type { RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { EventEmitter } from "node:events";
import { throwingMock } from "../../../../../server/src/test-helpers/throwingMock.ts";
import { stub } from "@std/testing/mock";

export function httpsHarness(
  mode: "success" | "timeout" | "error" | "interrupted" | "hang",
) {
  const options: RequestOptions[] = [];
  const writes: string[] = [];
  const request = new EventEmitter();
  const response = new EventEmitter();
  const incoming: IncomingMessage = throwingMock<IncomingMessage>(
    "IncomingMessage",
    {
      statusCode: 200,
      headers: { "set-cookie": ["AuthCookie=test; Path=/"] },
      on: (event: string | symbol, listener: (...args: unknown[]) => void) => {
        response.on(event, listener);
        return incoming;
      },
    },
  );
  const state = { destroyed: false };
  const implementation =
    ((opts: RequestOptions, callback: (response: IncomingMessage) => void) => {
      options.push(opts);
      const outgoing: ClientRequest = throwingMock<ClientRequest>(
        "ClientRequest",
        {
          on: (
            event: string | symbol,
            listener: (...args: unknown[]) => void,
          ) => {
            request.on(event, listener);
            return outgoing;
          },
          write: (body) => {
            writes.push(String(body));
            return true;
          },
          destroy: (error: Error) => {
            state.destroyed = true;
            request.emit("error", error);
            return outgoing;
          },
          end: () => {
            queueMicrotask(() => {
              if (mode === "hang") return;
              if (mode === "timeout") {
                request.emit("timeout");
                return;
              }
              if (mode === "error") {
                request.emit("error", new Error("ECONNREFUSED"));
                return;
              }
              callback(incoming);
              if (mode === "interrupted") {
                response.emit("error", new Error("aborted"));
                return;
              }
              response.emit("data", new TextEncoder().encode('{"ok":'));
              response.emit("data", new TextEncoder().encode("true}"));
              response.emit("end");
            });
            return outgoing;
          },
        },
      );
      return outgoing;
    }) as typeof https.request;
  const mocked = stub(https, "request", implementation);
  return { options, writes, state, restore: () => mocked.restore() };
}
