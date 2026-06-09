[[record-common.template.md]]

  Each present artifact also comes as its own `resource_link` block (its `name` is the role: `screenshot` / `contents` / `selection`). That block carries the file's `uri` (a `file://` location) and `mimeType`. A small `selection` also arrives inline, so you don't need to fetch it separately. (When you read the `captures/stream` resource instead of calling a tool, there are no separate blocks, so each artifact carries its `uri` and `mimeType` directly.)

  **Look at referenced files only. Don't go fishing for others unless asked to.**
