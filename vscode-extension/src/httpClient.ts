import * as http from "http";
import * as https from "https";
import { URL } from "url";

export interface HttpResult {
  status: number;
  body: any;
}

/* client HTTP minimal (module natif http/https, pas de dependance npm en
   plus) — miroir de ledger_core.py::http_call. */
export function httpCall(
  method: string,
  url: string,
  apiKey: string,
  body?: unknown,
  timeoutMs: number = 15000
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;
    const data = body !== undefined ? JSON.stringify(body) : undefined;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
    };
    if (data !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(data).toString();
    }

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          let parsedBody: any = {};
          if (raw) {
            try {
              parsedBody = JSON.parse(raw);
            } catch (e) {
              parsedBody = { raw };
            }
          }
          resolve({ status: res.statusCode || 0, body: parsedBody });
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error(`timeout apres ${timeoutMs}ms`));
    });
    req.on("error", (e) => reject(e));

    if (data !== undefined) req.write(data);
    req.end();
  });
}
