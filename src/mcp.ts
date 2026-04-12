#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PersistentConnection, checkMoveRateLimit } from "./services/connection.js";
import { withTimeout } from "./utils/timeout.js";
import { readDeviceState } from "./services/device-state.js";
import {
  MoveParamsSchema,
  HomeParamsSchema,
  LuaParamsSchema,
  PinWriteSchema,
  PinReadSchema,
  PinToggleSchema,
  FindHomeSchema,
  CalibrateSchema,
  AddPlantParamsSchema,
  ResourceByIdSchema,
  RunSequenceParamsSchema,
  AddFarmEventParamsSchema,
} from "./types/schemas.js";
import { apiGet, apiPost, apiDelete } from "./services/api.js";
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
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => {
    return withBot(async (bot) => {
      await withTimeout(bot.readStatus(), DEFAULT_TIMEOUT, "Read status");
      return { ok: true as const, data: await readDeviceState(bot) };
    });
  },
);

server.tool(
  "farmbot_get_position",
  `Get just the current X, Y, Z position of the FarmBot gantry in millimeters.

Lighter than farmbot_status — use when you only need coordinates.
X runs along the bed length, Y across the width, Z is height (0 = top, negative = into soil).`,
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => {
    return withBot(async (bot) => {
      await withTimeout(bot.readStatus(), DEFAULT_TIMEOUT, "Read position");
      return { ok: true as const, data: (await readDeviceState(bot)).position };
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
  MoveParamsSchema.shape,
  { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ x, y, z, speed, relative }) => {
    const rateCheck = checkMoveRateLimit();
    if (!rateCheck.ok) {
      return mcpError(`[${rateCheck.error.code}] ${rateCheck.error.message}`);
    }

    return withBot(async (bot) => {
      const moveSpeed = speed ?? 100;
      const result = relative
        ? await withTimeout(bot.moveRelative({ x, y, z, speed: moveSpeed }), DEFAULT_TIMEOUT, "Move relative")
        : await withTimeout(bot.moveAbsolute({ x, y, z, speed: moveSpeed }), DEFAULT_TIMEOUT, "Move absolute");

      if (!result.ok) return result;
      return {
        ok: true as const,
        data: { moved: relative ? "relative" : "absolute", position: { x, y, z }, speed: moveSpeed },
      };
    });
  },
);

server.tool(
  "farmbot_home",
  `Move FarmBot to the home position (0, 0, 0) or home a specific axis.

Homes using the device's configured home-finding method (encoders or endstops).
After homing, the position is reset to 0 on the homed axis.`,
  HomeParamsSchema.shape,
  { destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
  { destructiveHint: true, idempotentHint: true, openWorldHint: false },
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
  { destructiveHint: false, idempotentHint: true, openWorldHint: false },
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

Returns the controller version, firmware version, uptime, and wifi signal.
Useful for understanding the FarmBot model and capabilities.`,
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => {
    return withBot(async (bot) => {
      await withTimeout(bot.readStatus(), DEFAULT_TIMEOUT, "Read device info");
      const ds = await readDeviceState(bot);
      return {
        ok: true as const,
        data: {
          controllerVersion: ds.controllerVersion,
          firmware: ds.firmware,
          busy: ds.busy,
          locked: ds.locked,
          uptime: ds.uptime,
          wifi: ds.wifi,
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
  LuaParamsSchema.shape,
  { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async ({ code }) => {
    return withBot(async (bot) => {
      const result = await withTimeout(bot.lua(code), DEFAULT_TIMEOUT, "Lua execution");
      if (!result.ok) return result;
      return { ok: true as const, data: result.data };
    });
  },
);

// ── Pin/GPIO Tools ────────────────────────────────────────────────

server.tool(
  "farmbot_write_pin",
  `Write a value to a GPIO pin on the FarmBot.

Sets a pin to a specific value. Use digital mode (0 or 1) for on/off control
of peripherals like the water valve or vacuum pump. Use analog mode (0-255)
for variable output like LED brightness.`,
  PinWriteSchema.shape,
  { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ pin, value, mode }) => {
    return withBot(async (bot) => {
      const pinMode = mode === "analog" ? 1 : 0;
      const result = await withTimeout(
        bot.writePin({ pin_number: pin, pin_value: value, pin_mode: pinMode }),
        DEFAULT_TIMEOUT,
        `Write pin ${pin}`,
      );
      if (!result.ok) return result;
      return { ok: true as const, data: { pin, value, mode: mode ?? "digital" } };
    });
  },
);

server.tool(
  "farmbot_read_pin",
  `Read the current value of a GPIO pin on the FarmBot.

Returns the pin value. Digital mode returns 0 or 1, analog mode returns 0-255.
Use this to check sensor readings or peripheral states.`,
  PinReadSchema.shape,
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ pin, mode }) => {
    return withBot(async (bot) => {
      const pinMode = mode === "analog" ? 1 : 0;
      const result = await withTimeout(
        bot.readPin({ pin_number: pin, pin_mode: pinMode, label: `pin_${pin}` }),
        DEFAULT_TIMEOUT,
        `Read pin ${pin}`,
      );
      if (!result.ok) return result;
      return { ok: true as const, data: result.data };
    });
  },
);

server.tool(
  "farmbot_toggle_pin",
  `Toggle a GPIO pin between on (1) and off (0).

Flips the current digital state of the pin. If the pin is on, it turns off, and vice versa.
Useful for quickly switching peripherals like lights or the water valve.`,
  PinToggleSchema.shape,
  { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async ({ pin }) => {
    return withBot(async (bot) => {
      const result = await withTimeout(
        bot.togglePin({ pin_number: pin }),
        DEFAULT_TIMEOUT,
        `Toggle pin ${pin}`,
      );
      if (!result.ok) return result;
      return { ok: true as const, data: { pin, toggled: true } };
    });
  },
);

// ── Camera ────────────────────────────────────────────────────────

server.tool(
  "farmbot_take_photo",
  `Take a photo with the FarmBot camera.

Triggers the onboard camera to capture an image. The photo is saved to the
FarmBot web app and can be viewed in the photos panel.
Use this for plant monitoring, weed detection, or garden documentation.`,
  {},
  { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async () => {
    return withBot(async (bot) => {
      const result = await withTimeout(bot.takePhoto(), DEFAULT_TIMEOUT, "Take photo");
      if (!result.ok) return result;
      return { ok: true as const, data: "Photo captured." };
    });
  },
);

// ── Calibration ───────────────────────────────────────────────────

server.tool(
  "farmbot_find_home",
  `Find the home position using encoders or endstops.

Moves the specified axis (or all axes) until it hits an endstop or stall-detection
triggers, then sets that position as 0. This is more thorough than farmbot_home
which simply moves to the stored 0 position.`,
  FindHomeSchema.shape,
  { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ axis, speed }) => {
    const rateCheck = checkMoveRateLimit();
    if (!rateCheck.ok) {
      return mcpError(`[${rateCheck.error.code}] ${rateCheck.error.message}`);
    }

    return withBot(async (bot) => {
      const findAxis = axis ?? "all";
      const result = await withTimeout(
        bot.findHome({ axis: findAxis, speed: speed ?? 100 }),
        DEFAULT_TIMEOUT,
        `Find home ${findAxis}`,
      );
      if (!result.ok) return result;
      return { ok: true as const, data: { foundHome: findAxis } };
    });
  },
);

server.tool(
  "farmbot_calibrate",
  `Calibrate an axis by finding its total length.

Moves the axis to both endpoints to determine the full range of motion.
After calibration, the axis length is stored in device settings.
This involves movement — the axis will travel its full range.`,
  CalibrateSchema.shape,
  { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ axis }) => {
    const rateCheck = checkMoveRateLimit();
    if (!rateCheck.ok) {
      return mcpError(`[${rateCheck.error.code}] ${rateCheck.error.message}`);
    }

    return withBot(async (bot) => {
      const result = await withTimeout(
        bot.calibrate({ axis }),
        DEFAULT_TIMEOUT,
        `Calibrate ${axis}`,
      );
      if (!result.ok) return result;
      return { ok: true as const, data: { calibrated: axis } };
    });
  },
);

// ── System ────────────────────────────────────────────────────────

server.tool(
  "farmbot_sync",
  `Sync the FarmBot device with the web application.

Triggers the device to download the latest data from the FarmBot web app,
including sequences, farm events, and device settings. Run this after making
changes via the REST API to ensure the device has the latest configuration.`,
  {},
  { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => {
    return withBot(async (bot) => {
      const result = await withTimeout(bot.sync(), DEFAULT_TIMEOUT, "Sync");
      if (!result.ok) return result;
      return { ok: true as const, data: "Device synced." };
    });
  },
);

server.tool(
  "farmbot_reboot",
  `Reboot the FarmBot device.

Restarts the FarmBot OS. The device will be offline for 1-2 minutes during reboot.
Use this to recover from stuck states or apply firmware updates.
The MQTT connection will be lost and must be re-established after reboot.`,
  {},
  { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async () => {
    return withBot(async (bot) => {
      const result = await withTimeout(bot.reboot(), DEFAULT_TIMEOUT, "Reboot");
      if (!result.ok) return result;
      return { ok: true as const, data: "Reboot initiated." };
    });
  },
);

// ── REST API Tools ─────────────────────────────────────────────────

/** Helper for REST-only tools (no MQTT connection needed) */
async function restResult<T>(result: Result<T>): Promise<ToolResult> {
  if (!result.ok) {
    return mcpError(`[${result.error.code}] ${result.error.message}${result.error.hint ? `. ${result.error.hint}` : ""}`);
  }
  if (typeof result.data === "string") {
    return mcpOk(result.data);
  }
  return mcpOk(JSON.stringify(result.data, null, 2));
}

// Plants

server.tool(
  "farmbot_list_plants",
  `List all plants in the FarmBot garden.

Returns an array of plant points with their names, positions, and OpenFarm slugs.
Use this to understand the current garden layout before planning operations.`,
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => restResult(await apiGet("points?filter=Plant")),
);

server.tool(
  "farmbot_add_plant",
  `Add a new plant to the FarmBot garden.

Creates a plant point at the specified coordinates. Coordinates are in millimeters.
Optionally provide an OpenFarm slug for crop-specific information (spacing, height, etc.).`,
  AddPlantParamsSchema.shape,
  { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async ({ name, x, y, z, radius, openfarm_slug }) => {
    const body = {
      pointer_type: "Plant",
      name,
      x,
      y,
      z: z ?? 0,
      radius: radius ?? 25,
      openfarm_slug: openfarm_slug ?? "",
    };
    return restResult(await apiPost("points", body));
  },
);

server.tool(
  "farmbot_remove_plant",
  `Remove a plant from the FarmBot garden by its ID.

Permanently deletes the plant point. Use farmbot_list_plants first to find the ID.`,
  ResourceByIdSchema.shape,
  { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async ({ id }) => {
    const result = await apiDelete(`points/${id}`);
    if (result.ok) return mcpOk(`Plant ${id} removed.`);
    return restResult(result);
  },
);

// Sequences

server.tool(
  "farmbot_list_sequences",
  `List all saved sequences on the FarmBot.

Returns sequence names, IDs, and metadata. Use the ID with farmbot_run_sequence to execute one.`,
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => restResult(await apiGet("sequences")),
);

server.tool(
  "farmbot_run_sequence",
  `Execute a saved sequence on the FarmBot device via MQTT.

Runs the sequence identified by ID. The sequence must already exist on the device.
Use farmbot_list_sequences to find available sequence IDs.
This command blocks until the sequence completes or times out.`,
  RunSequenceParamsSchema.shape,
  { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async ({ id }) => {
    return withBot(async (bot) => {
      const result = await withTimeout(bot.execSequence(id), DEFAULT_TIMEOUT, `Run sequence ${id}`);
      if (!result.ok) return result;
      return { ok: true as const, data: { sequenceId: id, status: "completed" } };
    });
  },
);

// Tools

server.tool(
  "farmbot_list_tools",
  `List all tools configured on the FarmBot.

Returns tool names, IDs, and slot assignments. Tools include items like the seeder,
watering nozzle, weeder, and soil sensor.`,
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => restResult(await apiGet("tools")),
);

// Peripherals

server.tool(
  "farmbot_list_peripherals",
  `List all peripherals configured on the FarmBot.

Returns peripheral names, IDs, pin numbers, and modes. Peripherals include
the water valve, vacuum pump, lighting, and other connected hardware.`,
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => restResult(await apiGet("peripherals")),
);

// Sensors

server.tool(
  "farmbot_list_sensors",
  `List all sensors configured on the FarmBot.

Returns sensor names, IDs, pin numbers, and modes. Sensors include
the soil moisture sensor, tool verification sensor, and other inputs.`,
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => restResult(await apiGet("sensors")),
);

// Farm Events

server.tool(
  "farmbot_list_farm_events",
  `List all scheduled farm events.

Returns event configurations including the executable (sequence/regimen),
schedule, start/end times, and repeat intervals.`,
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => restResult(await apiGet("farm_events")),
);

server.tool(
  "farmbot_add_farm_event",
  `Create a new scheduled farm event.

Schedules a sequence to run at a specific time, optionally repeating on an interval.
Use farmbot_list_sequences first to find the sequence ID.`,
  AddFarmEventParamsSchema.shape,
  { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async ({ sequence_id, start_time, repeat, end_time }) => {
    const body: Record<string, unknown> = {
      executable_id: sequence_id,
      executable_type: "Sequence",
      start_time,
      time_unit: repeat === "never" ? "never" : repeat,
      repeat: repeat === "never" ? 0 : 1,
    };
    if (end_time) {
      body["end_time"] = end_time;
    }
    return restResult(await apiPost("farm_events", body));
  },
);

server.tool(
  "farmbot_remove_farm_event",
  `Remove a scheduled farm event by its ID.

Permanently deletes the event. Use farmbot_list_farm_events first to find the ID.`,
  ResourceByIdSchema.shape,
  { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async ({ id }) => {
    const result = await apiDelete(`farm_events/${id}`);
    if (result.ok) return mcpOk(`Farm event ${id} removed.`);
    return restResult(result);
  },
);

// Device

server.tool(
  "farmbot_get_device_config",
  `Get the device configuration from the FarmBot REST API.

Returns the full device record including name, timezone, firmware config,
and other settings. This is the REST API device config, not the MQTT live status.`,
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => restResult(await apiGet("device")),
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
    const ds = await readDeviceState(connResult.data);

    return {
      contents: [{
        uri: uri.href,
        text: JSON.stringify(ds, null, 2),
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
async function shutdown() {
  console.error("[farmbot-agent] Shutting down...");
  await connection.release();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
