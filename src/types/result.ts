/** Success case — contains data of type T */
export type Success<T> = { readonly ok: true; readonly data: T };

/** Failure case — contains a structured AppError */
export type Failure = { readonly ok: false; readonly error: AppError };

/** Discriminated union: every function returns Result<T>, never throws */
export type Result<T> = Success<T> | Failure;

export function succeed<T>(data: T): Success<T> {
  return { ok: true, data } as const;
}

export function fail(error: AppError): Failure {
  return { ok: false, error } as const;
}

/**
 * Discriminated union of all error types.
 * Add new codes here — TypeScript will enforce exhaustive handling at every switch.
 */
export type AppError = {
  readonly code:
    | "AUTH_MISSING"
    | "AUTH_EXPIRED"
    | "DEVICE_OFFLINE"
    | "DEVICE_TIMEOUT"
    | "DEVICE_BUSY"
    | "DEVICE_E_STOPPED"
    | "RATE_LIMITED"
    | "POSITION_OUT_OF_BOUNDS"
    | "RESOURCE_NOT_FOUND"
    | "MQTT_ERROR"
    | "API_ERROR"
    | "LUA_ERROR";
  readonly message: string;
  readonly retryable: boolean;
  readonly hint?: string | undefined;
};
