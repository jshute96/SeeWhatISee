---
name: see-what-i-see-watch
description: Watch for new captures from the SeeWhatISee Chrome extension. Each time a screenshot or HTML snapshot is taken, describe what you see and start watching for the next one.
---
Watch for new captures from the SeeWhatISee Chrome extension. Each time a screenshot or HTML snapshot is taken, describe what you see and start watching for the next one.

## Getting snapshots in a loop

Prefer the subscription path when the client supports it; fall back to polling otherwise.

### Subscription path (preferred)

1. Subscribe to the resource `seewhatisee://captures/stream`.
2. Each `notifications/resources/updated` notification means a new capture arrived. Read the resource to fetch the latest record, then process it as described below.
3. Continue until the user tells you to stop.

### Polling path (fallback)

1. Call the `watch` tool with no arguments. It blocks for up to ~60s and returns `{ records: [...] }`.
2. Process each returned record as described below.
3. Call `watch` again with `after = <last record's timestamp>` to catch up on anything that arrived while you were processing, then block for the next.
4. Continue until the user tells you to stop.

## Process each snapshot

1. [[json-record.template.md]]

2. [[process.template.md]]

3. **Reading the referenced files:** Use your client's native file-read tool when you have one. Otherwise call `read_file` to fetch the bytes. Use `get_file_info` if you want to check size first. Both take the absolute path from the record.
