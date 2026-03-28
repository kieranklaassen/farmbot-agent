import { describe, it, expect } from "vitest";
import { succeed, fail } from "./result.js";

describe("Result helpers", () => {
  it("succeed creates a Success result", () => {
    const result = succeed(42);
    expect(result.ok).toBe(true);
    expect(result.data).toBe(42);
  });

  it("fail creates a Failure result", () => {
    const result = fail({
      code: "DEVICE_TIMEOUT",
      message: "timed out",
      retryable: true,
      hint: "try again",
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("DEVICE_TIMEOUT");
    expect(result.error.retryable).toBe(true);
    expect(result.error.hint).toBe("try again");
  });

  it("succeed works with complex types", () => {
    const result = succeed({ position: { x: 1, y: 2, z: 3 } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.position.x).toBe(1);
    }
  });
});
