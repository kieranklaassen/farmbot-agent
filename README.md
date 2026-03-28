# farmbot-agent

Agent-native CLI and MCP server for [FarmBot](https://farm.bot) hardware control.

Control your FarmBot from the terminal or let AI agents manage your garden through the [Model Context Protocol](https://modelcontextprotocol.io).

## Install

```bash
npm install -g farmbot-agent
```

## Quick Start (CLI)

```bash
# Authenticate
farmbot login --email you@example.com --password yourpassword

# Check status
farmbot status

# Move the gantry
farmbot move --x 100 --y 200 --z 0

# Go home
farmbot home

# Emergency stop
farmbot e-stop

# Unlock after e-stop
farmbot unlock

# Execute Lua on device
farmbot lua 'toast("Hello from the CLI!")'
```

All commands support `--json` for structured output and `--timeout <ms>` (default: 30s).

## Quick Start (MCP Server)

### Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "farmbot": {
      "command": "npx",
      "args": ["-y", "farmbot-agent", "mcp"],
      "env": {
        "FARMBOT_TOKEN": "your-jwt-token-here"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add farmbot -- npx -y farmbot-agent mcp
```

### Environment Variable Auth

For MCP mode, set `FARMBOT_TOKEN` as an environment variable. Get your token:

```bash
curl -s -X POST https://my.farm.bot/api/tokens \
  -H "Content-Type: application/json" \
  -d '{"user":{"email":"you@example.com","password":"yourpassword"}}' \
  | jq -r '.token.encoded'
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `farmbot_status` | Device status: position, state, firmware |
| `farmbot_get_position` | Current X, Y, Z position (lightweight) |
| `farmbot_get_device_info` | Device config and identification |
| `farmbot_move` | Move gantry to absolute or relative position |
| `farmbot_home` | Home one or all axes |
| `farmbot_emergency_stop` | Immediately halt all movement |
| `farmbot_unlock` | Unlock after emergency stop |
| `farmbot_lua` | Execute Lua code on the device |

## MCP Resources

| URI | Description |
|-----|-------------|
| `farmbot://device/status` | Current device state as JSON |

## CLI Commands

| Command | Description |
|---------|-------------|
| `farmbot login` | Authenticate and store token |
| `farmbot logout` | Remove stored token |
| `farmbot status` | Show device status |
| `farmbot move` | Move to position (`--x`, `--y`, `--z`, `--speed`, `--relative`) |
| `farmbot home` | Go home (`--axis`, `--speed`) |
| `farmbot e-stop` | Emergency stop |
| `farmbot unlock` | Unlock after e-stop |
| `farmbot lua <code>` | Execute Lua on device |

## How It Works

```
farmbot-agent
├── CLI (Commander)      → Human-friendly terminal commands
├── MCP Server (stdio)   → AI agent tool interface
└── Shared Services      → farmbot-js (MQTT) + FarmBot REST API
```

FarmBot communication uses MQTT over the `farmbot` npm package. Commands are sent as CeleryScript RPC requests and responses are matched by UUID. The JWT token contains MQTT broker credentials.

## Safety

- **Coordinate bounds validation** on all movement commands
- **Rate limiting**: max 30 move commands per minute (prevents runaway agent loops)
- **Emergency stop** is always available with short timeout
- **Structured errors** with codes, retry hints, and recovery suggestions

## Development

```bash
git clone https://github.com/kieranklaassen/farmbot-agent
cd farmbot-agent
npm install
npm run build
npm test
```

## License

MIT
