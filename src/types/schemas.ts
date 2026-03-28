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

/** Pin write parameters */
export const PinWriteSchema = z.object({
  pin: z.number().describe("Pin number on the Arduino/Farmduino board"),
  value: z.number().describe("Pin value (0 or 1 for digital, 0-255 for analog)"),
  mode: z
    .enum(["digital", "analog"])
    .optional()
    .describe("Pin mode (default: digital)"),
});
export type PinWriteParams = z.infer<typeof PinWriteSchema>;

/** Pin read parameters */
export const PinReadSchema = z.object({
  pin: z.number().describe("Pin number to read"),
  mode: z
    .enum(["digital", "analog"])
    .optional()
    .describe("Pin mode (default: digital)"),
});
export type PinReadParams = z.infer<typeof PinReadSchema>;

/** Pin toggle parameters */
export const PinToggleSchema = z.object({
  pin: z.number().describe("Pin number to toggle"),
});
export type PinToggleParams = z.infer<typeof PinToggleSchema>;

/** Calibrate parameters */
export const CalibrateSchema = z.object({
  axis: z.enum(["x", "y", "z"]).describe("Axis to calibrate"),
});
export type CalibrateParams = z.infer<typeof CalibrateSchema>;

/** Find home parameters */
export const FindHomeSchema = z.object({
  axis: z
    .enum(["x", "y", "z", "all"])
    .optional()
    .describe("Axis to find home on (default: all)"),
  speed: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .describe("Speed percentage 1-100 (default: 100)"),
});
export type FindHomeParams = z.infer<typeof FindHomeSchema>;

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

/** Add plant parameters */
export const AddPlantParamsSchema = z.object({
  name: z.string().describe("Plant name (e.g. 'Tomato', 'Basil')"),
  x: z.number().describe("X coordinate in mm"),
  y: z.number().describe("Y coordinate in mm"),
  z: z.number().optional().default(0).describe("Z coordinate in mm (default: 0)"),
  radius: z.number().optional().default(25).describe("Plant radius in mm (default: 25)"),
  openfarm_slug: z.string().optional().describe("OpenFarm crop slug for plant info"),
});
export type AddPlantParams = z.infer<typeof AddPlantParamsSchema>;

/** Remove resource by ID */
export const ResourceByIdSchema = z.object({
  id: z.number().describe("Resource ID"),
});
export type ResourceById = z.infer<typeof ResourceByIdSchema>;

/** Run sequence parameters */
export const RunSequenceParamsSchema = z.object({
  id: z.number().describe("Sequence ID to execute"),
});
export type RunSequenceParams = z.infer<typeof RunSequenceParamsSchema>;

/** Add farm event parameters */
export const AddFarmEventParamsSchema = z.object({
  sequence_id: z.number().describe("ID of the sequence to run"),
  start_time: z.string().describe("Start time in ISO 8601 format (e.g. '2026-04-01T06:00:00.000Z')"),
  repeat: z
    .enum(["minutely", "hourly", "daily", "weekly", "monthly", "yearly", "never"])
    .optional()
    .default("never")
    .describe("Repeat interval (default: never)"),
  end_time: z.string().optional().describe("End time in ISO 8601 format (required if repeat is not 'never')"),
});
export type AddFarmEventParams = z.infer<typeof AddFarmEventParamsSchema>;

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
