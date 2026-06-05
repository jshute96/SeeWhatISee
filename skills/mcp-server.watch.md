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

1. Call the `watch` tool with no arguments. It blocks for up to ~60s and returns any new capture records — each as a JSON metadata block plus a `resource_link` per saved file, the same shape as `get_latest`. With nothing new it returns `{ records: [] }`.
2. Process each returned record as described below.
3. Call `watch` again with `after = <last record's timestamp>` to catch up on anything that arrived while you were processing, then block for the next.
4. Continue until the user tells you to stop.

## Process each snapshot

1. [[json-record.template.md]]

2. [[process.template.md]]

3. **Reading the referenced files:** each file is a resource you fetch only when you need it.
  - Read it with `resources/read` on its `uri`, or with your client's native file-read tool at the `file://` path.
  - Or pass `return_inline: true` to `watch` to get the bytes inline — images come back as image content you can view directly; HTML, markdown, and selections come back as embedded file resources.
  - Prefer not to pull large HTML in until you know what you're looking for.
