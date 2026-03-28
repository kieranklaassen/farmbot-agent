import { describe, it, expect, afterEach } from "vitest";
import { saveToken, loadToken, clearConfig } from "./config.js";
import { existsSync, unlinkSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_PATH = join(homedir(), ".farmbot-agent", "config.json");

describe("config", () => {
  afterEach(() => {
    // Clean up test config
    delete process.env["FARMBOT_TOKEN"];
  });

  it("FARMBOT_TOKEN env var takes priority over config file", () => {
    process.env["FARMBOT_TOKEN"] = "env-token-123";
    saveToken("file-token-456", "https://my.farm.bot");
    expect(loadToken()).toBe("env-token-123");
  });

  it("returns null when no token is available", () => {
    delete process.env["FARMBOT_TOKEN"];
    clearConfig();
    expect(loadToken()).toBeNull();
  });

  it("saves and loads token from config file", () => {
    delete process.env["FARMBOT_TOKEN"];
    saveToken("test-token-789", "https://test.farm.bot");
    expect(loadToken()).toBe("test-token-789");
  });

  it("sets restrictive file permissions on config", () => {
    saveToken("perm-test", "https://my.farm.bot");
    if (existsSync(CONFIG_PATH)) {
      const stats = statSync(CONFIG_PATH);
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });
});
