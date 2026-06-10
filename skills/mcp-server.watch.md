---
name: see-what-i-see-watch
description: Watch for new captures from the SeeWhatISee Chrome extension. Each time a screenshot or HTML snapshot is taken, describe what you see and start watching for the next one.
---
Watch for new captures from the SeeWhatISee Chrome extension. Each time a screenshot or HTML snapshot is taken, describe what you see and start watching for the next one.

This runs through the **`see-what-i-see` MCP server**, which exposes the extension's captures as MCP tools (`watch`) and the `seewhatisee://captures/stream` resource. The steps below use those — your client must have that MCP server configured.

## Getting snapshots in a loop

Prefer the subscription path when the client supports it; fall back to polling otherwise.

### Subscription path (preferred)

1. Subscribe to the resource `seewhatisee://captures/stream`. Then read it once (bare, no query) to get an initial timestamp cursor: remember the `timestamp` of the latest record (or use an empty string if there are none yet).
2. Each `notifications/resources/updated` notification means at least one new capture arrived. Read `seewhatisee://captures/stream?after=<timestamp>` to read **all records** newer than that timestamp — it returns `{ records: [...] }` in order. Process each, then remember the last record's `timestamp` as the new cursor.
3. Continue until the user tells you to stop.

### Polling path (fallback)

1. Call the `watch` tool with no arguments. It blocks for up to ~60s and returns any new capture records — each as a JSON metadata block plus a `resource_link` per saved file, the same shape as `get_latest`. With nothing new it returns `{ records: [] }`.
2. Process each returned record as described below.
3. Call `watch` again with `after = <last record's timestamp>` to catch up on anything that arrived while you were processing, then block for the next.
4. Continue until the user tells you to stop.

## Process each snapshot

1. [[mcp-record.template.md]]

2. [[process.template.md]]

3. **Reading the referenced files:** each file is a resource you fetch only when you need it. Read it with `resources/read` on the `uri` from its `resource_link`, or with your client's native file-read tool at the `file://` path.
