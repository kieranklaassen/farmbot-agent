#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PersistentConnection, checkMoveRateLimit } from "./services/connection.js";
import { withTimeout } from "./utils/timeout.js";
import type { Farmbot } from "farmbot";
import type { Result } from "./types/result.js";

const DEFAULT_TIMEOUT = 30_000;
const connection = new PersistentConnection();

// ── Helpers ─────────────────────────────────────────────────────────

type ToolResult = {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean | undefined;
};

function mcpError(message: string): ToolResult {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function mcpOk(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }] };
}

/** Extract bot state tree — avoids repeating the cast 6 times */
function getBotState(bot: Farmbot): Record<string, unknown> {
  return getBotState(bot);
}

async function withBot<T>(
  fn: (bot: Farmbot) => Promise<Result<T>>,
): Promise<ToolResult> {
  const connResult = await connection.acquire();
  if (!connResult.ok) {
    return mcpError(`${connResult.error.message}${connResult.error.hint ? ` (${connResult.error.hint})` : ""}`);
  }

  const result = await fn(connResult.data);
  if (!result.ok) {
    return mcpError(`[${result.error.code}] ${result.error.message}${result.error.hint ? `. ${result.error.hint}` : ""}`);
  }

  if (typeof result.data === "string") {
    return mcpOk(result.data);
  }
  return mcpOk(JSON.stringify(result.data, null, 2));
}

// ── MCP Server Setup ────────────────────────────────────────────────

const server = new McpServer(
  { name: "farmbot-agent", version: "0.1.0" },
  { capabilities: { logging: {} } },
);

// ── Tools ───────────────────────────────────────────────────────────

server.tool(
  "farmbot_status",
  `Get the current FarmBot device status including position, state, and firmware version.

Returns position (x, y, z in mm), whether the device is busy or e-stopped,
and the firmware version. Use this to check device state before issuing commands.`,
  {},
  async () => {
    return withBot(async (bot) => {
      await withTimeout(bot.readStatus(), DEFAULT_TIMEOUT, "Read status");
      const state = getBotState(bot);
      const pos = state["location_data.position"] as { x: number; y: number; z: number } | undefined;
      const busy = state["informational_settings.busy"] as boolean | undefined;
      const firmware = state["informational_settings.firmware_version"] as string | undefined;
      const locked = state["informational_settings.locked"] as boolean | undefined;

      return {
        ok: true as const,
        data: {
          position: pos ?? { x: 0, y: 0, z: 0 },
          busy: busy ?? false,
          locked: locked ?? false,
          firmware: firmware ?? "unknown",
        },
      };
    });
  },
);

server.tool(
  "farmbot_get_position",
  `Get just the current X, Y, Z position of the FarmBot gantry in millimeters.

Lighter than farmbot_status — use when you only need coordinates.
X runs along the bed length, Y across the width, Z is height (0 = top, negative = into soil).`,
  {},
  async () => {
    return withBot(async (bot) => {
      await withTimeout(bot.readStatus(), DEFAULT_TIMEOUT, "Read position");
      const state = getBotState(bot);
      const pos = state["location_data.position"] as { x: number; y: number; z: number } | undefined;
      return { ok: true as const, data: pos ?? { x: 0, y: 0, z: 0 } };
    });
  },
);

server.tool(
  "farmbot_move",
  `Move the FarmBot gantry to a position in the garden.

Coordinates are in millimeters from the home position (0,0,0).
- X: along the length of the bed (0 to ~3000mm for standard, ~6000mm for XL)
- Y: across the width of the bed (0 to ~1500mm for standard, ~3000mm for XL)
- Z: height (0 = top, negative = into soil, e.g. -50 for planting depth)

Set relative=true to move relative to current position instead of absolute.
Returns the target position after movement completes.`,
  {
    x: z.number().describe("X coordinate in mm"),
    y: z.number().describe("Y coordinate in mm"),
    z: z.number().describe("Z coordinate in mm (negative = into soil)"),
    speed: z.number().min(1).max(100).optional().describe("Speed percentage 1-100 (default: 100)"),
    relative: z.boolean().optional().describe("Move relative to current position"),
  },
  async ({ x, y, z: zPos, speed, relative }) => {
    const rateCheck = checkMoveRateLimit();
    if (!rateCheck.ok) {
      return mcpError(`[${rateCheck.error.code}] ${rateCheck.error.message}`);
    }

    return withBot(async (bot) => {
      const moveSpeed = speed ?? 100;
      const result = relative
        ? await withTimeout(bot.moveRelative({ x, y, z: zPos, speed: moveSpeed }), DEFAULT_TIMEOUT, "Move relative")
        : await withTimeout(bot.moveAbsolute({ x, y, z: zPos, speed: moveSpeed }), DEFAULT_TIMEOUT, "Move absolute");

      if (!result.ok) return result;
      return {
        ok: true as const,
        data: { moved: relative ? "relative" : "absolute", position: { x, y, z: zPos }, speed: moveSpeed },
      };
    });
  },
);

