# farmbot-agent

TypeScript CLI + MCP server for FarmBot hardware control.

## Architecture

- **Two entry points:** `src/cli.ts` (Commander) and `src/mcp.ts` (McpServer via stdio)
- **No controller layer** — CLI commands and MCP tools call services directly
- **ConnectionManager** handles MQTT lifecycle:
  - `EphemeralConnection` (CLI): connect, run one command, force-close, exit
  - `PersistentConnection` (MCP): lazy-connect, reuse across tool calls, reconnect on disconnect
- **Shared Zod schemas** in `src/types/schemas.ts` — single source of truth for CLI args and MCP tool input

## Key Constraints

- ESM only (`"type": "module"`)
- Strict TypeScript: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
- Every function returns `Result<T>`, never throws
- Every MQTT command wrapped in `withTimeout()` — farmbot-js has no built-in timeouts
- farmbot-js has no `disconnect()` — use `bot.client!.end(true)` to force-close

## Commands

| CLI | MCP Tool | Description |
|-----|----------|-------------|
| `farmbot login` | N/A (env var) | Authenticate and store token |
| `farmbot status` | `farmbot_status` | Device position, state, firmware |
| `farmbot move` | `farmbot_move` | Move to position (absolute/relative) |
| `farmbot home` | `farmbot_home` | Go to home position |
| `farmbot e-stop` | `farmbot_emergency_stop` | Emergency stop |
| `farmbot unlock` | `farmbot_unlock` | Unlock after e-stop |
| `farmbot lua` | `farmbot_lua` | Execute Lua on device |
| | `farmbot_get_position` | Get current position only |
| | `farmbot_get_device_info` | Get device config info |

## Testing

```bash
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run build     # tsup
```

Mock at the `ConnectionManager` boundary, not at MQTT level.

## Adding a New Command

1. Add Zod schema to `src/types/schemas.ts`
2. Add CLI command to `src/cli.ts`
3. Add MCP tool to `src/mcp.ts` — MUST have parity with CLI
4. Add tool annotations (`readOnlyHint`, `destructiveHint`)
5. Wrap MQTT calls in `withTimeout()`
6. Add test

## Auth

- `FARMBOT_TOKEN` env var (preferred for MCP/CI)
- `~/.farmbot-agent/config.json` (CLI login)
- Token is a JWT from `POST /api/tokens` containing MQTT broker credentials
