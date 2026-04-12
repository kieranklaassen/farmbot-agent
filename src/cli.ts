#!/usr/bin/env node

import { Command } from "commander";
import type { Farmbot } from "farmbot";
import { z } from "zod";
import { EphemeralConnection, checkMoveRateLimit } from "./services/connection.js";
import { saveToken, clearConfig } from "./services/config.js";
import { withTimeout } from "./utils/timeout.js";
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
  AddFarmEventParamsSchema,
} from "./types/schemas.js";
import { apiGet, apiPost, apiDelete } from "./services/api.js";
import { readDeviceState } from "./services/device-state.js";
import type { AppError, Result } from "./types/result.js";
import type { OutputEnvelope } from "./types/schemas.js";

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_SERVER = "https://my.farm.bot";

// ── Output helpers ──────────────────────────────────────────────────

function formatOutput<T>(
  command: string,
  result: Result<T>,
  json: boolean,
): void {
  if (json) {
    const envelope: OutputEnvelope<T> = result.ok
      ? { ok: true, command, data: result.data }
      : {
          ok: false,
          command,
          error: {
            code: result.error.code,
            message: result.error.message,
            retryable: result.error.retryable,
            hint: result.error.hint,
          },
        };
    console.log(JSON.stringify(envelope, null, 2));
  } else if (result.ok) {
    if (typeof result.data === "string") {
      console.log(result.data);
    } else {
      console.log(JSON.stringify(result.data, null, 2));
    }
  } else {
    printError(result.error);
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

function printError(error: AppError): void {
  console.error(`Error [${error.code}]: ${error.message}`);
  if (error.hint) {
    console.error(`Hint: ${error.hint}`);
  }
}

// ── Run a command with connection lifecycle ──────────────────────────

async function withConnection<T>(
  command: string,
  json: boolean,
  fn: (bot: Farmbot) => Promise<Result<T>>,
): Promise<void> {
  const conn = new EphemeralConnection();
  const connResult = await conn.acquire();
  if (!connResult.ok) {
    formatOutput(command, connResult, json);
    return;
  }

  try {
    const result = await fn(connResult.data);
    formatOutput(command, result, json);
  } finally {
    await conn.release();
  }
}

// ── CLI Setup ───────────────────────────────────────────────────────

const program = new Command()
  .name("farmbot")
  .description("Agent-native CLI for controlling FarmBot hardware")
  .version("0.1.0")
  .option("-j, --json", "Output as structured JSON", false)
  .option("-t, --timeout <ms>", "Command timeout in milliseconds", String(DEFAULT_TIMEOUT));

function getOpts(): { json: boolean; timeout: number } {
  const opts = program.opts<{ json: boolean; timeout: string }>();
  return { json: opts.json, timeout: parseInt(opts.timeout, 10) || DEFAULT_TIMEOUT };
}

// ── Commands ────────────────────────────────────────────────────────

program
  .command("login")
  .description("Authenticate with FarmBot and store token")
  .requiredOption("--email <email>", "FarmBot account email")
  .requiredOption("--password <password>", "FarmBot account password")
  .option("--server <url>", "FarmBot server URL", DEFAULT_SERVER)
  .action(async (opts: { email: string; password: string; server: string }) => {
    const { json } = getOpts();
    try {
      const response = await fetch(`${opts.server}/api/tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user: { email: opts.email, password: opts.password },
        }),
      });

      if (!response.ok) {
        formatOutput(
          "login",
          {
            ok: false,
            error: {
              code: "AUTH_MISSING" as const,
              message: `Authentication failed: ${response.status} ${response.statusText}`,
              retryable: false,
              hint: "Check your email and password",
            },
          },
          json,
        );
        return;
      }

      const TokenResponseSchema = z.object({
        token: z.object({
          encoded: z.string(),
          unencoded: z.object({ bot: z.string() }),
        }),
      });

      const parsed = TokenResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        formatOutput(
          "login",
          {
            ok: false,
            error: {
              code: "API_ERROR" as const,
              message: "Unexpected API response format",
              retryable: false,
              hint: "The FarmBot API may have changed. Try updating farmbot-agent.",
            },
          },
          json,
        );
        return;
      }

      const data = parsed.data;
      saveToken(data.token.encoded, opts.server);

      formatOutput(
        "login",
        {
          ok: true,
          data: `Authenticated as ${opts.email} (${data.token.unencoded.bot}). Token saved.`,
        },
        json,
      );
    } catch (err) {
      formatOutput(
        "login",
        {
          ok: false,
          error: {
            code: "API_ERROR" as const,
            message: err instanceof Error ? err.message : "Login failed",
            retryable: true,
            hint: `Check your network connection and server URL (${opts.server})`,
          },
        },
        json,
      );
    }
  });

program
  .command("logout")
  .description("Remove stored FarmBot token")
  .action(() => {
    const { json } = getOpts();
    clearConfig();
    formatOutput("logout", { ok: true, data: "Token removed." }, json);
  });

program
  .command("status")
  .description("Show FarmBot device status: position, state, firmware")
  .action(async () => {
    const { json, timeout } = getOpts();
    await withConnection("status", json, async (bot) => {
      const statusResult = await withTimeout(bot.readStatus(), timeout, "Read device status");
      if (!statusResult.ok) return statusResult;

      const ds = await readDeviceState(bot);

      if (!json) {
        console.log(`Position: x=${ds.position.x} y=${ds.position.y} z=${ds.position.z}`);
        console.log(`State: ${ds.locked ? "e-stopped" : ds.busy ? "busy" : "idle"}`);
        console.log(`Firmware: ${ds.firmware}`);
      }

      return { ok: true as const, data: ds };
    });
  });

program
  .command("position")
  .description("Get current FarmBot gantry position (x, y, z in mm)")
  .action(async () => {
    const { json, timeout } = getOpts();
    await withConnection("position", json, async (bot) => {
      const statusResult = await withTimeout(bot.readStatus(), timeout, "Read position");
      if (!statusResult.ok) return statusResult;
      return { ok: true as const, data: (await readDeviceState(bot)).position };
    });
  });

program
  .command("device-info")
  .description("Get device configuration: firmware, uptime, wifi")
  .action(async () => {
    const { json, timeout } = getOpts();
    await withConnection("device-info", json, async (bot) => {
      const statusResult = await withTimeout(bot.readStatus(), timeout, "Read device info");
      if (!statusResult.ok) return statusResult;
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
  });

program
  .command("move")
  .description("Move FarmBot to a position (coordinates in mm)")
  .requiredOption("--x <mm>", "X coordinate")
  .requiredOption("--y <mm>", "Y coordinate")
  .requiredOption("--z <mm>", "Z coordinate")
  .option("-s, --speed <percent>", "Speed 1-100")
  .option("--relative", "Move relative to current position")
  .action(async (opts: { x: string; y: string; z: string; speed?: string; relative?: boolean }) => {
    const { json, timeout } = getOpts();

    const rateCheck = checkMoveRateLimit();
    if (!rateCheck.ok) {
      formatOutput("move", rateCheck, json);
      return;
    }

    const params = MoveParamsSchema.safeParse({
      x: parseFloat(opts.x),
      y: parseFloat(opts.y),
      z: parseFloat(opts.z),
      speed: opts.speed ? parseInt(opts.speed, 10) : undefined,
      relative: opts.relative,
    });

    if (!params.success) {
      formatOutput(
        "move",
        {
          ok: false,
          error: {
            code: "POSITION_OUT_OF_BOUNDS" as const,
            message: `Invalid parameters: ${params.error.issues.map((i) => i.message).join(", ")}`,
            retryable: false,
          },
        },
        json,
      );
      return;
    }

    await withConnection("move", json, async (bot) => {
      const { x, y, z, speed, relative } = params.data;
      const moveSpeed = speed ?? 100;

      const result = relative
        ? await withTimeout(bot.moveRelative({ x, y, z, speed: moveSpeed }), timeout, "Move relative")
        : await withTimeout(bot.moveAbsolute({ x, y, z, speed: moveSpeed }), timeout, "Move absolute");

      if (!result.ok) return result;
      return {
        ok: true as const,
        data: { moved: relative ? "relative" : "absolute", position: { x, y, z }, speed: moveSpeed },
      };
    });
  });

program
  .command("home")
  .description("Move FarmBot to home position (0, 0, 0)")
  .option("--axis <axis>", "Specific axis: x, y, z, or all", "all")
  .option("-s, --speed <percent>", "Speed 1-100", "100")
  .action(async (opts: { axis: string; speed: string }) => {
    const { json, timeout } = getOpts();

    const rateCheck = checkMoveRateLimit();
    if (!rateCheck.ok) {
      formatOutput("home", rateCheck, json);
      return;
    }

    const params = HomeParamsSchema.safeParse({
      axis: opts.axis,
      speed: parseInt(opts.speed, 10),
    });

    if (!params.success) {
      formatOutput(
        "home",
        {
          ok: false,
          error: {
            code: "POSITION_OUT_OF_BOUNDS" as const,
            message: `Invalid parameters: ${params.error.issues.map((i) => i.message).join(", ")}`,
            retryable: false,
          },
        },
        json,
      );
      return;
    }

    await withConnection("home", json, async (bot) => {
      const { axis, speed } = params.data;
      const homeAxis = axis ?? "all";
      const result = await withTimeout(
        bot.home({ axis: homeAxis, speed: speed ?? 100 }),
        timeout,
        `Home ${homeAxis}`,
      );
      if (!result.ok) return result;
      return { ok: true as const, data: { homed: homeAxis } };
    });
  });

program
  .command("e-stop")
  .alias("estop")
  .description("Emergency stop — immediately halt all FarmBot movement")
  .action(async () => {
    const { json, timeout } = getOpts();
    await withConnection("e-stop", json, async (bot) => {
      const result = await withTimeout(bot.emergencyLock(), Math.min(timeout, 10_000), "Emergency stop");
      if (!result.ok) return result;
      return { ok: true as const, data: "Emergency stop activated. Run 'farmbot unlock' to resume." };
    });
  });

program
  .command("unlock")
  .description("Unlock FarmBot after an emergency stop")
  .action(async () => {
    const { json, timeout } = getOpts();
    await withConnection("unlock", json, async (bot) => {
      const result = await withTimeout(bot.emergencyUnlock(), timeout, "Unlock");
      if (!result.ok) return result;
      return { ok: true as const, data: "Device unlocked. Ready for commands." };
    });
  });

program
  .command("lua")
  .description("Execute Lua code on the FarmBot device")
  .argument("<code>", "Lua code to execute")
  .action(async (code: string) => {
    const { json, timeout } = getOpts();

    const params = LuaParamsSchema.safeParse({ code });
    if (!params.success) {
      formatOutput(
        "lua",
        {
          ok: false,
          error: {
            code: "LUA_ERROR" as const,
            message: "Invalid Lua code parameter",
            retryable: false,
          },
        },
        json,
      );
      return;
    }

    await withConnection("lua", json, async (bot) => {
      const result = await withTimeout(bot.lua(params.data.code), timeout, "Lua execution");
      if (!result.ok) return result;
      return { ok: true as const, data: result.data };
    });
  });

// ── Pin/GPIO Commands ──────────────────────────────────────────────

const pinCmd = program
  .command("pin")
  .description("Read, write, or toggle GPIO pins");

pinCmd
  .command("write")
  .description("Write a value to a GPIO pin")
  .requiredOption("--pin <number>", "Pin number")
  .requiredOption("--value <number>", "Pin value (0/1 digital, 0-255 analog)")
  .option("--mode <mode>", "Pin mode: digital or analog", "digital")
  .action(async (opts: { pin: string; value: string; mode: string }) => {
    const { json, timeout } = getOpts();

    const params = PinWriteSchema.safeParse({
      pin: parseInt(opts.pin, 10),
      value: parseInt(opts.value, 10),
      mode: opts.mode,
    });

    if (!params.success) {
      formatOutput(
        "pin write",
        {
          ok: false,
          error: {
            code: "API_ERROR" as const,
            message: `Invalid parameters: ${params.error.issues.map((i) => i.message).join(", ")}`,
            retryable: false,
          },
        },
        json,
      );
      return;
    }

    await withConnection("pin write", json, async (bot) => {
      const pinMode = params.data.mode === "analog" ? 1 : 0;
      const result = await withTimeout(
        bot.writePin({ pin_number: params.data.pin, pin_value: params.data.value, pin_mode: pinMode }),
        timeout,
        `Write pin ${params.data.pin}`,
      );
      if (!result.ok) return result;
      return {
        ok: true as const,
        data: { pin: params.data.pin, value: params.data.value, mode: params.data.mode ?? "digital" },
      };
    });
  });

pinCmd
  .command("read")
  .description("Read the value of a GPIO pin")
  .requiredOption("--pin <number>", "Pin number")
  .option("--mode <mode>", "Pin mode: digital or analog", "digital")
  .action(async (opts: { pin: string; mode: string }) => {
    const { json, timeout } = getOpts();

    const params = PinReadSchema.safeParse({
      pin: parseInt(opts.pin, 10),
      mode: opts.mode,
    });

    if (!params.success) {
      formatOutput(
        "pin read",
        {
          ok: false,
          error: {
            code: "API_ERROR" as const,
            message: `Invalid parameters: ${params.error.issues.map((i) => i.message).join(", ")}`,
            retryable: false,
          },
        },
        json,
      );
      return;
    }

    await withConnection("pin read", json, async (bot) => {
      const pinMode = params.data.mode === "analog" ? 1 : 0;
      const result = await withTimeout(
        bot.readPin({ pin_number: params.data.pin, pin_mode: pinMode, label: `pin_${params.data.pin}` }),
        timeout,
        `Read pin ${params.data.pin}`,
      );
      if (!result.ok) return result;
      return { ok: true as const, data: result.data };
    });
  });

pinCmd
  .command("toggle")
  .description("Toggle a GPIO pin between on and off")
  .requiredOption("--pin <number>", "Pin number")
  .action(async (opts: { pin: string }) => {
    const { json, timeout } = getOpts();

    const params = PinToggleSchema.safeParse({
      pin: parseInt(opts.pin, 10),
    });

    if (!params.success) {
      formatOutput(
        "pin toggle",
        {
          ok: false,
          error: {
            code: "API_ERROR" as const,
            message: `Invalid parameters: ${params.error.issues.map((i) => i.message).join(", ")}`,
            retryable: false,
          },
        },
        json,
      );
      return;
    }

    await withConnection("pin toggle", json, async (bot) => {
      const result = await withTimeout(
        bot.togglePin({ pin_number: params.data.pin }),
        timeout,
        `Toggle pin ${params.data.pin}`,
      );
      if (!result.ok) return result;
      return { ok: true as const, data: { pin: params.data.pin, toggled: true } };
    });
  });

// ── Camera ────────────────────────────────────────────────────────

program
  .command("photo")
  .description("Take a photo with the FarmBot camera")
  .action(async () => {
    const { json, timeout } = getOpts();
    await withConnection("photo", json, async (bot) => {
      const result = await withTimeout(bot.takePhoto(), timeout, "Take photo");
      if (!result.ok) return result;
      return { ok: true as const, data: "Photo captured." };
    });
  });

// ── Calibration ───────────────────────────────────────────────────

program
  .command("find-home")
  .description("Find home position using encoders or endstops")
  .option("--axis <axis>", "Axis: x, y, z, or all", "all")
  .option("-s, --speed <percent>", "Speed 1-100", "100")
  .action(async (opts: { axis: string; speed: string }) => {
    const { json, timeout } = getOpts();

    const rateCheck = checkMoveRateLimit();
    if (!rateCheck.ok) {
      formatOutput("find-home", rateCheck, json);
      return;
    }

    const params = FindHomeSchema.safeParse({
      axis: opts.axis,
      speed: parseInt(opts.speed, 10),
    });

    if (!params.success) {
      formatOutput(
        "find-home",
        {
          ok: false,
          error: {
            code: "POSITION_OUT_OF_BOUNDS" as const,
            message: `Invalid parameters: ${params.error.issues.map((i) => i.message).join(", ")}`,
            retryable: false,
          },
        },
        json,
      );
      return;
    }

    await withConnection("find-home", json, async (bot) => {
      const findAxis = params.data.axis ?? "all";
      const result = await withTimeout(
        bot.findHome({ axis: findAxis, speed: params.data.speed ?? 100 }),
        timeout,
        `Find home ${findAxis}`,
      );
      if (!result.ok) return result;
      return { ok: true as const, data: { foundHome: findAxis } };
    });
  });

program
  .command("calibrate")
  .description("Calibrate an axis by finding its length")
  .requiredOption("--axis <axis>", "Axis to calibrate: x, y, or z")
  .action(async (opts: { axis: string }) => {
    const { json, timeout } = getOpts();

    const rateCheck = checkMoveRateLimit();
    if (!rateCheck.ok) {
      formatOutput("calibrate", rateCheck, json);
      return;
    }

    const params = CalibrateSchema.safeParse({ axis: opts.axis });

    if (!params.success) {
      formatOutput(
        "calibrate",
        {
          ok: false,
          error: {
            code: "POSITION_OUT_OF_BOUNDS" as const,
            message: `Invalid parameters: ${params.error.issues.map((i) => i.message).join(", ")}`,
            retryable: false,
          },
        },
        json,
      );
      return;
    }

    await withConnection("calibrate", json, async (bot) => {
      const result = await withTimeout(
        bot.calibrate({ axis: params.data.axis }),
        timeout,
        `Calibrate ${params.data.axis}`,
      );
      if (!result.ok) return result;
      return { ok: true as const, data: { calibrated: params.data.axis } };
    });
  });

// ── System ────────────────────────────────────────────────────────

program
  .command("sync")
  .description("Sync device with the FarmBot web app")
  .action(async () => {
    const { json, timeout } = getOpts();
    await withConnection("sync", json, async (bot) => {
      const result = await withTimeout(bot.sync(), timeout, "Sync");
      if (!result.ok) return result;
      return { ok: true as const, data: "Device synced." };
    });
  });

program
  .command("reboot")
  .description("Reboot the FarmBot device")
  .action(async () => {
    const { json, timeout } = getOpts();
    await withConnection("reboot", json, async (bot) => {
      const result = await withTimeout(bot.reboot(), timeout, "Reboot");
      if (!result.ok) return result;
      return { ok: true as const, data: "Reboot initiated." };
    });
  });

// ── REST API Commands ──────────────────────────────────────────────

// Plants
const plantCmd = program
  .command("plants")
  .description("List all plants in the garden")
  .action(async () => {
    const { json } = getOpts();
    const result = await apiGet<unknown[]>("points?filter=Plant");
    formatOutput("plants", result, json);
  });

program
  .command("plant")
  .description("Manage individual plants")
  .command("add")
  .description("Add a new plant to the garden")
  .requiredOption("--name <name>", "Plant name")
  .requiredOption("--x <mm>", "X coordinate")
  .requiredOption("--y <mm>", "Y coordinate")
  .option("--z <mm>", "Z coordinate", "0")
  .option("--radius <mm>", "Plant radius", "25")
  .option("--openfarm-slug <slug>", "OpenFarm crop slug")
  .action(
    async (opts: {
      name: string;
      x: string;
      y: string;
      z: string;
      radius: string;
      openfarmSlug?: string;
    }) => {
      const { json } = getOpts();

      const params = AddPlantParamsSchema.safeParse({
        name: opts.name,
        x: parseFloat(opts.x),
        y: parseFloat(opts.y),
        z: parseFloat(opts.z),
        radius: parseFloat(opts.radius),
        openfarm_slug: opts.openfarmSlug,
      });

      if (!params.success) {
        formatOutput(
          "plant add",
          {
            ok: false,
            error: {
              code: "API_ERROR" as const,
              message: `Invalid parameters: ${params.error.issues.map((i) => i.message).join(", ")}`,
              retryable: false,
            },
          },
          json,
        );
        return;
      }

      const body = {
        pointer_type: "Plant",
        name: params.data.name,
        x: params.data.x,
        y: params.data.y,
        z: params.data.z,
        radius: params.data.radius,
        openfarm_slug: params.data.openfarm_slug ?? "",
      };

      const result = await apiPost("points", body);
      formatOutput("plant add", result, json);
    },
  );

program
  .command("plant-remove")
  .description("Remove a plant by ID")
  .argument("<id>", "Plant ID to remove")
  .action(async (id: string) => {
    const { json } = getOpts();
    const plantId = parseInt(id, 10);
    if (isNaN(plantId)) {
      formatOutput(
        "plant remove",
        {
          ok: false,
          error: {
            code: "API_ERROR" as const,
            message: "Invalid plant ID — must be a number",
            retryable: false,
          },
        },
        json,
      );
      return;
    }
    const result = await apiDelete(`points/${plantId}`);
    if (result.ok) {
      formatOutput("plant remove", { ok: true as const, data: `Plant ${plantId} removed.` }, json);
    } else {
      formatOutput("plant remove", result, json);
    }
  });

// Sequences
program
  .command("sequences")
  .description("List all sequences")
  .action(async () => {
    const { json } = getOpts();
    const result = await apiGet<unknown[]>("sequences");
    formatOutput("sequences", result, json);
  });

program
  .command("sequence-run")
  .description("Run a sequence by ID (via MQTT)")
  .argument("<id>", "Sequence ID to run")
  .action(async (id: string) => {
    const { json, timeout } = getOpts();
    const seqId = parseInt(id, 10);
    if (isNaN(seqId)) {
      formatOutput(
        "sequence run",
        {
          ok: false,
          error: {
            code: "API_ERROR" as const,
            message: "Invalid sequence ID — must be a number",
            retryable: false,
          },
        },
        json,
      );
      return;
    }
    await withConnection("sequence run", json, async (bot) => {
      const result = await withTimeout(bot.execSequence(seqId), timeout, `Run sequence ${seqId}`);
      if (!result.ok) return result;
      return { ok: true as const, data: { sequenceId: seqId, status: "completed" } };
    });
  });

// Tools
program
  .command("tools")
  .description("List all tools")
  .action(async () => {
    const { json } = getOpts();
    const result = await apiGet<unknown[]>("tools");
    formatOutput("tools", result, json);
  });

// Peripherals
program
  .command("peripherals")
  .description("List all peripherals")
  .action(async () => {
    const { json } = getOpts();
    const result = await apiGet<unknown[]>("peripherals");
    formatOutput("peripherals", result, json);
  });

// Sensors
program
  .command("sensors")
  .description("List all sensors")
  .action(async () => {
    const { json } = getOpts();
    const result = await apiGet<unknown[]>("sensors");
    formatOutput("sensors", result, json);
  });

// Farm Events
program
  .command("events")
  .description("List all farm events")
  .action(async () => {
    const { json } = getOpts();
    const result = await apiGet<unknown[]>("farm_events");
    formatOutput("events", result, json);
  });

program
  .command("event-add")
  .description("Create a new farm event")
  .requiredOption("--sequence-id <id>", "Sequence ID to run")
  .requiredOption("--start <datetime>", "Start time in ISO 8601 format")
  .option("--repeat <interval>", "Repeat: minutely, hourly, daily, weekly, monthly, yearly, never", "never")
  .option("--end <datetime>", "End time in ISO 8601 format")
  .action(
    async (opts: {
      sequenceId: string;
      start: string;
      repeat: string;
      end?: string;
    }) => {
      const { json } = getOpts();

      const params = AddFarmEventParamsSchema.safeParse({
        sequence_id: parseInt(opts.sequenceId, 10),
        start_time: opts.start,
        repeat: opts.repeat,
        end_time: opts.end,
      });

      if (!params.success) {
        formatOutput(
          "event add",
          {
            ok: false,
            error: {
              code: "API_ERROR" as const,
              message: `Invalid parameters: ${params.error.issues.map((i) => i.message).join(", ")}`,
              retryable: false,
            },
          },
          json,
        );
        return;
      }

      const body: Record<string, unknown> = {
        executable_id: params.data.sequence_id,
        executable_type: "Sequence",
        start_time: params.data.start_time,
        time_unit: params.data.repeat === "never" ? "never" : params.data.repeat,
        repeat: params.data.repeat === "never" ? 0 : 1,
      };

      if (params.data.end_time) {
        body["end_time"] = params.data.end_time;
      }

      const result = await apiPost("farm_events", body);
      formatOutput("event add", result, json);
    },
  );

program
  .command("event-remove")
  .description("Remove a farm event by ID")
  .argument("<id>", "Farm event ID to remove")
  .action(async (id: string) => {
    const { json } = getOpts();
    const eventId = parseInt(id, 10);
    if (isNaN(eventId)) {
      formatOutput(
        "event remove",
        {
          ok: false,
          error: {
            code: "API_ERROR" as const,
            message: "Invalid event ID — must be a number",
            retryable: false,
          },
        },
        json,
      );
      return;
    }
    const result = await apiDelete(`farm_events/${eventId}`);
    if (result.ok) {
      formatOutput("event remove", { ok: true as const, data: `Farm event ${eventId} removed.` }, json);
    } else {
      formatOutput("event remove", result, json);
    }
  });

// Device (REST API)
program
  .command("device")
  .description("Show device configuration from the REST API")
  .action(async () => {
    const { json } = getOpts();
    const result = await apiGet<unknown>("device");
    formatOutput("device", result, json);
  });

program.parse();
