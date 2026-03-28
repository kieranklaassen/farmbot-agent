import { Farmbot } from "farmbot";
import { loadToken } from "./config.js";
import { fail, succeed } from "../types/result.js";
import type { Result } from "../types/result.js";

/**
 * ConnectionManager handles the MQTT lifecycle mismatch between
 * CLI (one-shot) and MCP (long-lived) modes.
 *
 * farmbot-js has no disconnect() method. To cleanly exit in CLI mode,
 * we force-close the underlying mqtt.js client socket.
 */

export interface ConnectionManager {
  acquire(): Promise<Result<Farmbot>>;
  release(): Promise<void>;
}

/**
 * EphemeralConnection: for CLI mode.
 * Creates a new connection, used for one command, then force-closed.
 */
export class EphemeralConnection implements ConnectionManager {
  private bot: Farmbot | null = null;

  async acquire(): Promise<Result<Farmbot>> {
    const token = loadToken();
    if (!token) {
      return fail({
        code: "AUTH_MISSING",
        message: "No FarmBot token found",
        retryable: false,
        hint: "Run 'farmbot login' or set FARMBOT_TOKEN environment variable",
      });
    }

    try {
      this.bot = new Farmbot({ token });
      await this.bot.connect();
      return succeed(this.bot);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to connect to FarmBot";
      return fail({
        code: "MQTT_ERROR",
        message,
        retryable: true,
        hint: "Check your token and internet connection",
      });
    }
  }

  async release(): Promise<void> {
    if (this.bot) {
      // farmbot-js has no disconnect() — force-close the mqtt.js socket
      // to prevent auto-reconnect from holding the Node.js event loop open
      const client = (this.bot as unknown as { client?: { end: (force: boolean) => void } }).client;
      if (client) {
        client.end(true);
      }
      this.bot = null;
    }
  }
}

/**
 * PersistentConnection: for MCP mode.
 * Lazy-connects on first tool call, reuses across the session.
 */
export class PersistentConnection implements ConnectionManager {
  private bot: Farmbot | null = null;
  private connecting = false;

  async acquire(): Promise<Result<Farmbot>> {
    if (this.bot) {
      return succeed(this.bot);
    }

    if (this.connecting) {
      return fail({
        code: "DEVICE_BUSY",
        message: "Connection in progress",
        retryable: true,
        hint: "Wait a moment and try again",
      });
    }

    const token = loadToken();
    if (!token) {
      return fail({
        code: "AUTH_MISSING",
        message: "No FarmBot token found",
        retryable: false,
        hint: "Set FARMBOT_TOKEN environment variable before starting the MCP server",
      });
    }

    this.connecting = true;
    try {
      this.bot = new Farmbot({ token });
      await this.bot.connect();
      this.connecting = false;

      // Handle disconnection — clear the instance so next acquire() reconnects
      this.bot.on("offline", () => {
        console.error("[farmbot-agent] Device went offline, will reconnect on next command");
        this.bot = null;
      });

      return succeed(this.bot);
    } catch (err) {
      this.connecting = false;
      const message =
        err instanceof Error ? err.message : "Failed to connect to FarmBot";
      return fail({
        code: "MQTT_ERROR",
        message,
        retryable: true,
        hint: "Check FARMBOT_TOKEN and internet connection",
      });
    }
  }

  async release(): Promise<void> {
    if (this.bot) {
      const client = (this.bot as unknown as { client?: { end: (force: boolean) => void } }).client;
      if (client) {
        client.end(true);
      }
      this.bot = null;
    }
  }
}

/** Rate limiter for movement commands — prevents runaway agent loops */
const MOVE_RATE_LIMIT = 30; // max per minute
let moveCount = 0;
setInterval(() => {
  moveCount = 0;
}, 60_000).unref(); // unref so timer doesn't keep process alive

export function checkMoveRateLimit(): Result<void> {
  if (++moveCount > MOVE_RATE_LIMIT) {
    return fail({
      code: "DEVICE_BUSY",
      message: `Rate limit exceeded: ${MOVE_RATE_LIMIT} moves per minute`,
      retryable: true,
      hint: "Wait before sending more move commands",
    });
  }
  return succeed(undefined);
}
