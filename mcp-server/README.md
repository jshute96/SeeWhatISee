# @see-what-i-see/mcp-server

MCP server that exposes captures from the [SeeWhatISee Chrome extension](https://chromewebstore.google.com/detail/seewhatisee/mdfeigicgahogllcdiibkeidfllhddae) to any MCP-aware client.

[SeeWhatISee](https://github.com/jshute96/SeeWhatISee) lets you screenshot a browser tab, capture its HTML, or grab a text selection, optionally annotate, and save the result for an AI coding agent. This server makes those captures available to MCP clients (Claude Desktop, Claude Code, Cursor, Zed, Continue, etc.) without having to install per-client skill wrappers.

## Install

Add the server to your MCP client's config. The package ships as a single bundled Node script with no runtime dependencies — `npx` downloads it on first use.

### Claude Desktop / Cursor / Zed (JSON config)

```json
{
  "mcpServers": {
    "seewhatisee": {
      "command": "npx",
      "args": ["-y", "@see-what-i-see/mcp-server"]
    }
  }
}
```

Claude Desktop's config lives at:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

### Claude Code

```bash
claude mcp add seewhatisee npx -y @see-what-i-see/mcp-server
```

## What it exposes

### Prompts

- **`see-what-i-see`** — grab the latest capture and describe it, or follow other instructions in the prompt.
- **`see-what-i-see-watch`** — watch for new captures, processing each as it arrives.

Both surface as slash commands in clients that render MCP prompts.

### Tools

- **`get_latest`** — returns the most recent capture record (timestamp, URL, title, plus absolute paths to the screenshot / HTML snapshot / selection file if present).
- **`watch`** — returns new capture records. With `after: <timestamp>`, drains anything newer immediately. Otherwise blocks for up to `timeout_ms` waiting for the next capture (defaults to ~60s, max 10 min).
- **`read_file`** — reads a byte range from a captured file (returns base64 bytes). Use with `offset` / `length` for ranged reads of large HTML.
- **`get_file_info`** — returns `{ size, mimeType, capturedAt }` for a captured file.

`read_file` and `get_file_info` only allow paths inside the configured source directory (lexical + symlink check).

### Resources

- **`seewhatisee://captures/stream`** — subscribable. Read returns the latest record (or `{ record: null }` if no captures yet). Subscribe to receive a `notifications/resources/updated` notification on every new capture. Not all MCP clients support resource subscriptions; the `watch` tool is the polling fallback.

## Source and contributing

The source for this server lives under `mcp-server/` in the main [SeeWhatISee repository](https://github.com/jshute96/SeeWhatISee). Bug reports and PRs go there.

## License

MIT.
