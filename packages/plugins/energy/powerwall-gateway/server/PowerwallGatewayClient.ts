import https from "node:https";

const REQUEST_TIMEOUT_MS = 10_000;
const LOGIN_PATH = "/api/login/Basic";

export class PowerwallGatewayAuthError extends Error {
  constructor(message: string, cause?: Error) {
    super(message, { cause });
    this.name = "PowerwallGatewayAuthError";
  }
}

export class PowerwallGatewayConnectionError extends Error {
  constructor(
    message: string,
    cause?: Error,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message, { cause });
    this.name = "PowerwallGatewayConnectionError";
  }
}

export interface PowerwallHttpResponse {
  status: number;
  body: string;
  setCookies: readonly string[];
  retryAfter?: string;
}

export interface PowerwallHttp {
  request(
    host: string,
    path: string,
    method: "GET" | "POST",
    headers: Record<string, string>,
    body?: string,
    signal?: AbortSignal,
  ): Promise<PowerwallHttpResponse>;
  close?(): void;
}

const concat = (chunks: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.length, 0),
  );
  chunks.reduce((offset, chunk) => {
    out.set(chunk, offset);
    return offset + chunk.length;
  }, 0);
  return out;
};

export const makeNodeHttpsPowerwallHttp = (
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): PowerwallHttp => {
  const agent = new https.Agent({
    keepAlive: true,
    maxSockets: 1,
    maxTotalSockets: 1,
    maxFreeSockets: 1,
  });
  return {
    close: () => agent.destroy(),
    request(host, path, method, headers, body, signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        const state = { settled: false };
        const req = https.request({
          hostname: host,
          port: 443,
          path,
          method,
          headers,
          agent,
          rejectUnauthorized: false,
          timeout: timeoutMs,
        }, (res) => {
          const chunks: Uint8Array[] = [];
          res.on("data", (chunk: Uint8Array) => chunks.push(chunk));
          res.on(
            "error",
            () => fail(new Error("Powerwall response interrupted")),
          );
          res.on(
            "aborted",
            () => fail(new Error("Powerwall response interrupted")),
          );
          res.on("end", () => {
            if (state.settled) return;
            cleanup();
            resolve({
              status: res.statusCode ?? 0,
              body: new TextDecoder().decode(concat(chunks)),
              setCookies: res.headers["set-cookie"] ?? [],
              ...(res.headers["retry-after"]
                ? { retryAfter: res.headers["retry-after"] }
                : {}),
            });
          });
        });
        const cleanup = () => {
          state.settled = true;
          clearTimeout(deadline);
          signal?.removeEventListener("abort", abort);
        };
        const fail = (error: Error) => {
          if (state.settled) return;
          cleanup();
          req.destroy(error);
          reject(
            new PowerwallGatewayConnectionError(
              `Powerwall request to https://${host}${path} failed: ${error.message}`,
              error,
            ),
          );
        };
        const abort = () => fail(new Error("Powerwall request cancelled"));
        // Wall-clock deadline also bounds DNS, socket queueing and trickling bodies.
        const deadline = setTimeout(
          () => fail(new Error(`timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        req.on(
          "timeout",
          () => fail(new Error(`timed out after ${timeoutMs}ms`)),
        );
        req.on("error", fail);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) {
          abort();
          return;
        }
        if (body) req.write(body);
        req.end();
      });
    },
  };
};

export interface PowerwallGatewayApi {
  readonly host: string;
  getJson(path: string, signal?: AbortSignal): Promise<unknown>;
  getStatus(): Promise<unknown>;
  clearSession(): void;
}

type JsonRecord = Record<string, unknown>;

const parseRecord = (body: string, context: string): JsonRecord => {
  try {
    const value: unknown = JSON.parse(body);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as JsonRecord;
    }
    throw new Error("response was not an object");
  } catch {
    throw new PowerwallGatewayConnectionError(
      `${context} returned invalid JSON`,
    );
  }
};

const cookiePair = (setCookies: readonly string[]): string | null =>
  setCookies
    .map((cookie) => cookie.split(";", 1)[0]?.trim() ?? "")
    .find((cookie) => cookie.startsWith("AuthCookie=")) ?? null;

const tokenFrom = (body: JsonRecord): string | null =>
  typeof body.token === "string" && body.token ? body.token : null;

const isSuccessful = (status: number): boolean => status >= 200 && status < 300;
const isUnauthorized = (status: number): boolean =>
  status === 401 || status === 403;

export class PowerwallGatewayClient implements PowerwallGatewayApi {
  private cookie = "";
  private loginInFlight: Promise<string> | null = null;
  private cooldownUntil = 0;

  constructor(
    readonly host: string,
    private readonly email: string,
    private readonly password: string,
    private readonly http: PowerwallHttp = makeNodeHttpsPowerwallHttp(),
  ) {}

  async getJson(path: string, signal?: AbortSignal): Promise<unknown> {
    this.assertAvailable(signal);
    const first = await this.authenticatedRequest(path, signal);
    if (!isUnauthorized(first.status)) return this.parse(path, first);

    this.cookie = "";
    const retry = await this.authenticatedRequest(path, signal);
    if (isUnauthorized(retry.status)) {
      throw new PowerwallGatewayAuthError(
        "Powerwall Gateway rejected the configured customer credentials",
      );
    }
    return this.parse(path, retry);
  }

  async getStatus(): Promise<unknown> {
    this.assertAvailable();
    const response = await this.http.request(
      this.host,
      "/api/status",
      "GET",
      { Accept: "application/json" },
    );
    return this.parse("/api/status", response);
  }

  clearSession(): void {
    this.cookie = "";
    this.http.close?.();
  }

  private assertAvailable(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    const remaining = this.cooldownUntil - Date.now();
    if (remaining > 0) {
      throw new PowerwallGatewayConnectionError(
        "Powerwall Gateway is cooling down after a rate-limit/service response",
        undefined,
        undefined,
        remaining,
      );
    }
  }

  private async authenticatedRequest(
    path: string,
    signal?: AbortSignal,
  ): Promise<PowerwallHttpResponse> {
    this.assertAvailable(signal);
    const cookie = await this.ensureCookie(signal);
    this.assertAvailable(signal);
    return await this.http.request(
      this.host,
      path,
      "GET",
      {
        Accept: "application/json",
        Cookie: cookie,
      },
      undefined,
      signal,
    );
  }

  private async ensureCookie(signal?: AbortSignal): Promise<string> {
    if (this.cookie) return this.cookie;
    if (!this.loginInFlight) this.loginInFlight = this.login(signal);
    try {
      const cookie = await this.loginInFlight;
      this.cookie = cookie;
      return cookie;
    } finally {
      this.loginInFlight = null;
    }
  }

  private async login(signal?: AbortSignal): Promise<string> {
    if (!this.password) {
      throw new PowerwallGatewayAuthError(
        "Powerwall Gateway customer password is not configured",
      );
    }
    const payload = JSON.stringify({
      username: "customer",
      email: this.email,
      password: this.password,
      force_sm_off: false,
    });
    const response = await this.http.request(
      this.host,
      LOGIN_PATH,
      "POST",
      {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      payload,
      signal,
    );
    this.checkCooldown(response);
    if (!isSuccessful(response.status)) {
      throw new PowerwallGatewayAuthError(
        `Powerwall Gateway login failed with HTTP ${response.status}`,
      );
    }
    const parsed = parseRecord(response.body, "Powerwall Gateway login");
    const cookie = cookiePair(response.setCookies);
    const token = tokenFrom(parsed);
    const resolved = cookie ?? (token ? `AuthCookie=${token}` : null);
    if (!resolved) {
      throw new PowerwallGatewayAuthError(
        "Powerwall Gateway login returned no session token",
      );
    }
    return resolved;
  }

  private checkCooldown(response: PowerwallHttpResponse): void {
    if (response.status !== 429 && response.status !== 503) return;
    const raw = response.retryAfter?.trim();
    const seconds = raw && /^\d+$/.test(raw) ? Number(raw) * 1000 : Number.NaN;
    const parsed = raw ? Date.parse(raw) - Date.now() : Number.NaN;
    const requested = Number.isFinite(seconds) ? seconds : parsed;
    const delay = Number.isFinite(requested) && requested > 0
      ? Math.min(requested, 3_600_000)
      : 300_000;
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + delay);
    throw new PowerwallGatewayConnectionError(
      `Powerwall Gateway returned HTTP ${response.status}; cooling down`,
      undefined,
      response.status,
      delay,
    );
  }

  private parse(path: string, response: PowerwallHttpResponse): unknown {
    this.checkCooldown(response);
    if (!isSuccessful(response.status)) {
      throw new PowerwallGatewayConnectionError(
        `Powerwall Gateway ${this.host}${path} returned HTTP ${response.status}`,
        undefined,
        response.status,
      );
    }
    return parseRecord(response.body, `Powerwall Gateway ${path}`);
  }
}
