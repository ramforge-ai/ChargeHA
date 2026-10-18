import https from "node:https";
import type { RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { EventEmitter } from "node:events";
import { stub } from "@std/testing/mock";

export function httpsHarness(
  mode: "success" | "timeout" | "error" | "interrupted",
) {
  const options: RequestOptions[] = [];
  const writes: string[] = [];
  const request = new EventEmitter();
  const response = Object.assign(new EventEmitter(), {
    statusCode: 200,
    headers: { "set-cookie": ["AuthCookie=test; Path=/"] },
  });
  const state = { destroyed: false };
  const implementation =
    ((opts: RequestOptions, callback: (response: IncomingMessage) => void) => {
      options.push(opts);
      return Object.assign(request, {
        write: (body: string) => writes.push(body),
        destroy: (error: Error) => {
          state.destroyed = true;
          request.emit("error", error);
        },
        end: () =>
          queueMicrotask(() => {
            if (mode === "timeout") {
              request.emit("timeout");
              return;
            }
            if (mode === "error") {
              request.emit("error", new Error("ECONNREFUSED"));
              return;
            }
            callback(response as unknown as IncomingMessage);
            if (mode === "interrupted") {
              response.emit("error", new Error("aborted"));
              return;
            }
            response.emit("data", new TextEncoder().encode('{"ok":'));
            response.emit("data", new TextEncoder().encode("true}"));
            response.emit("end");
          }),
      }) as unknown as ClientRequest;
    }) as typeof https.request;
  const mocked = stub(https, "request", implementation);
  return { options, writes, state, restore: () => mocked.restore() };
}
