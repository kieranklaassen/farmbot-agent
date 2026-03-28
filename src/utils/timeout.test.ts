import { describe, it, expect } from "vitest";
import { withTimeout } from "./timeout.js";

describe("withTimeout", () => {
  it("resolves when promise completes before timeout", async () => {
    const result = await withTimeout(Promise.resolve(42), 1000, "test");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe(42);
    }
  });

  it("returns DEVICE_TIMEOUT when promise exceeds timeout", async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 5000));
    const result = await withTimeout(slow, 50, "slow operation");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("DEVICE_TIMEOUT");
      expect(result.error.retryable).toBe(true);
      expect(result.error.message).toContain("50ms");
    }
  });

  it("returns MQTT_ERROR when promise rejects with non-timeout error", async () => {
    const failing = Promise.reject(new Error("Connection refused"));
    const result = await withTimeout(failing, 1000, "connect");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MQTT_ERROR");
      expect(result.error.message).toContain("Connection refused");
    }
  });
});
