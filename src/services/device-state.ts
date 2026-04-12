import type { Farmbot } from "farmbot";

/** Typed device state */
export interface DeviceState {
  position: { x: number; y: number; z: number };
  busy: boolean;
  locked: boolean;
  firmware: string;
  controllerVersion: string;
  uptime: number;
  wifi: number | null;
}

type StatusTree = {
  location_data?: { position?: { x?: number; y?: number; z?: number } };
  informational_settings?: {
    busy?: boolean;
    locked?: boolean;
    firmware_version?: string;
    controller_version?: string;
    uptime?: number;
    wifi_level?: number;
  };
};

const statusCache = new WeakMap<Farmbot, StatusTree>();

/**
 * Subscribe a bot to cache status updates. Safe to call multiple times —
 * only attaches the listener once per bot.
 */
export function attachStatusCache(bot: Farmbot): void {
  if (statusCache.has(bot)) return;
  statusCache.set(bot, {});
  bot.on("status", (status: unknown) => {
    if (status && typeof status === "object") {
      statusCache.set(bot, status as StatusTree);
    }
  });
}

async function ensureStatus(bot: Farmbot): Promise<StatusTree> {
  const cached = statusCache.get(bot);
  if (cached && cached.informational_settings) return cached;

  return new Promise<StatusTree>((resolve) => {
    const timer = setTimeout(() => resolve(statusCache.get(bot) ?? {}), 3000);
    const handler = (status: unknown) => {
      clearTimeout(timer);
      if (status && typeof status === "object") {
        statusCache.set(bot, status as StatusTree);
        resolve(status as StatusTree);
      } else {
        resolve({});
      }
    };
    bot.on("status", handler);
    bot.readStatus().catch(() => {});
  });
}

export async function readDeviceState(bot: Farmbot): Promise<DeviceState> {
  const state = await ensureStatus(bot);
  const pos = state.location_data?.position ?? {};
  const info = state.informational_settings ?? {};

  return {
    position: {
      x: typeof pos.x === "number" ? pos.x : 0,
      y: typeof pos.y === "number" ? pos.y : 0,
      z: typeof pos.z === "number" ? pos.z : 0,
    },
    busy: info.busy === true,
    locked: info.locked === true,
    firmware: typeof info.firmware_version === "string" ? info.firmware_version : "unknown",
    controllerVersion:
      typeof info.controller_version === "string" ? info.controller_version : "unknown",
    uptime: typeof info.uptime === "number" ? info.uptime : 0,
    wifi: typeof info.wifi_level === "number" ? info.wifi_level : null,
  };
}
