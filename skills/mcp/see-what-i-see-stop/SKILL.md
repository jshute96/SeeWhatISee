---
name: see-what-i-see-stop
description: Stop a running SeeWhatISee watch started by see-what-i-see-watch.
---

Stop a running SeeWhatISee watch started by `see-what-i-see-watch`.

This runs through the **`see-what-i-see` MCP server**, which exposes the extension's captures as MCP tools — your client must have that MCP server configured.

## Steps

1. Call the `stop_watch` tool. It takes no arguments.
2. Relay its `message` to the user. It says what it found and what it did.
3. If you are subscribed to `seewhatisee://captures/stream`, unsubscribe too — the tool ends the watch the extension can see, but your subscription is yours to close.

`stop_watch` stops whichever watch the capture directory publishes, so it also works on a `/see-what-i-see-watch` loop running in another tool.
