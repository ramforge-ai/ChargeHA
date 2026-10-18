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
  ) {
    super(message, { cause });
    this.name = "PowerwallGatewayConnectionError";
  }
}

export interface PowerwallHttpResponse {
  status: number;
  body: string;
  setCookies: readonly string[];
}

export interface PowerwallHttp {
  request(
    host: string,
    path: string,
    method: "GET" | "POST",
    headers: Record<string, string>,
    body?: string,
  ): Promise<PowerwallHttpResponse>;
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
): PowerwallHttp => ({
  request(host, path, method, headers, body) {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: host,
          port: 443,
          path,
          method,
          headers,
          rejectUnauthorized: false,
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Uint8Array[] = [];
          res.on("data", (chunk: Uint8Array) => chunks.push(chunk));
          res.on(
            "error",
            () =>
              reject(
                new PowerwallGatewayConnectionError(
                  "Powerwall response interrupted",
                ),
              ),
          );
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              body: new TextDecoder().decode(concat(chunks)),
              setCookies: res.headers["set-cookie"] ?? [],
            }));
        },
      );
      req.on("timeout", () => {
        req.destroy(new Error(`timed out after ${timeoutMs}ms`));
      });
      req.on("error", (err: Error) =>
        reject(
          new PowerwallGatewayConnectionError(
            `Powerwall request to https://${host}${path} failed: ${err.message}`,
            err,
          ),
        ));
      if (body) req.write(body);
      req.end();
    });
  },
});

export interface PowerwallGatewayApi {
  readonly host: string;
  getJson(path: string): Promise<unknown>;
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

  constructor(
    readonly host: string,
    private readonly email: string,
    private readonly password: string,
    private readonly http: PowerwallHttp = makeNodeHttpsPowerwallHttp(),
  ) {}

  async getJson(path: string): Promise<unknown> {
    const first = await this.authenticatedRequest(path);
    if (!isUnauthorized(first.status)) return this.parse(path, first);

    this.cookie = "";
    const retry = await this.authenticatedRequest(path);
    if (isUnauthorized(retry.status)) {
      throw new PowerwallGatewayAuthError(
        "Powerwall Gateway rejected the configured customer credentials",
      );
    }
    return this.parse(path, retry);
  }

  async getStatus(): Promise<unknown> {
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
  }

  private async authenticatedRequest(
    path: string,
  ): Promise<PowerwallHttpResponse> {
    const cookie = await this.ensureCookie();
    return await this.http.request(this.host, path, "GET", {
      Accept: "application/json",
      Cookie: cookie,
    });
  }

  private async ensureCookie(): Promise<string> {
    if (this.cookie) return this.cookie;
    if (!this.loginInFlight) this.loginInFlight = this.login();
    try {
      const cookie = await this.loginInFlight;
      this.cookie = cookie;
      return cookie;
    } finally {
      this.loginInFlight = null;
    }
  }

  private async login(): Promise<string> {
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
    );
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

  private parse(path: string, response: PowerwallHttpResponse): unknown {
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
