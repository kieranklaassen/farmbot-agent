// Public API for programmatic use
export type { Result, Success, Failure, AppError } from "./types/result.js";
export { succeed, fail } from "./types/result.js";
export { MoveParamsSchema, HomeParamsSchema, LuaParamsSchema, LoginParamsSchema } from "./types/schemas.js";
export type { MoveParams, HomeParams, LuaParams, LoginParams, OutputEnvelope } from "./types/schemas.js";
export { EphemeralConnection, PersistentConnection } from "./services/connection.js";
export type { ConnectionManager } from "./services/connection.js";
export { loadToken, saveToken, clearConfig } from "./services/config.js";
export { readDeviceState } from "./services/device-state.js";
export type { DeviceState } from "./services/device-state.js";
export { withTimeout } from "./utils/timeout.js";
