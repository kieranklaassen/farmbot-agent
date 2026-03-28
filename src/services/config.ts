import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = join(homedir(), ".farmbot-agent");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

interface StoredConfig {
  token: string;
  server: string;
}

/** Save auth token to disk with restricted permissions (0o600) */
export function saveToken(token: string, server: string): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const data: StoredConfig = { token, server };
  writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/** Load token: FARMBOT_TOKEN env var takes priority over config file */
export function loadToken(): string | null {
  const envToken = process.env["FARMBOT_TOKEN"];
  if (envToken) return envToken;

  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const config = JSON.parse(raw) as StoredConfig;
    return config.token ?? null;
  } catch {
    return null;
  }
}

/** Load server URL from config, default to https://my.farm.bot */
export function loadServer(): string {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const config = JSON.parse(raw) as StoredConfig;
    return config.server ?? "https://my.farm.bot";
  } catch {
    return "https://my.farm.bot";
  }
}

/** Delete stored config (logout) */
export function clearConfig(): void {
  try {
    writeFileSync(CONFIG_PATH, "{}", { mode: 0o600 });
  } catch {
    // ignore if file doesn't exist
  }
}