server.tool(
  "farmbot_home",
  `Move FarmBot to the home position (0, 0, 0) or home a specific axis.

Homes using the device's configured home-finding method (encoders or endstops).
After homing, the position is reset to 0 on the homed axis.`,
  {
    axis: z.enum(["x", "y", "z", "all"]).optional().describe("Axis to home (default: all)"),
    speed: z.number().min(1).max(100).optional().describe("Speed percentage 1-100 (default: 100)"),
  },
  async ({ axis, speed }) => {
    const rateCheck = checkMoveRateLimit();
    if (!rateCheck.ok) {
      return mcpError(`[${rateCheck.error.code}] ${rateCheck.error.message}`);
    }

    return withBot(async (bot) => {
      const homeAxis = axis ?? "all";
      const result = await withTimeout(
        bot.home({ axis: homeAxis, speed: speed ?? 100 }),
        DEFAULT_TIMEOUT,
        `Home ${homeAxis}`,
      );
      if (!result.ok) return result;
      return { ok: true as const, data: { homed: homeAxis } };
    });
  },
);

server.tool(
  "farmbot_emergency_stop",
  `EMERGENCY STOP — immediately halt all FarmBot movement and lock the device.

Use when something is going wrong — a collision, unexpected behavior, or safety concern.
The device will be locked until farmbot_unlock is called.
This is the highest priority command and should always be available.`,
  {},
  async () => {
    return withBot(async (bot) => {
      const result = await withTimeout(bot.emergencyLock(), 10_000, "Emergency stop");
      if (!result.ok) return result;
      return { ok: true as const, data: "Emergency stop activated. Device is locked. Call farmbot_unlock to resume." };
    });
  },
);

server.tool(
  "farmbot_unlock",
  `Unlock the FarmBot device after an emergency stop.

After calling farmbot_emergency_stop, the device is locked and will not respond
to movement commands. Call this to unlock and resume normal operation.`,
  {},
  async () => {
    return withBot(async (bot) => {
      const result = await withTimeout(bot.emergencyUnlock(), DEFAULT_TIMEOUT, "Unlock");
      if (!result.ok) return result;
      return { ok: true as const, data: "Device unlocked. Ready for commands." };
    });
  },
);

server.tool(
  "farmbot_get_device_info",
  `Get device configuration and identification info.

Returns the device name, firmware version, and other configuration details.
Useful for understanding the FarmBot model and capabilities.`,
  {},
  async () => {
    return withBot(async (bot) => {
      await withTimeout(bot.readStatus(), DEFAULT_TIMEOUT, "Read device info");
      const state = getBotState(bot);

      return {
        ok: true as const,
        data: {
          name: state["informational_settings.controller_version"] ?? "unknown",
          firmware: state["informational_settings.firmware_version"] ?? "unknown",
          busy: state["informational_settings.busy"] ?? false,
          locked: state["informational_settings.locked"] ?? false,
          uptime: state["informational_settings.uptime"] ?? 0,
          wifi: state["informational_settings.wifi_level"] ?? null,
        },
      };
    });
  },
);

server.tool(
  "farmbot_lua",
  `Execute Lua code directly on the FarmBot device.

This is an escape hatch for advanced operations not covered by other tools.
The FarmBot Lua runtime includes functions for movement, pins, photos, and more.

Example: move{x=100, y=200, z=0}
Example: water(plant_id)
Example: take_photo()

WARNING: This executes arbitrary code on the device. Use with caution.`,
  {
    code: z.string().describe("Lua code to execute on the FarmBot device"),
  },
  async ({ code }) => {
    return withBot(async (bot) => {
      const result = await withTimeout(bot.lua(code), DEFAULT_TIMEOUT, "Lua execution");
      if (!result.ok) return result;
      return { ok: true as const, data: result.data };
    });
  },
);

// ── Resources ───────────────────────────────────────────────────────

server.resource(
  "device-status",
  "farmbot://device/status",
  { description: "Current FarmBot device status: position, firmware, connectivity", mimeType: "application/json" },
  async (uri) => {
    const connResult = await connection.acquire();
    if (!connResult.ok) {
      return { contents: [{ uri: uri.href, text: JSON.stringify({ error: connResult.error.message }) }] };
    }

    await withTimeout(connResult.data.readStatus(), DEFAULT_TIMEOUT, "Read status");
    const state = getBotState(connResult.data);

    return {
      contents: [{
        uri: uri.href,
        text: JSON.stringify({
          position: state["location_data.position"] ?? { x: 0, y: 0, z: 0 },
          busy: state["informational_settings.busy"] ?? false,
          locked: state["informational_settings.locked"] ?? false,
          firmware: state["informational_settings.firmware_version"] ?? "unknown",
        }, null, 2),
      }],
    };
  },
);

// ── Start Server ────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[farmbot-agent] MCP server running on stdio");
}

main().catch((err) => {
  console.error("[farmbot-agent] Fatal:", err);
  process.exit(1);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.error("[farmbot-agent] Shutting down...");
  await connection.release();
  process.exit(0);
});
