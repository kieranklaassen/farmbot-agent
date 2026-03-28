import { succeed, fail } from "../types/result.js";
import type { Result } from "../types/result.js";

/**
 * Wrap any promise with a timeout. farmbot-js has no built-in timeouts
 * on MQTT RPC commands — if the bot is off, the promise hangs forever.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  context: string,
): Promise<Result<T>> {
  let timer: ReturnType<typeof setTimeout>;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timeout after ${ms}ms: ${context}`)),
      ms,
    );
  });

  try {
    const data = await Promise.race([promise, timeout]);
    clearTimeout(timer!);
    return succeed(data);
  } catch (err) {
    clearTimeout(timer!);
    const message =
      err instanceof Error ? err.message : `${context} failed: unknown error`;

    if (message.includes("Timeout")) {
      return fail({
        code: "DEVICE_TIMEOUT",
        message: `${context} did not respond within ${ms}ms`,
        retryable: true,
        hint: "Check that FarmBot is powered on and connected to WiFi",
      });
    }

    return fail({
      code: "MQTT_ERROR",
      message,
      retryable: true,
      hint: "The device may be busy or temporarily unreachable",
    });
  }
}
