import { z } from "zod";

/** Move command parameters — shared by CLI and MCP tool */
export const MoveParamsSchema = z.object({
  x: z.number().describe("X coordinate in mm (0 = home, positive = along bed length)"),
  y: z.number().describe("Y coordinate in mm (0 = home, positive = across bed width)"),
  z: z.number().describe("Z coordinate in mm (0 = top, negative = into soil)"),
  speed: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .describe("Speed percentage 1-100 (default: 100)"),
  relative: z
    .boolean()
    .optional()
    .describe("If true, move relative to current position instead of absolute"),
});
export type MoveParams = z.infer<typeof MoveParamsSchema>;

/** Home command parameters */
export const HomeParamsSchema = z.object({
  axis: z
    .enum(["x", "y", "z", "all"])
    .optional()
    .describe("Axis to home (default: all)"),
  speed: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .describe("Speed percentage 1-100 (default: 100)"),
});
export type HomeParams = z.infer<typeof HomeParamsSchema>;

/** Lua execution parameters */
export const LuaParamsSchema = z.object({
  code: z.string().describe("Lua code to execute on the FarmBot device"),
});
export type LuaParams = z.infer<typeof LuaParamsSchema>;

/** Login parameters */
export const LoginParamsSchema = z.object({
  email: z.string().email().describe("FarmBot account email"),
  password: z.string().min(1).describe("FarmBot account password"),
  server: z
    .string()
    .url()
    .optional()
    .describe("FarmBot server URL (default: https://my.farm.bot)"),
});
export type LoginParams = z.infer<typeof LoginParamsSchema>;

/** JSON output envelope */
export interface OutputEnvelope<T = unknown> {
  ok: boolean;
  command: string;
  data?: T | undefined;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    hint?: string | undefined;
  } | undefined;
}
