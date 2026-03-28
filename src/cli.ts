#!/usr/bin/env node

import { Command } from "commander";
import type { Farmbot } from "farmbot";
import { EphemeralConnection, checkMoveRateLimit } from "./services/connection.js";

/** Extract bot state tree — avoids repeating the cast */
function getBotState(bot: Farmbot): Record<string, unknown> {
  return (bot as unknown as { getState: () => Record<string, unknown> }).getState();
}
import { saveToken, loadToken, clearConfig } from "./services/config.js";
import { withTimeout } from "./utils/timeout.js";
import { z } from "zod";
import { MoveParamsSchema, LuaParamsSchema } from "./types/schemas.js";
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
  .option("--json", "Output as structured JSON", false)
  .option("--timeout <ms>", "Command timeout in milliseconds", String(DEFAULT_TIMEOUT));

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
    const conn = new EphemeralConnection();
    const connResult = await conn.acquire();
    if (!connResult.ok) {
      formatOutput("status", connResult, json);
      return;
    }

    try {
      const statusResult = await withTimeout(
        connResult.data.readStatus(),
        timeout,
        "Read device status",
      );
      if (!statusResult.ok) {
        formatOutput("status", statusResult, json);
        return;
      }

      const state = getBotState(connResult.data);
      const pos = state["location_data.position"] as { x: number; y: number; z: number } | undefined;
      const busy = state["informational_settings.busy"] as boolean | undefined;
      const firmware = state["informational_settings.firmware_version"] as string | undefined;
      const locked = state["informational_settings.locked"] as boolean | undefined;

      if (json) {
        formatOutput("status", {
          ok: true as const,
          data: {
            position: pos ?? { x: 0, y: 0, z: 0 },
            busy: busy ?? false,
            locked: locked ?? false,
            firmware: firmware ?? "unknown",
          },
        }, json);
      } else {
        console.log(`Position: x=${pos?.x ?? "?"} y=${pos?.y ?? "?"} z=${pos?.z ?? "?"}`);
        console.log(`State: ${locked ? "e-stopped" : busy ? "busy" : "idle"}`);
        console.log(`Firmware: ${firmware ?? "unknown"}`);
      }
    } finally {
      await conn.release();
    }
  });

program
  .command("move")
  .description("Move FarmBot to a position (coordinates in mm)")
  .requiredOption("--x <mm>", "X coordinate")
  .requiredOption("--y <mm>", "Y coordinate")
  .requiredOption("--z <mm>", "Z coordinate")
  .option("--speed <percent>", "Speed 1-100")
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
        ? await withTimeout(
            bot.moveRelative({ x, y, z, speed: moveSpeed }),
            timeout,
            "Move relative",
          )
        : await withTimeout(
            bot.moveAbsolute({ x, y, z, speed: moveSpeed }),
            timeout,
            "Move absolute",
          );

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
  .option("--speed <percent>", "Speed 1-100", "100")
  .action(async (opts: { axis: string; speed: string }) => {
    const { json, timeout } = getOpts();

    const rateCheck = checkMoveRateLimit();
    if (!rateCheck.ok) {
      formatOutput("home", rateCheck, json);
      return;
    }

    await withConnection("home", json, async (bot) => {
      const result = await withTimeout(
        bot.home({ axis: opts.axis as "x" | "y" | "z" | "all", speed: parseInt(opts.speed, 10) }),
        timeout,
        `Home ${opts.axis}`,
      );
      if (!result.ok) return result;
      return { ok: true as const, data: { homed: opts.axis } };
    });
  });

program
  .command("e-stop")
  .description("Emergency stop — immediately halt all FarmBot movement")
  .action(async () => {
    const { json, timeout } = getOpts();
    await withConnection("e-stop", json, async (bot) => {
      // E-stop is the highest priority command — short timeout
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

program.parse();
