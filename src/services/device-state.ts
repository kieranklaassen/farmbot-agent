import type { Farmbot } from "farmbot";

/** Typed device state — centralizes the unsafe cast in one place */
export interface DeviceState {
  position: { x: number; y: number; z: number };
  busy: boolean;
  locked: boolean;
  firmware: string;
  controllerVersion: string;
  uptime: number;
  wifi: number | null;
}

function isPosition(v: unknown): v is { x: number; y: number; z: number } {
  return typeof v === "object" && v !== null && "x" in v && "y" in v && "z" in v;
}

/**
 * Read and type-check the FarmBot state tree.
 * farmbot-js exposes getState() but does not export its type, so
 * this is the single place the unsafe cast lives.
 */
export function readDeviceState(bot: Farmbot): DeviceState {
  const state = (bot as unknown as { getState: () => Record<string, unknown> }).getState();

  const pos = state["location_data.position"];

  return {
    position: isPosition(pos) ? pos : { x: 0, y: 0, z: 0 },
    busy: state["informational_settings.busy"] === true,
    locked: state["informational_settings.locked"] === true,
    firmware:
      typeof state["informational_settings.firmware_version"] === "string"
        ? state["informational_settings.firmware_version"]
        : "unknown",
    controllerVersion:
      typeof state["informational_settings.controller_version"] === "string"
        ? state["informational_settings.controller_version"]
        : "unknown",
    uptime: typeof state["informational_settings.uptime"] === "number"
      ? state["informational_settings.uptime"]
      : 0,
    wifi: typeof state["informational_settings.wifi_level"] === "number"
      ? state["informational_settings.wifi_level"]
      : null,
  };
}
