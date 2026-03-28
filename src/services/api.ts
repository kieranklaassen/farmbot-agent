import { loadToken } from "./config.js";
import { fail, succeed } from "../types/result.js";
import type { Result } from "../types/result.js";

const DEFAULT_SERVER = "https://my.farm.bot";

function getServer(): string {
  return process.env["FARMBOT_SERVER"] ?? DEFAULT_SERVER;
}

function getAuthHeaders(): Result<Record<string, string>> {
  const token = loadToken();
  if (!token) {
    return fail({
      code: "AUTH_MISSING",
      message: "No FarmBot token found",
      retryable: false,
      hint: "Run 'farmbot login' or set FARMBOT_TOKEN environment variable",
    });
  }
  return succeed({
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  });
}

/** Generic GET request to FarmBot REST API */
export async function apiGet<T>(path: string): Promise<Result<T>> {
  const headers = getAuthHeaders();
  if (!headers.ok) return headers;

  try {
    const res = await fetch(`${getServer()}/api/${path}`, { headers: headers.data });
    if (!res.ok) {
      return fail({
        code: "API_ERROR",
        message: `GET /api/${path} failed: ${res.status} ${res.statusText}`,
        retryable: res.status >= 500,
        hint: res.status === 401 ? "Token may be expired. Run 'farmbot login'" : undefined,
      });
    }
    return succeed(await res.json() as T);
  } catch (err) {
    return fail({
      code: "API_ERROR",
      message: err instanceof Error ? err.message : "API request failed",
      retryable: true,
      hint: "Check your network connection",
    });
  }
}

/** Generic POST request to FarmBot REST API */
export async function apiPost<T>(path: string, body: unknown): Promise<Result<T>> {
  const headers = getAuthHeaders();
  if (!headers.ok) return headers;

  try {
    const res = await fetch(`${getServer()}/api/${path}`, {
      method: "POST",
      headers: headers.data,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return fail({
        code: "API_ERROR",
        message: `POST /api/${path} failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`,
        retryable: res.status >= 500,
        hint: res.status === 422 ? "Check required fields" : undefined,
      });
    }
    return succeed(await res.json() as T);
  } catch (err) {
    return fail({
      code: "API_ERROR",
      message: err instanceof Error ? err.message : "API request failed",
      retryable: true,
    });
  }
}

/** Generic PATCH request to FarmBot REST API */
export async function apiPatch<T>(path: string, body: unknown): Promise<Result<T>> {
  const headers = getAuthHeaders();
  if (!headers.ok) return headers;

  try {
    const res = await fetch(`${getServer()}/api/${path}`, {
      method: "PATCH",
      headers: headers.data,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return fail({
        code: "API_ERROR",
        message: `PATCH /api/${path} failed: ${res.status} ${res.statusText}`,
        retryable: res.status >= 500,
      });
    }
    return succeed(await res.json() as T);
  } catch (err) {
    return fail({
      code: "API_ERROR",
      message: err instanceof Error ? err.message : "API request failed",
      retryable: true,
    });
  }
}

/** Generic DELETE request to FarmBot REST API */
export async function apiDelete(path: string): Promise<Result<void>> {
  const headers = getAuthHeaders();
  if (!headers.ok) return headers;

  try {
    const res = await fetch(`${getServer()}/api/${path}`, {
      method: "DELETE",
      headers: headers.data,
    });
    if (!res.ok) {
      return fail({
        code: "API_ERROR",
        message: `DELETE /api/${path} failed: ${res.status} ${res.statusText}`,
        retryable: res.status >= 500,
      });
    }
    return succeed(undefined);
  } catch (err) {
    return fail({
      code: "API_ERROR",
      message: err instanceof Error ? err.message : "API request failed",
      retryable: true,
    });
  }
}
