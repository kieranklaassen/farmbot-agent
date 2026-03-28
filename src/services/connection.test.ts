import { describe, it, expect } from "vitest";
import { checkMoveRateLimit } from "./connection.js";

describe("checkMoveRateLimit", () => {
  it("allows moves within the rate limit", () => {
    // Fresh module state — first call should succeed
    const result = checkMoveRateLimit();
    expect(result.ok).toBe(true);
  });

  it("returns RATE_LIMITED after exceeding limit", () => {
    // Call 30 times to fill the window (some may already be used from prior test)
    for (let i = 0; i < 35; i++) {
      checkMoveRateLimit();
    }
    const result = checkMoveRateLimit();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RATE_LIMITED");
      expect(result.error.retryable).toBe(true);
    }
  });
});
